// The agent loop — perceive → decide → act → observe.
//
// The model emits either a fenced ```tool_call``` block or a final answer. We
// parse tool calls, run the tool, feed back an "observation", and iterate up to
// a step budget. Images attached by the user (or produced by tools like
// take_photo) are passed to the multimodal model on the turn they appear.

import { buildSystemPrompt, buildUserTurn } from "./prompts.js";
import { buildTools } from "./tools.js";
import { LLM } from "./llm.js";
import { Memory } from "./memory.js";

const MAX_STEPS = 12;
// Accept the intended ```tool_call fence, but also ```json / bare ``` fences and
// a naked JSON object — small models are inconsistent about the wrapper.
const FENCE_RE = /```(?:tool_call|json)?\s*([\s\S]*?)```/i;
const OBJ_RE = /\{[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?\}/;

// Common near-miss tool names a small model might emit → the real tool.
const TOOL_ALIASES = {
  search: "browse", web_search: "browse", websearch: "browse", google: "browse",
  검색: "browse", open: "os_open", note: "save_note", savenote: "save_note",
  memo: "save_note", 메모: "save_note", readnote: "read_note",
  writefile: "write_file", readfile: "read_file", call: "call_phone",
  phone: "call_phone", sms: "send_sms", message: "send_sms",
};

// If the model refuses to call a tool, detect an obvious "search this" request
// so DY OS still gets used. Returns a query string, or null.
function detectSearchIntent(text) {
  const t = String(text || "");
  if (!/(검색|찾아|찾아봐|찾아 줘|알아봐|알아 봐|서치|search|구글|google|뉴스|날씨|주가|환율|가격)/i.test(t)) {
    return null;
  }
  const q = t
    .replace(/(검색해줘|검색해 줘|검색|찾아줘|찾아 줘|찾아봐|찾아|알아봐|알아 봐|서치|해줘|해 줘|좀|을|를|에 대해|에대해)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q || t;
}

export class Agent {
  constructor() {
    this.tools = buildTools();
    this.history = []; // [{role, content}]
    this.aborted = false;
  }

  reset() {
    this.history = [];
  }

  // Request the current run to stop (user pressed the stop button).
  abort() {
    this.aborted = true;
  }

  parseToolCall(text) {
    const known = this.tools.map;
    const tryParse = (raw) => {
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw.trim());
        if (obj && typeof obj.tool === "string") {
          const name = TOOL_ALIASES[obj.tool.toLowerCase()] || obj.tool;
          if (known[name]) return { tool: name, args: obj.args || {} };
        }
      } catch {
        /* ignore */
      }
      return null;
    };
    // 1) fenced block (tool_call / json / bare)
    const fence = text.match(FENCE_RE);
    const fromFence = fence && tryParse(fence[1]);
    if (fromFence) return fromFence;
    // 2) a naked JSON object containing "tool"
    const obj = text.match(OBJ_RE);
    const fromObj = obj && tryParse(obj[0]);
    if (fromObj) return fromObj;
    return null;
  }

  // events: { onThinking(step), onToolCall(name,args), onToolResult(name,res),
  //           onToken(t), onFinal(text) }
  async run(userText, userImages, events = {}) {
    this.aborted = false;
    const pendingImages = [...(userImages || [])];
    const ctx = { attachImage: (b64) => pendingImages.push(b64) };

    // Thinking mode is toggled from the top-bar logo (app.js owns the UI).
    const thinking = localStorage.getItem("dyagent.thinking") !== "off";
    const system = buildSystemPrompt(this.tools.list, Memory.digest(), thinking);
    this.history.push({ role: "user", content: buildUserTurn(userText, pendingImages.length) });

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.aborted) break;
      events.onThinking?.(step);

      const messages = [{ role: "system", content: system }, ...this.history];
      // Only the newest user/observation turn carries fresh images.
      const imagesThisTurn = step === 0 ? pendingImages : [];

      let text = "";
      text = await LLM.generate(messages, imagesThisTurn, (t) => {
        events.onToken?.(t);
      });

      // User stopped mid-generation → keep whatever partial we have and finish.
      if (this.aborted) {
        this.history.push({ role: "assistant", content: text });
        events.onFinal?.(text);
        return text;
      }

      const call = this.parseToolCall(text);
      if (!call) {
        // The model didn't call a tool. If this looks like a clear search
        // request, run browse anyway so DY OS still gets used (weak models
        // often skip the tool). Only on the first step.
        const q = step === 0 ? detectSearchIntent(userText) : null;
        if (q && this.tools.map.browse) {
          events.onToolCall?.("browse", { query: q });
          let obs;
          try {
            obs = await this.tools.map.browse.run({ query: q }, ctx);
          } catch (e) {
            obs = `Error: ${e.message}`;
          }
          events.onToolResult?.("browse", obs);
          this.history.push({
            role: "assistant",
            content: '```tool_call\n{ "tool": "browse", "args": { "query": ' + JSON.stringify(q) + " } }\n```",
          });
          this.history.push({ role: "user", content: `observation: ${obs}` });
          continue;
        }
        // Final answer.
        this.history.push({ role: "assistant", content: text });
        events.onFinal?.(text);
        return text;
      }

      // Record the assistant's tool-call turn, then execute.
      this.history.push({ role: "assistant", content: text });
      events.onToolCall?.(call.tool, call.args);

      const tool = this.tools.map[call.tool];
      let observation;
      if (!tool) {
        observation = `Error: unknown tool '${call.tool}'.`;
      } else {
        try {
          // A tool must never hang the loop (e.g. a fetch with no timeout).
          observation = await Promise.race([
            tool.run(call.args, ctx),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("시간 초과(30초)")), 30000)
            ),
          ]);
        } catch (e) {
          observation = `Error running ${call.tool}: ${e.message}`;
        }
      }
      events.onToolResult?.(call.tool, observation);
      this.history.push({ role: "user", content: `observation: ${observation}` });
      // Loop again so the model can use the observation.
    }

    if (this.aborted) {
      events.onFinal?.("");
      return "";
    }
    const giveUp = "I've taken several steps but couldn't complete this. Could you rephrase or narrow it down?";
    this.history.push({ role: "assistant", content: giveUp });
    events.onFinal?.(giveUp);
    return giveUp;
  }
}
