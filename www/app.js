// UI wiring: chat rendering, image attachments, streaming, tool visualization,
// model-status pill, and the settings dialog.

import { Agent } from "./engine/agent.js";
import { LLM } from "./engine/llm.js";
import { Memory } from "./engine/memory.js";
import { VOS } from "./vos/vos.js";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const fileInput = document.getElementById("fileInput");
const galleryBtn = document.getElementById("galleryBtn");
const cameraBtn = document.getElementById("cameraBtn");
const attachTray = document.getElementById("attachTray");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const settingsDlg = document.getElementById("settings");

const agent = new Agent();
let attachments = []; // base64 data URLs
let busy = false;

// ---------- rendering ----------
function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

function addMessage(role, text, images) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text || "";
  (images || []).forEach((src) => {
    const img = document.createElement("img");
    img.src = src;
    bubble.appendChild(img);
  });
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  scrollDown();
  return bubble;
}

// ---------- conversation history (saved across restarts) ----------
const CONVOS_KEY = "dyagent.convos";
let convos = [];
try {
  convos = JSON.parse(localStorage.getItem(CONVOS_KEY) || "[]");
} catch {
  convos = [];
}
let currentConvo = null;

function saveConvos() {
  try {
    localStorage.setItem(CONVOS_KEY, JSON.stringify(convos.slice(0, 60)));
  } catch {
    /* storage full — ignore */
  }
}

function ensureConvo() {
  if (!currentConvo) {
    currentConvo = { id: "c" + Date.now(), title: "새 대화", msgs: [], hist: [] };
    convos.unshift(currentConvo);
  }
  return currentConvo;
}

// Record a visible message into the current conversation and persist.
function recordMsg(role, text, images) {
  const c = ensureConvo();
  c.msgs.push({ role, text: text || "", images: images && images.length ? images : undefined });
  if (c.title === "새 대화" && role === "user" && text) c.title = text.slice(0, 26);
  c.hist = agent.history; // keep model context with the convo
  saveConvos();
  renderConvoList();
}

function clearChatMessages() {
  // Remove everything except the model card.
  [...chat.children].forEach((el) => {
    if (el.id !== "modelCard") el.remove();
  });
}

function newConversation() {
  currentConvo = null;
  agent.reset();
  clearChatMessages();
  addMessage(
    "agent",
    "안녕하세요! 저는 DY PHONE, 폰에서 도는 온디바이스 AI 에이전트예요. 무엇을 도와드릴까요?"
  );
  renderConvoList();
}

function loadConversation(id) {
  const c = convos.find((x) => x.id === id);
  if (!c) return;
  currentConvo = c;
  agent.history = Array.isArray(c.hist) ? c.hist.map((h) => ({ ...h })) : [];
  clearChatMessages();
  c.msgs.forEach((m) => addMessage(m.role, m.text, m.images));
  renderConvoList();
}

function renderConvoList() {
  const box = document.getElementById("drawerConvos");
  if (!box) return;
  box.innerHTML = "";
  convos.forEach((c) => {
    const b = document.createElement("button");
    b.className = "drawer-convo" + (currentConvo && currentConvo.id === c.id ? " active" : "");
    const t = document.createElement("span");
    t.className = "drawer-convo-title";
    t.textContent = c.title || "새 대화";
    const del = document.createElement("span");
    del.className = "drawer-convo-del";
    del.textContent = "×";
    del.onclick = (e) => {
      e.stopPropagation();
      convos = convos.filter((x) => x.id !== c.id);
      if (currentConvo && currentConvo.id === c.id) newConversation();
      saveConvos();
      renderConvoList();
    };
    b.append(t, del);
    b.onclick = () => {
      loadConversation(c.id);
      closeDrawer();
    };
    box.appendChild(b);
  });
}

const BOLT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bolt"/></svg>`;
const GRID_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-grid"/></svg>`;

// Which tools operate the virtual OS (get the "Using a Virtual OS" badge).
const OS_TOOLS = new Set([
  "os_screen", "os_open", "browse", "save_note", "read_note", "write_file", "read_file",
]);
const OS_ACTION = {
  browse: "웹 검색 중", os_open: "앱 여는 중", os_screen: "화면 확인 중",
  save_note: "메모 저장 중", read_note: "메모 읽는 중",
  write_file: "파일 저장 중", read_file: "파일 읽는 중",
};

function addTool(name, detail) {
  const el = document.createElement("div");
  el.className = "tool";
  el.innerHTML = `<b>${BOLT_SVG}${escapeHtml(name)}</b> ${detail}`;
  chat.appendChild(el);
  scrollDown();
  return el;
}

// A distinct status badge shown while the agent works inside DY OS.
function addOsBadge(name) {
  const el = document.createElement("div");
  el.className = "os-badge";
  const action = OS_ACTION[name] || "작업 중";
  el.innerHTML =
    `${GRID_SVG}<span class="os-badge-main">Using a Virtual OS</span>` +
    `<span class="os-badge-sub">${escapeHtml(action)}</span>` +
    `<span class="os-badge-dots"><span></span><span></span><span></span></span>`;
  chat.appendChild(el);
  scrollDown();
  return el;
}

function addTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  wrap.innerHTML = `<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
  chat.appendChild(wrap);
  scrollDown();
  return wrap;
}

// A streaming agent bubble: shows typing dots, then the model's gray "thinking"
// as it types out, then clears the gray and streams the white final answer.
function addLiveBubble() {
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble streaming";
  const dots = document.createElement("span");
  dots.className = "typing";
  dots.innerHTML = "<span></span><span></span><span></span>";
  const think = document.createElement("div");
  think.className = "think";
  think.hidden = true;
  const answer = document.createElement("div");
  answer.className = "answer";
  bubble.append(dots, think, answer);
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  scrollDown();
  return { wrap, bubble, dots, think, answer };
}

// Hide a tool_call fence from the live answer (real ```code``` fences stay).
function liveAnswer(s) {
  const i = s.search(/```tool_call/i);
  return i === -1 ? s : s.slice(0, i);
}

// Split streamed text into live { think, answer, thinking }.
function splitThinking(raw) {
  const open = raw.search(/<think>/i);
  if (open === -1) return { think: "", answer: liveAnswer(raw), thinking: false };
  const after = raw.slice(open + 7); // past "<think>"
  const close = after.search(/<\/think>/i);
  if (close === -1) return { think: after, answer: "", thinking: true };
  return { think: after.slice(0, close), answer: liveAnswer(after.slice(close + 8)), thinking: false };
}

function renderLive(live, raw) {
  const { think, answer, thinking } = splitThinking(raw);
  if (thinking) {
    live.think.hidden = false;
    live.think.textContent = think;
    live.answer.textContent = "";
  } else {
    // Reasoning finished (or never present) → drop the gray, stream white answer.
    live.think.hidden = true;
    live.think.textContent = "";
    live.answer.textContent = answer;
  }
  if (think || answer) live.dots.hidden = true;
  scrollDown();
}

// Final answer with <think> blocks and tool fences removed.
function finalAnswerText(raw) {
  let s = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<think>[\s\S]*$/i, ""); // unclosed think
  s = s.replace(/```tool_call[\s\S]*?```/gi, "");
  return s.trim();
}

// Fenced-code language → file extension for "save to DY OS".
const LANG_EXT = {
  html: "html", htm: "html", xml: "xml", svg: "svg",
  python: "py", py: "py", javascript: "js", js: "js", mjs: "js", jsx: "jsx",
  typescript: "ts", ts: "ts", css: "css", scss: "scss", json: "json",
  c: "c", "c++": "cpp", cpp: "cpp", cc: "cpp", java: "java", kotlin: "kt", kt: "kt",
  go: "go", rust: "rs", rs: "rs", ruby: "rb", php: "php", swift: "swift",
  bash: "sh", sh: "sh", shell: "sh", sql: "sql", yaml: "yaml", yml: "yml",
  markdown: "md", md: "md", text: "txt", txt: "txt",
};

// Extract code blocks from an answer. Tolerant of a missing closing fence
// (small models often forget it, or the answer was cut off) and of code with
// no fence at all (e.g. a bare HTML document).
function extractCodeBlocks(text) {
  const blocks = [];
  const src = String(text || "");
  // 1) Properly closed ```lang … ``` fences.
  const re = /```([a-zA-Z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  let end = 0;
  while ((m = re.exec(src)) !== null) {
    const code = m[2].replace(/\s+$/, "");
    if (code.trim()) blocks.push({ lang: (m[1] || "").toLowerCase(), code });
    end = re.lastIndex;
  }
  // 2) A trailing fence that was never closed.
  const tail = src.slice(end);
  const openM = tail.match(/```([a-zA-Z0-9+#._-]*)[ \t]*\r?\n([\s\S]*)$/);
  if (openM && openM[2] && openM[2].trim() && !openM[2].includes("```")) {
    blocks.push({ lang: (openM[1] || "").toLowerCase(), code: openM[2].replace(/\s+$/, "") });
  }
  // 3) No fences at all, but the whole answer looks like an HTML document.
  if (!blocks.length) {
    const t = src.trim();
    if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) {
      blocks.push({ lang: "html", code: t });
    }
  }
  return blocks;
}

// UTF-8-safe data URL so HTML (incl. Korean) runs in the DY browser.
function htmlDataUrl(code) {
  return "data:text/html;charset=utf-8," + encodeURIComponent(code);
}

// Open a saved code file: HTML runs in the DY browser; others open in the
// DY OS file preview.
async function openCodeFile(block, name, ext) {
  openWorkspace();
  const DYB = window.Capacitor?.Plugins?.DYBrowser;
  if (ext === "html" && DYB) {
    DYB.open({ url: htmlDataUrl(block.code) }).catch(() => {});
    VOS.open("files");
    VOS.refreshFiles?.();
  } else {
    await VOS.readFile(name);
  }
}

// Answers that contain code automatically become real files in the DY OS
// folder — no extra tap needed. Buttons under the answer run/open them.
let codeFileSeq = 0;
async function addCodeActions(container, blocks) {
  if (!blocks || !blocks.length) return;
  const DYFiles = window.Capacitor?.Plugins?.DYFiles;
  const bar = document.createElement("div");
  bar.className = "code-actions";
  if (!DYFiles) {
    const warn = document.createElement("div");
    warn.className = "code-saved-note";
    warn.style.color = "#e5a04d";
    warn.textContent = "⚠ DYFiles 플러그인을 찾을 수 없어 폴더에 저장하지 못했어요 (앱을 완전히 종료 후 재실행해 보세요).";
    bar.appendChild(warn);
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const ext = LANG_EXT[block.lang] || "txt";
    const stamp = new Date();
    const hh = String(stamp.getHours()).padStart(2, "0");
    const mm = String(stamp.getMinutes()).padStart(2, "0");
    // ASCII filename to avoid any filesystem encoding edge cases.
    const name = `code_${hh}${mm}_${++codeFileSeq}.${ext}`;

    const btn = document.createElement("button");
    btn.className = "code-save-btn";
    bar.appendChild(btn);
    const note = document.createElement("div");
    note.className = "code-saved-note";
    bar.appendChild(note);

    let saved = false;
    let err = "";
    try {
      if (DYFiles) {
        await DYFiles.writeText({ name, content: block.code }); // auto-save
        saved = true;
      }
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }

    if (saved) {
      btn.textContent = ext === "html" ? `▶ '${name}' 실행` : `📄 '${name}' 열기`;
      btn.onclick = () => openCodeFile(block, name, ext);
      note.textContent = `✓ DY OS 폴더에 '${name}' 저장됨`;
    } else if (DYFiles) {
      // Plugin present but the write failed — say why (don't fail silently).
      btn.textContent = `↻ 다시 저장 (${name})`;
      btn.onclick = async () => {
        try {
          await DYFiles.writeText({ name, content: block.code });
          note.textContent = `✓ DY OS 폴더에 '${name}' 저장됨`;
          btn.textContent = ext === "html" ? `▶ '${name}' 실행` : `📄 '${name}' 열기`;
          btn.onclick = () => openCodeFile(block, name, ext);
          VOS.refreshFiles?.();
        } catch (e2) {
          note.textContent = "저장 실패: " + (e2.message || e2);
        }
      };
      note.textContent = "저장 실패: " + err;
    } else {
      // Browser dev (no plugin): offer a download instead.
      btn.textContent = `💾 ${name} 내려받기`;
      btn.onclick = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([block.code], { type: "text/plain" }));
        a.download = name;
        a.click();
      };
    }
  }
  container.appendChild(bar);
  VOS.refreshFiles?.();
}

// ---------- status ----------
const modelCard = document.getElementById("modelCard");
let modelCardDismissed = false;
// True while a model file exists on disk (downloaded) but isn't loaded yet —
// in that case we show "모델 로딩 중", NOT the download card.
let modelPresentLoading = false;
// True once we've confirmed a model file is on disk — the download card must
// never appear again in this session.
let modelFileExists = false;

document.getElementById("modelCardClose").addEventListener("click", () => {
  modelCardDismissed = true;
  modelCard.hidden = true;
});

async function refreshStatus() {
  const s = await LLM.status();
  if (s.onDevice && s.ready) {
    statusDot.className = "dot ok";
    statusText.textContent = "온디바이스";
    modelCard.hidden = true;
  } else if (s.onDevice && !s.ready && (modelPresentLoading || modelFileExists)) {
    // Model file is on disk (loading or being verified) — never nag to download.
    statusDot.className = "dot";
    statusText.textContent = "모델 로딩 중…";
    modelCard.hidden = true;
  } else if (s.onDevice && !s.ready) {
    statusDot.className = "dot";
    statusText.textContent = "모델 필요";
    modelCard.hidden = modelCardDismissed;
  } else {
    statusDot.className = "dot off";
    statusText.textContent = LLM.backendName;
    modelCard.hidden = true;
  }
}

// ---------- model download (on-device) ----------
// Uses the native ModelDownloader plugin (Android DownloadManager): the system
// owns the transfer, so it keeps going with the screen off or the app closed,
// retries on flaky networks, and shows progress in the notification shade. We
// persist the download id so reopening the app re-attaches to the same
// transfer. Falls back to Filesystem.downloadFile where the plugin is missing.
const modelUrlInput = document.getElementById("modelUrl");
const modelDownloadBtn = document.getElementById("modelDownloadBtn");
const modelNote = document.getElementById("modelNote");
const modelProgress = document.getElementById("modelProgress");
const modelProgressBar = document.getElementById("modelProgressBar");
const modelProgressText = document.getElementById("modelProgressText");

const DL_KEY = "dyagent.model.download"; // in-flight: { id, path, fileName }
const MODEL_KEY = "dyagent.model.path"; // completed: absolute path (or bare name)

const FAIL_REASONS = {
  1006: "저장 공간이 부족해요 (4GB 이상 필요)",
  1008: "이어받기가 불가능해 처음부터 다시 받아야 해요",
  1005: "리다이렉트가 너무 많아요 (URL 확인)",
  1002: "서버 응답 오류 (URL 확인)",
  1004: "네트워크 데이터 오류",
};

function fmtGB(bytes) {
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

function savedDownload() {
  try {
    return JSON.parse(localStorage.getItem(DL_KEY) || "null");
  } catch {
    return null;
  }
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce(dl) {
  const MD = window.Capacitor?.Plugins?.ModelDownloader;
  if (!MD) return;
  let s;
  try {
    s = await MD.status({ id: dl.id });
  } catch {
    return; // transient; keep polling
  }
  if (s.state === "running" || s.state === "pending" || s.state === "paused") {
    modelProgress.hidden = false;
    if (s.total > 0) {
      const pct = Math.min(100, (s.bytes / s.total) * 100);
      modelProgressBar.style.width = pct.toFixed(1) + "%";
      modelProgressText.textContent =
        `${pct.toFixed(0)}% · ${fmtGB(s.bytes)} / ${fmtGB(s.total)}` +
        (s.state === "paused" ? " · 일시중지(자동 재시도)" : "");
    } else {
      modelProgressText.textContent =
        s.state === "pending" ? "대기 중…" : fmtGB(s.bytes) + " 받는 중…";
    }
    return;
  }

  stopPolling();
  modelDownloadBtn.disabled = false;

  if (s.state === "success") {
    localStorage.setItem(MODEL_KEY, dl.path);
    localStorage.removeItem(DL_KEY);
    modelProgressBar.style.width = "100%";
    modelProgressText.textContent = "다운로드 완료 · 모델 로딩 중…";
    try {
      const r = await LLM.loadModel(dl.path);
      if (r && r.ok) {
        modelProgressText.textContent = "준비 완료!";
      } else {
        modelNote.textContent = "모델 로딩에 실패했어요. 파일 형식을 확인해주세요.";
      }
    } catch (e) {
      modelProgress.hidden = true;
      const msg = String(e.message || e);
      if (/not found|없|download it first/i.test(msg)) {
        localStorage.removeItem(MODEL_KEY);
        modelNote.textContent = "모델 파일이 없어요. 다시 다운로드해주세요.";
      } else {
        modelNote.textContent =
          `모델 로딩 실패: ${msg} — 파일 형식이 맞는지 확인해주세요 (현재 엔진은 .litertlm 파일용이에요).`;
      }
    }
    refreshStatus();
  } else if (s.state === "failed") {
    localStorage.removeItem(DL_KEY);
    modelProgress.hidden = true;
    modelNote.textContent =
      "다운로드 실패: " + (FAIL_REASONS[s.reason] || `오류 코드 ${s.reason}`);
  } else {
    // "gone" — cancelled from the notification shade
    localStorage.removeItem(DL_KEY);
    modelProgress.hidden = true;
    modelNote.textContent = "다운로드가 취소됐어요.";
  }
}

function startPolling(dl) {
  stopPolling();
  modelDownloadBtn.disabled = true;
  modelNote.textContent = "화면을 꺼도 알림창에서 계속 받아져요.";
  modelProgress.hidden = false;
  pollOnce(dl);
  pollTimer = setInterval(() => pollOnce(dl), 1000);
}

async function downloadViaFilesystem(url, fileName) {
  // Browser-dev / plugin-missing fallback: in-app streaming download.
  const FS = window.Capacitor?.Plugins?.Filesystem;
  if (!FS) {
    modelNote.textContent = "이 기능은 폰(앱)에서만 동작해요.";
    return;
  }
  modelDownloadBtn.disabled = true;
  modelProgress.hidden = false;
  modelProgressText.textContent = "연결 중…";
  let sub;
  try {
    sub = await FS.addListener("progress", (p) => {
      if (p.contentLength > 0) {
        const pct = Math.min(100, (p.bytes / p.contentLength) * 100);
        modelProgressBar.style.width = pct.toFixed(1) + "%";
        modelProgressText.textContent =
          `${pct.toFixed(0)}% · ${fmtGB(p.bytes)} / ${fmtGB(p.contentLength)}`;
      }
    });
    await FS.downloadFile({ url, path: fileName, directory: "DATA", progress: true, recursive: true });
    localStorage.setItem(MODEL_KEY, fileName);
    modelProgressText.textContent = "다운로드 완료 · 모델 로딩 중…";
    const r = await LLM.loadModel(fileName);
    modelProgressText.textContent = r && r.ok ? "준비 완료!" : "모델 로딩 실패";
  } catch (e) {
    modelNote.textContent = `다운로드 실패: ${e.message || e}`;
    modelProgress.hidden = true;
  } finally {
    if (sub && sub.remove) sub.remove();
    modelDownloadBtn.disabled = false;
    refreshStatus();
  }
}

modelDownloadBtn.addEventListener("click", async () => {
  const url = modelUrlInput.value.trim();
  if (!url) {
    modelNote.textContent = "모델 URL을 입력해주세요.";
    return;
  }
  const fileName = (url.split("/").pop() || "model.litertlm").split("?")[0];
  const MD = window.Capacitor?.Plugins?.ModelDownloader;
  if (!MD) {
    downloadViaFilesystem(url, fileName);
    return;
  }
  // If a download is already in progress (still running in the background via
  // the system DownloadManager), re-attach and keep going instead of restarting
  // from zero — this is the resume path.
  const existing = savedDownload();
  if (existing) {
    try {
      const s = await MD.status({ id: existing.id });
      if (s.state === "running" || s.state === "pending" || s.state === "paused") {
        modelNote.textContent = "이미 받는 중이에요 — 이어서 표시할게요.";
        startPolling(existing);
        return;
      }
    } catch {
      /* fall through to a fresh start */
    }
    localStorage.removeItem(DL_KEY);
  }
  modelNote.textContent = "";
  modelProgressBar.style.width = "0%";
  try {
    const dl = await MD.start({ url, fileName });
    dl.fileName = fileName;
    localStorage.setItem(DL_KEY, JSON.stringify(dl));
    startPolling(dl);
  } catch (e) {
    modelNote.textContent = `다운로드 시작 실패: ${e.message || e}`;
  }
});

// "처음부터 다시" — cancel any in-flight download and start a fresh one from 0.
document.getElementById("modelRestartBtn").addEventListener("click", async () => {
  const url = modelUrlInput.value.trim();
  if (!url) {
    modelNote.textContent = "모델 URL을 입력해주세요.";
    return;
  }
  const fileName = (url.split("/").pop() || "model.litertlm").split("?")[0];
  const MD = window.Capacitor?.Plugins?.ModelDownloader;
  if (!MD) {
    downloadViaFilesystem(url, fileName);
    return;
  }
  const existing = savedDownload();
  if (existing) {
    try {
      await MD.cancel({ id: existing.id });
    } catch {
      /* ignore */
    }
  }
  localStorage.removeItem(DL_KEY);
  localStorage.removeItem(MODEL_KEY);
  modelNote.textContent = "처음부터 다시 받는 중…";
  modelProgressBar.style.width = "0%";
  try {
    const dl = await MD.start({ url, fileName });
    dl.fileName = fileName;
    localStorage.setItem(DL_KEY, JSON.stringify(dl));
    startPolling(dl);
  } catch (e) {
    modelNote.textContent = `다운로드 시작 실패: ${e.message || e}`;
  }
});

// ---------- attachments ----------
function renderTray() {
  attachTray.innerHTML = "";
  attachTray.hidden = attachments.length === 0;
  attachments.forEach((src, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    t.innerHTML = `<img src="${src}"><div class="x" data-i="${i}">×</div>`;
    attachTray.appendChild(t);
  });
}

attachTray.addEventListener("click", (e) => {
  const i = e.target?.dataset?.i;
  if (i !== undefined) {
    attachments.splice(Number(i), 1);
    renderTray();
  }
});

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

galleryBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const f of fileInput.files) attachments.push(await fileToDataUrl(f));
  fileInput.value = "";
  renderTray();
});

cameraBtn.addEventListener("click", async () => {
  const Cap = window.Capacitor;
  const Camera = Cap?.Plugins?.Camera;
  if (!Camera) {
    fileInput.setAttribute("capture", "environment");
    fileInput.click();
    return;
  }
  try {
    const photo = await Camera.getPhoto({ resultType: "base64", source: "CAMERA", quality: 80 });
    attachments.push(`data:image/jpeg;base64,${photo.base64String}`);
    renderTray();
  } catch {
    /* cancelled */
  }
});

// ---------- send ----------
function toBase64Jpeg(dataUrl) {
  return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

async function send(text) {
  if (busy) return;
  const images = [...attachments];
  addMessage("user", text, images);
  recordMsg("user", text, images);
  attachments = [];
  renderTray();
  input.value = "";
  autoGrow();

  busy = true;
  setSendMode("stop"); // the send button becomes a stop button while generating
  let live = addLiveBubble();
  let raw = "";

  try {
    await agent.run(text, images.map(toBase64Jpeg), {
      onToken: (t) => {
        if (!live) return;
        raw += t;
        renderLive(live, raw);
      },
      onToolCall: (name, args) => {
        // This step was a tool call, not an answer — drop its bubble, show a chip.
        if (live) { live.wrap.remove(); live = null; }
        if (OS_TOOLS.has(name)) addOsBadge(name);
        else addTool(name, `호출: <code>${escapeHtml(JSON.stringify(args))}</code>`);
      },
      onToolResult: (name, res) => {
        if (!OS_TOOLS.has(name)) {
          const short = String(res).length > 160 ? String(res).slice(0, 160) + "…" : String(res);
          addTool(name, `결과: ${escapeHtml(short)}`);
        }
        // Fresh streaming bubble as the model reasons over the observation.
        live = addLiveBubble();
        raw = "";
      },
      onFinal: (finalText) => {
        // Extract code from the RAW text (before <think> stripping): a small
        // model sometimes puts the code inside an unclosed <think>, which
        // finalAnswerText would otherwise delete.
        const rawNoTool = String(finalText).replace(/```tool_call[\s\S]*?```/gi, "");
        const blocks = extractCodeBlocks(rawNoTool);
        let clean = finalAnswerText(finalText);
        if (!clean && blocks.length) {
          // The answer was swallowed by <think> — show the code itself.
          clean = blocks
            .map((b) => "```" + (b.lang || "") + "\n" + b.code + "\n```")
            .join("\n\n");
        }
        if (!live) live = addLiveBubble();
        live.bubble.classList.remove("streaming");
        live.dots.hidden = true;
        live.think.remove();
        live.answer.textContent = clean;
        if (!clean && !blocks.length) live.wrap.remove();
        else {
          const b = live.bubble;
          addCodeActions(b, blocks).catch((e) => {
            const n = document.createElement("div");
            n.className = "code-saved-note";
            n.style.color = "#e5484d";
            n.textContent = "코드 저장 오류: " + (e && e.message ? e.message : e);
            b.appendChild(n);
          });
        }
        recordMsg("agent", clean);
        scrollDown();
      },
    });
  } catch (e) {
    if (live) live.wrap.remove();
    addMessage("agent", `오류가 발생했어요: ${e.message}`);
  } finally {
    busy = false;
    setSendMode("send");
    input.focus();
  }
}

// Toggle the composer button between "send" (paper plane) and "stop" (square).
function setSendMode(mode) {
  const use = sendBtn.querySelector("use");
  if (mode === "stop") {
    sendBtn.classList.add("stopping");
    sendBtn.title = "생성 중지";
    sendBtn.setAttribute("aria-label", "생성 중지");
    if (use) use.setAttribute("href", "#i-stop");
  } else {
    sendBtn.classList.remove("stopping");
    sendBtn.title = "보내기";
    sendBtn.setAttribute("aria-label", "보내기");
    if (use) use.setAttribute("href", "#i-send");
  }
}

// Stop an in-flight generation.
function stopGeneration() {
  agent.abort();
  LLM.cancel();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { stopGeneration(); return; } // the button is a stop button now
  const text = input.value.trim();
  if (text) send(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}
input.addEventListener("input", autoGrow);

// ---------- action confirmation (call / SMS) ----------
// Renders a confirm card in the chat and resolves true/false when tapped.
window.dyConfirm = (message, okLabel = "확인") =>
  new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "confirm-card";
    const text = document.createElement("div");
    text.className = "confirm-text";
    text.textContent = message;
    card.appendChild(text);
    const row = document.createElement("div");
    row.className = "confirm-row";
    const yes = document.createElement("button");
    yes.className = "confirm-yes";
    yes.textContent = okLabel;
    const no = document.createElement("button");
    no.className = "confirm-no";
    no.textContent = "취소";
    row.append(no, yes);
    card.appendChild(row);
    chat.appendChild(card);
    scrollDown();
    const done = (v) => {
      yes.disabled = no.disabled = true;
      card.classList.add(v ? "done-yes" : "done-no");
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });

// ---------- sidebar drawer + workspace (DY OS) ----------
const workspace = document.getElementById("workspace");
const drawer = document.getElementById("drawer");
const drawerScrim = document.getElementById("drawerScrim");
VOS.mount(document.getElementById("vosRoot"));

function openDrawer() {
  drawer.hidden = false;
  drawerScrim.hidden = false;
  requestAnimationFrame(() => drawer.classList.add("open"));
}
function closeDrawer() {
  drawer.classList.remove("open");
  drawerScrim.hidden = true;
  setTimeout(() => (drawer.hidden = true), 220);
}
function openWorkspace() {
  workspace.hidden = false;
}
function closeWorkspace() {
  workspace.hidden = true;
}

document.getElementById("menuBtn").addEventListener("click", openDrawer);
drawerScrim.addEventListener("click", closeDrawer);
document.getElementById("drawerNew").addEventListener("click", () => {
  closeDrawer();
  closeWorkspace();
  newConversation();
});
document.getElementById("drawerOs").addEventListener("click", () => {
  closeDrawer();
  openWorkspace();
});
document.getElementById("drawerSettings").addEventListener("click", () => {
  closeDrawer();
  document.getElementById("settingsBtn").click();
});
// "대화로 돌아가기" — user-only control (the agent has no tool that hides the
// workspace, so it cannot press this; it keeps working in DY OS regardless).
document.getElementById("workspaceClose").addEventListener("click", closeWorkspace);

// When the agent acts on DY OS, pop the workspace open so the user sees it.
const _vosOpen = VOS.open.bind(VOS);
VOS.open = (app) => {
  openWorkspace();
  return _vosOpen(app);
};
const _vosBrowse = VOS.browse.bind(VOS);
VOS.browse = (q) => {
  openWorkspace();
  return _vosBrowse(q);
};

// ---------- thinking mode (top-bar logo toggle) ----------
const THINK_KEY = "dyagent.thinking";
const thinkBtn = document.getElementById("thinkBtn");
const thinkPill = document.getElementById("thinkPill");

function thinkingOn() {
  return localStorage.getItem(THINK_KEY) !== "off";
}

function renderThinking() {
  const on = thinkingOn();
  thinkPill.textContent = on ? "생각 ON" : "생각 OFF";
  thinkPill.classList.toggle("off", !on);
  thinkBtn.querySelector(".logo").classList.toggle("think-off", !on);
}

thinkBtn.addEventListener("click", () => {
  localStorage.setItem(THINK_KEY, thinkingOn() ? "off" : "on");
  renderThinking();
  addMessage(
    "agent",
    thinkingOn()
      ? "생각 모드를 켰어요. 어려운 질문에 더 깊게 고민하는 대신 느려질 수 있어요."
      : "생각 모드를 껐어요. 이제 고민 없이 바로 답해서 더 빨라져요."
  );
});
renderThinking();

// ---------- settings ----------
document.getElementById("settingsBtn").addEventListener("click", () => {
  const ep = JSON.parse(localStorage.getItem("dyagent.dev.endpoint") || "null");
  document.getElementById("epBase").value = ep?.baseUrl || "";
  document.getElementById("epModel").value = ep?.model || "";
  document.getElementById("epKey").value = ep?.apiKey || "";
  settingsDlg.showModal();
});

settingsDlg.addEventListener("close", async () => {
  const v = settingsDlg.returnValue;
  if (v === "save") {
    const ep = {
      baseUrl: document.getElementById("epBase").value.trim(),
      model: document.getElementById("epModel").value.trim(),
      apiKey: document.getElementById("epKey").value.trim(),
    };
    if (ep.baseUrl) localStorage.setItem("dyagent.dev.endpoint", JSON.stringify(ep));
  } else if (v === "clear") {
    localStorage.removeItem("dyagent.dev.endpoint");
  } else if (v === "wipe") {
    Memory.clear();
    agent.reset();
    addMessage("agent", "메모리를 초기화했어요.");
  }
  refreshStatus();
});

// ---------- boot ----------
renderConvoList(); // show saved conversations in the drawer
if (window.Capacitor?.isNativePlatform?.()) {
  // Assume a model may be present until findModel proves otherwise — this keeps
  // the download card from flashing at launch for users who already downloaded.
  modelFileExists = true;
  const inFlight = savedDownload();
  if (inFlight) {
    modelFileExists = false;
    // A system download from a previous run may still be going — re-attach.
    startPolling(inFlight);
  } else {
    bootLoadModel();
  }
} else {
  refreshStatus(); // browser dev: no model, mock backend
}

async function bootLoadModel() {
  const MD = window.Capacitor?.Plugins?.ModelDownloader;
  // Prefer the saved path; otherwise scan the folder for an already-downloaded
  // model so a present file never triggers the "download needed" card.
  let modelPath = localStorage.getItem(MODEL_KEY);
  if (!modelPath && MD) {
    try {
      const f = await MD.findModel();
      if (f.found) {
        modelPath = f.path;
        localStorage.setItem(MODEL_KEY, f.path);
      }
    } catch {
      /* ignore */
    }
  }
  if (!modelPath) {
    modelFileExists = false; // no model anywhere → allow the download card
    refreshStatus();
    return;
  }
  modelFileExists = true;
  modelPresentLoading = true;
  refreshStatus(); // shows "모델 로딩 중…", hides the card
  try {
    await LLM.loadModel(modelPath);
  } catch (e) {
    if (/not found|없|download it first/i.test(String(e && e.message))) {
      localStorage.removeItem(MODEL_KEY);
    }
  } finally {
    modelPresentLoading = false;
    refreshStatus();
  }
}
