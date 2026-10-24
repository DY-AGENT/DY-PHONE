// LLM bridge.
//
// On device, inference runs through the native `GemmaLlm` Capacitor plugin,
// which wraps LiteRT-LM running the Gemma 4 E2B `.litertlm` model (text +
// vision) fully on-device. In a desktop browser (dev), there is no on-device
// model, so we fall back to either a configured OpenAI-compatible endpoint or a
// clearly-labelled mock, so the agent loop and UI stay testable.
//
// The plugin contract (see android-plugin/GemmaLlmPlugin.kt):
//   GemmaLlm.isReady() -> { ready: boolean }
//   GemmaLlm.load({ modelPath }) -> { ok: boolean }
//   GemmaLlm.generate({ messages, images }) -> streams 'token' events, resolves { text }
// where messages = [{ role, content }] and images = [base64Jpeg].

const Cap = () => window.Capacitor;
const nativePlugin = () =>
  Cap() && Cap().isNativePlatform && Cap().isNativePlatform() ? Cap().Plugins?.GemmaLlm : undefined;

// Optional dev endpoint (OpenAI-compatible /chat/completions). Configure in the
// UI settings; persisted to localStorage. Only used when no native model.
function devEndpoint() {
  try {
    return JSON.parse(localStorage.getItem("dyagent.dev.endpoint") || "null");
  } catch {
    return null;
  }
}

export const LLM = {
  backendName: "unknown",

  async status() {
    const gp = nativePlugin();
    if (gp) {
      try {
        const r = await gp.isReady();
        this.backendName = "Gemma 4 E2B (on-device)";
        return { onDevice: true, ready: !!r.ready };
      } catch {
        this.backendName = "Gemma 4 E2B (on-device)";
        return { onDevice: true, ready: false };
      }
    }
    const ep = devEndpoint();
    this.backendName = ep ? `dev endpoint (${ep.model || "remote"})` : "mock (dev)";
    return { onDevice: false, ready: true };
  },

  async loadModel(modelPath) {
    const gp = nativePlugin();
    if (!gp) return { ok: false, reason: "no on-device runtime" };
    return gp.load({ modelPath });
  },

  // messages: [{role, content}], images: [base64Jpeg], onToken: (t)=>void
  async generate(messages, images, onToken) {
    const gp = nativePlugin();
    if (gp) return this._generateNative(gp, messages, images, onToken);
    const ep = devEndpoint();
    if (ep) return this._generateOpenAI(ep, messages, images, onToken);
    return this._generateMock(messages, onToken);
  },

  // Wait until the model has finished loading, so the very first message doesn't
  // race the (async) engine init and fail with "Model not loaded".
  async _waitReady(gp, timeoutMs = 40000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if ((await gp.isReady()).ready) return true;
      } catch {
        /* ignore, retry */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  },

  // No token for this long (after streaming started) ⇒ the stream is over but
  // the runtime lost the "done" signal — finish with what we have.
  STALL_MS: 20000,
  // No first token at all for this long ⇒ give up (prefill can be slow on CPU,
  // so this is generous).
  FIRST_TOKEN_MS: 180000,

  async _generateNative(gp, messages, images, onToken) {
    if (!(await this._waitReady(gp))) {
      throw new Error("모델을 준비하는 중이에요. 잠시 후 다시 시도해주세요.");
    }
    this._cancelled = false;
    this._gp = gp;
    let acc = "";
    let lastTok = 0;
    let handle;
    if (gp.addListener) {
      handle = await gp.addListener("token", (e) => {
        if (this._cancelled) return; // stop button pressed — swallow late tokens
        lastTok = Date.now();
        acc += e.token || "";
        if (onToken) onToken(e.token);
      });
    }
    // The turn must ALWAYS end, even if the native runtime never delivers its
    // "done" (or ignores a cancel): race the generate call against
    //  • the stop button (resolve with partial), and
    //  • a stall watchdog (stream went silent → treat as finished).
    let watchdog;
    const started = Date.now();
    const donePromise = new Promise((resolve, reject) => {
      this._cancelResolve = () => resolve(null);
      watchdog = setInterval(() => {
        const now = Date.now();
        if (lastTok) {
          if (now - lastTok > this.STALL_MS) {
            this._cancelled = true; // mute any stragglers
            resolve(null); // finish with the partial text
            if (gp.cancel) gp.cancel().catch(() => {}); // release native side
          }
        } else if (now - started > this.FIRST_TOKEN_MS) {
          this._cancelled = true;
          if (gp.cancel) gp.cancel().catch(() => {});
          reject(new Error("응답 생성이 시작되지 않아 중단했어요. 다시 시도해주세요."));
        }
      }, 2000);
    });
    try {
      const res = await Promise.race([
        gp
          .generate({ messages, images: images || [] })
          .then((r) => r.text)
          .catch((e) => {
            if (this._cancelled) return null; // cancelled → fall back to partial
            throw e;
          }),
        donePromise,
      ]);
      return res == null ? acc : res;
    } finally {
      clearInterval(watchdog);
      this._cancelResolve = null;
      if (handle && handle.remove) handle.remove();
    }
  },

  // Stop an in-flight generation (user pressed the stop button).
  async cancel() {
    this._cancelled = true;
    // 1) End the JS turn right now (UI stops immediately, partial is kept).
    if (this._cancelResolve) this._cancelResolve();
    // 2) Ask the native runtime to abort the actual compute.
    const gp = this._gp || nativePlugin();
    try {
      if (gp && gp.cancel) await gp.cancel();
    } catch {
      /* ignore */
    }
  },

  async _generateOpenAI(ep, messages, images, onToken) {
    // Map our messages to OpenAI multimodal content parts.
    const oaMessages = messages.map((m) => {
      if (m.role === "user" && images && images.length) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...images.map((b64) => ({
              type: "image_url",
              image_url: { url: b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}` },
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: ep.model, messages: oaMessages, temperature: 0.7 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (onToken) onToken(text);
    return text;
  },

  // Deterministic mock so the loop is demonstrable without any model.
  async _generateMock(messages, onToken) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const raw = last?.content || "";
    const q = raw.toLowerCase();
    // An arithmetic expression = a run of math characters containing an operator.
    const mathMatch = raw.match(/[\d(][\d\s+\-*/%.()]*[\d)]/);
    const looksMath = mathMatch && /[+\-*/]/.test(mathMatch[0]) && /\d/.test(mathMatch[0]);
    let out;
    if (q.startsWith("observation:")) {
      out = `결과입니다: ${raw.slice("observation:".length).trim()}`;
    } else if (looksMath) {
      out =
        '```tool_call\n{ "tool": "calculator", "args": { "expression": "' +
        mathMatch[0].trim() +
        '" } }\n```';
    } else if (q.includes("time") || q.includes("시간") || q.includes("몇 시")) {
      out = '```tool_call\n{ "tool": "get_time", "args": {} }\n```';
    } else {
      out =
        "[mock backend] On a real phone this runs Gemma 4 E2B on-device. " +
        "I received your message and can see any attached images. " +
        "Configure a dev endpoint in Settings to test with a real model in the browser.";
    }
    this._cancelled = false;
    let acc = "";
    if (onToken) {
      for (const ch of out) {
        if (this._cancelled) return acc; // user pressed stop
        acc += ch;
        onToken(ch);
        await new Promise((r) => setTimeout(r, 12)); // simulate streaming
      }
    }
    return out;
  },
};
