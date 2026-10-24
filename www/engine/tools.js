// Tool / skill registry — the agent's hands.
//
// Each tool is { name, desc, params, run(args, ctx) -> string }. Tools return a
// short string that becomes the model's "observation". Keep results compact;
// the model reads them verbatim. Device-backed tools degrade gracefully when a
// Capacitor plugin is unavailable (e.g. running in a desktop browser).

import { Memory } from "./memory.js";
import { VOS } from "../vos/vos.js";

const Cap = () => window.Capacitor;
const plugin = (name) => (Cap() && Cap().Plugins ? Cap().Plugins[name] : undefined);

// Ask the user to approve a sensitive action (call/SMS). app.js registers the
// real UI via window.dyConfirm; falls back to a plain confirm() in a browser.
async function confirmAction(message, okLabel) {
  if (typeof window.dyConfirm === "function") return window.dyConfirm(message, okLabel);
  return Promise.resolve(window.confirm(message));
}

export function buildTools() {
  const tools = [
    {
      name: "get_time",
      desc: "Get the current local date and time.",
      params: {},
      async run() {
        const d = new Date();
        return d.toString();
      },
    },

    {
      name: "calculator",
      desc: "Evaluate an arithmetic expression. Supports + - * / % ** and parentheses.",
      params: {
        expression: { type: "string", required: true, desc: "e.g. (12000 * 1.1) / 3" },
      },
      async run({ expression }) {
        if (!/^[\d\s+\-*/%.()]+$/.test(String(expression))) {
          return "Error: expression contains unsupported characters.";
        }
        try {
          // eslint-disable-next-line no-new-func
          const val = Function(`"use strict"; return (${expression});`)();
          return `${expression} = ${val}`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    {
      name: "remember",
      desc: "Save a fact to persistent memory so you recall it in future sessions.",
      params: {
        topic: { type: "string", required: true, desc: "short key, e.g. 'home_city'" },
        content: { type: "string", required: true, desc: "the fact to store" },
      },
      async run({ topic, content }) {
        Memory.remember(String(topic), String(content));
        return `Saved note '${topic}'.`;
      },
    },

    {
      name: "recall",
      desc: "List everything currently in persistent memory.",
      params: {},
      async run() {
        const d = Memory.digest();
        return d || "Memory is empty.";
      },
    },

    {
      name: "device_info",
      desc: "Get info about the phone (platform, model, battery, etc.).",
      params: {},
      async run() {
        const Device = plugin("Device");
        if (!Device) return "Device plugin unavailable (running in browser). Platform: web.";
        try {
          const info = await Device.getInfo();
          const batt = await Device.getBatteryInfo().catch(() => ({}));
          return JSON.stringify({ ...info, battery: batt });
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    {
      name: "http_get",
      desc: "Fetch a URL over HTTPS and return the response text (truncated). Use only when the user asks for online info.",
      params: {
        url: { type: "string", required: true, desc: "https URL" },
      },
      async run({ url }) {
        if (!/^https:\/\//i.test(String(url))) return "Error: only https URLs are allowed.";
        try {
          const Http = plugin("CapacitorHttp");
          let body;
          if (Http) {
            const res = await Http.get({ url, readTimeout: 15000 });
            body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
          } else {
            const res = await fetch(url);
            body = await res.text();
          }
          return body.slice(0, 2000);
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    },

    {
      name: "take_photo",
      desc: "Open the camera so the user can capture a photo, then attach it for you to see on the next turn.",
      params: {},
      async run(_args, ctx) {
        const Camera = plugin("Camera");
        if (!Camera) return "Camera unavailable in this environment.";
        try {
          const photo = await Camera.getPhoto({
            resultType: "base64",
            source: "CAMERA",
            quality: 80,
          });
          ctx.attachImage(`data:image/jpeg;base64,${photo.base64String}`);
          return "Photo captured and attached; it is now visible to you.";
        } catch (e) {
          return `Camera cancelled or failed: ${e.message}`;
        }
      },
    },

    // ----- DY OS: the agent's in-app virtual OS workspace -----
    // A sandbox "phone inside the app" the agent operates directly (no Android
    // permissions). The user watches it work on the 워크스페이스 screen.
    {
      name: "os_screen",
      desc: "Look at the DY OS virtual screen — which app is open and what's on it. Use this to see the result of your actions.",
      params: {},
      async run() {
        return VOS.screen();
      },
    },
    {
      name: "os_open",
      desc: "Open a DY OS app: browser | notes | files | calc. (Or 'home' for the home screen.)",
      params: { app: { type: "string", required: true, desc: "browser/notes/files/calc/home" } },
      async run({ app }) {
        const a = String(app || "").toLowerCase();
        return a === "home" ? VOS.home() : VOS.open(a);
      },
    },
    {
      name: "browse",
      desc: "Open a web page in the DY OS browser and read it. Pass a full https URL, or a search query (searched on the web). Returns the page's readable text.",
      params: { query: { type: "string", required: true, desc: "https URL or search terms" } },
      async run({ query }) {
        return VOS.browse(String(query || ""));
      },
    },
    {
      name: "save_note",
      desc: "Create or overwrite a note in DY OS Notes.",
      params: {
        title: { type: "string", required: true, desc: "note title / key" },
        body: { type: "string", required: true, desc: "note contents" },
      },
      async run({ title, body }) {
        return VOS.saveNote(String(title || "무제"), String(body ?? ""));
      },
    },
    {
      name: "read_note",
      desc: "Read a saved note by title (or omit title to list all notes).",
      params: { title: { type: "string", required: false, desc: "note title, or empty to list" } },
      async run({ title }) {
        return title ? VOS.readNote(String(title)) : VOS.listNotes();
      },
    },
    {
      name: "write_file",
      desc: "Write a text file into the DY OS folder (overwrites if it exists). This is the same folder where DY browser saves downloads.",
      params: {
        name: { type: "string", required: true, desc: "file name" },
        content: { type: "string", required: true, desc: "file text" },
      },
      async run({ name, content }) {
        return VOS.writeFile(String(name || "file.txt"), String(content ?? ""));
      },
    },
    {
      name: "read_file",
      desc: "Read a text file from the DY OS folder by name (or omit name to list every file in the folder, including files the user downloaded in DY browser). Binary files (images etc.) can't be read as text.",
      params: { name: { type: "string", required: false, desc: "file name, or empty to list" } },
      async run({ name }) {
        return name ? VOS.readFile(String(name)) : VOS.listFiles();
      },
    },

    // ----- calls & messages (intent-based, always user-confirmed) -----
    {
      name: "call_phone",
      desc: "Place a phone call. ALWAYS shows the user a confirmation first; on approval it opens the dialer with the number filled in (the user presses call). Use for '…에게 전화' requests.",
      params: {
        number: { type: "string", required: true, desc: "phone number, digits" },
        name: { type: "string", required: false, desc: "who it is, for the confirmation" },
      },
      async run({ number, name }) {
        const who = name ? `${name}(${number})` : String(number);
        const ok = await confirmAction(`📞 ${who}에게 전화를 걸까요?`, "전화 걸기");
        if (!ok) return "사용자가 전화를 취소했어요.";
        const PA = plugin("PhoneActions");
        if (!PA) return "전화 기능은 폰(앱)에서만 동작해요.";
        try {
          await PA.dial({ number: String(number) });
          return `전화 앱을 열었어요 (${who}). 사용자가 통화 버튼을 누르면 연결돼요.`;
        } catch (e) {
          return `전화 앱을 열 수 없어요: ${e.message}`;
        }
      },
    },
    {
      name: "send_sms",
      desc: "Send a text message (SMS). ALWAYS shows the user a confirmation with the recipient and message first; on approval it opens the messaging app pre-filled (the user presses send).",
      params: {
        number: { type: "string", required: true, desc: "recipient phone number" },
        body: { type: "string", required: true, desc: "message text" },
        name: { type: "string", required: false, desc: "recipient name, for the confirmation" },
      },
      async run({ number, body, name }) {
        const who = name ? `${name}(${number})` : String(number);
        const ok = await confirmAction(
          `💬 ${who}에게 이 문자를 보낼까요?\n\n"${body}"`,
          "문자 보내기"
        );
        if (!ok) return "사용자가 문자를 취소했어요.";
        const PA = plugin("PhoneActions");
        if (!PA) return "문자 기능은 폰(앱)에서만 동작해요.";
        try {
          await PA.sms({ number: String(number), body: String(body ?? "") });
          return `문자 앱을 열었어요 (${who}). 사용자가 전송 버튼을 누르면 보내져요.`;
        } catch (e) {
          return `문자 앱을 열 수 없어요: ${e.message}`;
        }
      },
    },
  ];

  const map = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { list: tools, map };
}
