// DY OS — a tiny virtual operating system that lives INSIDE the app.
//
// This is the agent's workspace: instead of driving the real phone (which needs
// the accessibility permission that app stores / Play Protect block), the agent
// operates this self-contained sandbox — a little phone-within-the-phone with a
// home screen and a few virtual apps (browser, notes, files, calculator).
//
// Everything here is plain JS + DOM in the WebView. No Android permissions, no
// accessibility service. The tools in engine/tools.js call this API to act; the
// user watches it happen on screen, exactly like watching an agent work.

const LS = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k) || "null") ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    localStorage.setItem(k, JSON.stringify(v));
  },
};

const NOTES_KEY = "dyos.notes"; // { title: body }
const FILES_KEY = "dyos.files"; // { name: content } (browser fallback only)

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

// Map a file extension to how DY OS should open it.
const CODE_EXT = new Set([
  "py", "pyw", "java", "c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "cs", "js",
  "mjs", "cjs", "ts", "jsx", "tsx", "go", "rs", "rb", "php", "swift", "kt",
  "kts", "scala", "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "r", "lua",
  "pl", "pm", "dart", "m", "mm", "vue", "svelte", "gradle", "groovy", "clj",
  "ex", "exs", "erl", "hs", "ml", "fs", "jl", "nim", "zig", "v", "asm", "s",
  "vb", "pas", "f", "f90", "rkt", "lisp", "el", "tcl", "awk",
]);
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "json", "json5", "jsonc", "yaml",
  "yml", "xml", "csv", "tsv", "ini", "toml", "log", "env", "conf", "cfg",
  "properties", "html", "htm", "css", "scss", "sass", "less", "diff", "patch",
  "gitignore", "dockerfile", "makefile", "srt", "vtt", "tex", "bib", "graphql",
  "proto",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "apng", "jfif"]);
const MODEL_EXT = new Set(["glb", "gltf"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "3gp"]);
const ARCHIVE_EXT = new Set(["zip", "jar", "apk", "epub", "war", "ipa"]);

function fileKind(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (CODE_EXT.has(ext)) return { kind: "code", ext };
  if (TEXT_EXT.has(ext)) return { kind: "text", ext };
  if (IMAGE_EXT.has(ext)) return { kind: "image", ext };
  if (MODEL_EXT.has(ext)) return { kind: "model", ext };
  if (AUDIO_EXT.has(ext)) return { kind: "audio", ext };
  if (VIDEO_EXT.has(ext)) return { kind: "video", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "docx") return { kind: "docx", ext };
  if (ext === "xlsx" || ext === "xls") return { kind: "sheet", ext };
  if (ext === "pptx") return { kind: "pptx", ext };
  if (ext === "hwp" || ext === "hwpx") return { kind: "hwp", ext };
  if (ARCHIVE_EXT.has(ext)) return { kind: "archive", ext };
  return { kind: "binary", ext };
}

// Lazily load a bundled vendor script once (heavy libs load only when needed).
const _libs = {};
function loadLib(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (_libs[src]) return _libs[src];
  _libs[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(globalName ? window[globalName] : true);
    s.onerror = () => reject(new Error("라이브러리 로드 실패: " + src));
    document.head.appendChild(s);
  });
  return _libs[src];
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function xmlEsc(x) {
  return String(x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A generic file glyph (document with the extension printed on it), used for
// files that have no dedicated preview.
function fileGlyph(ext) {
  const label = String(ext || "").slice(0, 4).toUpperCase() || "FILE";
  return (
    `<svg viewBox="0 0 64 64" fill="none">` +
    `<path d="M16 6h22l12 12v38a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4Z" fill="#141821" stroke="#3d7bff" stroke-width="2.5"/>` +
    `<path d="M38 6v12h12" stroke="#3d7bff" stroke-width="2.5"/>` +
    `<rect x="12" y="33" width="40" height="16" rx="3" fill="#ff6b3d"/>` +
    `<text x="32" y="45" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="sans-serif">${label}</text>` +
    `</svg>`
  );
}

// Hand-drawn app-icon wrapper: a rounded dark tile + line art (stroke-based).
function icon(inner) {
  return (
    `<svg viewBox="0 0 32 32" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="1" y="1" width="30" height="30" rx="8" fill="#141821" stroke="#2a3245" stroke-width="1"/>` +
    inner +
    `</svg>`
  );
}

// Write a binary file (base64) into the DY OS folder; falls back to a data-URL
// download in a plain browser.
async function saveBinary(name, b64, mime) {
  const P = window.Capacitor?.Plugins?.DYFiles;
  if (P) {
    await P.writeBase64({ name, content: b64 });
    return `'${name}' 저장됨 (DY OS 폴더).`;
  }
  const a = document.createElement("a");
  a.href = `data:${mime || "application/octet-stream"};base64,${b64}`;
  a.download = name;
  a.click();
  return `'${name}' 내려받음.`;
}

// Native HTTP (Capacitor) bypasses CORS; falls back to fetch in a browser.
async function httpGet(url) {
  const Cap = window.Capacitor;
  const Http = Cap && Cap.Plugins ? Cap.Plugins.CapacitorHttp : null;
  if (Http) {
    const res = await Http.get({ url, readTimeout: 15000, connectTimeout: 15000 });
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }
  const res = await fetch(url);
  return res.text();
}

// Strip HTML to readable text (the virtual browser is a reader view).
function htmlToText(html) {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const doc = new DOMParser().parseFromString(noScript, "text/html");
  const title = doc.querySelector("title")?.textContent?.trim() || "";
  const body = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
  return { title, body };
}

export const VOS = {
  el: null, // mounted root element
  app: "home", // home | browser | notes | files | calc
  state: {
    // mode: "web" = real interactive iframe (keeps its own login session),
    //       "reader" = extracted text (works even when a site blocks framing)
    browser: { url: "", title: "", text: "", loading: false, mode: "web" },
    calc: { expr: "", result: "" },
    code: {
      lang: "js",
      out: "",
      srcs: {
        js: "// JavaScript를 작성하고 실행하세요\nlet sum = 0;\nfor (let i = 1; i <= 10; i++) sum += i;\nconsole.log('1~10 합 =', sum);",
        py: "# Python을 작성하고 실행하세요\ntotal = 0\nfor i in range(1, 11):\n    total += i\nprint('1~10 합 =', total)",
        c: '#include <iostream>\nusing namespace std;\n\nint main() {\n    int sum = 0;\n    for (int i = 1; i <= 10; i++) sum += i;\n    cout << "1~10 합 = " << sum << endl;\n    return 0;\n}',
      },
    },
    sheet: { rows: 8, cols: 5, data: {} },
    doc: { title: "제목 없음", body: "" },
    slides: {
      theme: 0,
      cur: 0,
      deck: [
        { layout: "title", title: "DY PHONE", subtitle: "폰에서 도는 온디바이스 AI 에이전트" },
        { layout: "content", title: "핵심 기능", bullets: ["Gemma 4 E2B 온디바이스 추론", "이미지 이해와 자연스러운 대화", "가상 OS(DY OS)에서 직접 작업 수행", "코드·엑셀·워드·PPT 파일 생성과 미리보기"] },
        { layout: "content", title: "작동 방식", bullets: ["질문을 이해하고 실행 계획을 세움", "필요하면 브라우저·파일 도구를 사용", "결과를 관찰하고 다시 추론", "정리된 최종 답변을 제공"] },
        { layout: "content", title: "DY OS 가상 작업공간", bullets: ["브라우저 · 메모 · 파일 · 계산기", "코드(파이썬 / 자바스크립트 / C·C++)", "엑셀 · 워드 · 프레젠테이션", "3D 모델 뷰어"] },
        { layout: "content", title: "정리", bullets: ["설치 즉시 오프라인에서 동작", "개인정보는 기기 안에서만 처리", "대화부터 문서 제작까지 한 앱에서"] },
      ],
    },
    viewer3d: { name: null, data: null },
    openNote: null,
    openFile: null,
    openFileContent: null,
    openFileKind: null,
    openFileData: null,
    openFileB64: null,
    filesCache: [],
  },

  mount(root) {
    this.el = root;
    this.render();
  },

  startOpen: false, // Start menu visibility

  // ---------- app registry (hand-drawn line icons, DY PHONE style) ----------
  // Consistent 2-tone stroke set: warm accent #ff6b3d + cool #3d7bff on a
  // rounded dark tile, drawn from scratch (no OS clip-art).
  apps: [
    {
      id: "browser",
      name: "DY browser",
      svg: icon(`<circle cx="16" cy="16" r="10" stroke="#ff6b3d"/><ellipse cx="16" cy="16" rx="4.4" ry="10" stroke="#3d7bff"/><path d="M6.4 16h19.2" stroke="#3d7bff"/>`),
    },
    {
      id: "notes",
      name: "메모",
      svg: icon(`<rect x="8" y="6" width="16" height="20" rx="2.4" stroke="#3d7bff"/><path d="M12 12h8M12 16h8M12 20h5" stroke="#ff6b3d"/>`),
    },
    {
      id: "files",
      name: "파일",
      svg: icon(`<path d="M6 11V9a2 2 0 0 1 2-2h4l2.2 2.4H24a2 2 0 0 1 2 2V23a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" stroke="#ff6b3d"/><path d="M6 13h20" stroke="#3d7bff"/>`),
    },
    {
      id: "calc",
      name: "계산기",
      svg: icon(`<rect x="8" y="5" width="16" height="22" rx="2.4" stroke="#3d7bff"/><path d="M11 10h10" stroke="#ff6b3d"/><circle cx="12" cy="17" r="1.1" fill="#ff6b3d" stroke="none"/><circle cx="16" cy="17" r="1.1" fill="#ff6b3d" stroke="none"/><circle cx="20" cy="17" r="1.1" fill="#ff6b3d" stroke="none"/><circle cx="12" cy="22" r="1.1" fill="#ff6b3d" stroke="none"/><circle cx="16" cy="22" r="1.1" fill="#ff6b3d" stroke="none"/><circle cx="20" cy="22" r="1.1" fill="#ff6b3d" stroke="none"/>`),
    },
    {
      id: "code",
      name: "코드",
      svg: icon(`<path d="M12 11l-5 5 5 5" stroke="#3d7bff"/><path d="M20 11l5 5-5 5" stroke="#3d7bff"/><path d="M17.5 8l-3 16" stroke="#ff6b3d"/>`),
    },
    {
      id: "sheet",
      name: "표(엑셀)",
      svg: icon(`<rect x="6" y="7" width="20" height="18" rx="2.2" stroke="#35d07f"/><path d="M6 13h20M6 19h20M13 7v18M20 7v18" stroke="#35d07f"/>`),
    },
    {
      id: "doc",
      name: "문서(워드)",
      svg: icon(`<path d="M9 5h9l6 6v16a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 27V6.5A1.5 1.5 0 0 1 9 5Z" stroke="#3d7bff"/><path d="M18 5v6h6" stroke="#3d7bff"/><path d="M11 16h10M11 20h10M11 24h6" stroke="#ff6b3d"/>`),
    },
    {
      id: "slides",
      name: "프레젠테이션",
      svg: icon(`<rect x="5" y="7" width="22" height="14" rx="2" stroke="#ff6b3d"/><path d="M9 11h10M9 14.5h7" stroke="#3d7bff"/><path d="M16 21v3M11 25h10" stroke="#3d7bff"/>`),
    },
    {
      id: "viewer3d",
      name: "3D 뷰어",
      svg: icon(`<path d="M16 5l10 5.6v11L16 27 6 21.6v-11Z" stroke="#3d7bff"/><path d="M6 10.6 16 16l10-5.4M16 16v11" stroke="#ff6b3d"/>`),
    },
  ],
  appSvg(id) {
    return this.apps.find((a) => a.id === id)?.svg || "";
  },

  open(app) {
    this.app = app;
    this.render();
    if (app === "files") this.refreshFiles();
    if (app === "viewer3d") this.refreshFiles();
    // Opening the browser app pops the real browser straight away (no extra
    // "브라우저 화면 열기" tap needed).
    if (app === "browser") {
      const DYB = window.Capacitor?.Plugins?.DYBrowser;
      if (DYB) {
        const url = this.state.browser.url || "https://www.google.com";
        this.state.browser.url = url;
        DYB.open({ url }).catch(() => {});
      }
    }
    return `DY OS: '${this.appName(app)}' 열림.`;
  },
  home() {
    this.app = "home";
    this.render();
    return "DY OS: 홈 화면.";
  },
  appName(id) {
    return this.apps.find((a) => a.id === id)?.name || id;
  },

  // ---------- browser ----------
  // Two layers:
  //  • VISUAL: a real <iframe> so the page is fully interactive and its login
  //    session persists in the app's WebView cookie store (log in once, stay
  //    logged in). Some big sites refuse to be framed (X-Frame-Options) — for
  //    those the frame is blank and the user can switch to 읽기 mode.
  //  • AGENT: best-effort reader text via httpGet so the model can read content
  //    even when the frame can't be scripted (cross-origin).
  async browse(input) {
    this.app = "browser";
    let url = String(input || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      url = "https://www.google.com/search?q=" + encodeURIComponent(url);
    }
    const mode = this.state.browser.mode || "web";
    this.state.browser = { url, title: "", text: "불러오는 중…", loading: true, mode };
    this.render();

    // On device: open the real native WebView overlay (loads sites that block
    // framing, and keeps its own login session). Text is still extracted below
    // so the agent can read the page.
    const DYB = window.Capacitor?.Plugins?.DYBrowser;
    if (DYB && mode === "web") {
      try {
        await DYB.open({ url });
      } catch (e) {
        /* fall back to text below */
      }
    }

    try {
      const html = await httpGet(url);
      const { title, body } = htmlToText(html);
      this.state.browser.title = title;
      this.state.browser.text = body.slice(0, 4000);
      this.state.browser.loading = false;
      this.render();
      const preview = body.slice(0, 1500);
      return `열린 페이지: ${title || url}\n\n${preview}${body.length > 1500 ? "…" : ""}`;
    } catch (e) {
      // The frame may still render fine even if text extraction failed.
      this.state.browser.loading = false;
      this.state.browser.text = "(이 페이지의 텍스트는 추출하지 못했지만 브라우저 화면에는 표시돼요.)";
      this.render();
      return `브라우저에 페이지를 열었어요: ${url}\n(텍스트 읽기는 실패 — 화면에서 직접 확인하세요.)`;
    }
  },

  setBrowserMode(mode) {
    this.state.browser.mode = mode;
    this.render();
  },

  // ---------- notes ----------
  notes() {
    return LS.get(NOTES_KEY, {});
  },
  saveNote(title, body) {
    const n = this.notes();
    n[title] = body;
    LS.set(NOTES_KEY, n);
    this.app = "notes";
    this.state.openNote = title;
    this.render();
    return `메모 '${title}' 저장됨.`;
  },
  readNote(title) {
    const n = this.notes();
    if (!(title in n)) return `메모 '${title}'가 없어요.`;
    this.app = "notes";
    this.state.openNote = title;
    this.render();
    return `메모 '${title}':\n${n[title]}`;
  },
  listNotes() {
    const keys = Object.keys(this.notes());
    return keys.length ? "메모 목록: " + keys.join(", ") : "저장된 메모가 없어요.";
  },
  deleteNote(title) {
    const n = this.notes();
    delete n[title];
    LS.set(NOTES_KEY, n);
    if (this.state.openNote === title) this.state.openNote = null;
    this.render();
    return `메모 '${title}' 삭제됨.`;
  },

  // ---------- files (real DY OS folder on device; localStorage in a browser) ----------
  // The DYFiles plugin exposes the app's DYOS folder where the browser saves
  // downloads and the agent reads/writes. state.filesCache mirrors it for the UI.
  dyfiles() {
    return window.Capacitor?.Plugins?.DYFiles;
  },

  async refreshFiles() {
    const P = this.dyfiles();
    if (P) {
      try {
        this.state.filesCache = (await P.list()).files || [];
      } catch {
        this.state.filesCache = [];
      }
    } else {
      const f = LS.get(FILES_KEY, {});
      this.state.filesCache = Object.keys(f).map((name) => ({ name, size: (f[name] || "").length }));
    }
    if (this.app === "files") this.render();
    return this.state.filesCache;
  },

  async writeFile(name, content) {
    const P = this.dyfiles();
    if (P) {
      await P.writeText({ name, content });
    } else {
      const f = LS.get(FILES_KEY, {});
      f[name] = content;
      LS.set(FILES_KEY, f);
    }
    this.app = "files";
    this.state.openFile = name;
    this.state.openFileContent = content;
    await this.refreshFiles();
    return `파일 '${name}' 저장됨 (${content.length}자).`;
  },

  async readFile(name) {
    const P = this.dyfiles();
    this.app = "files";
    const { kind } = fileKind(name);
    this.state.openFile = name;
    this.state.openFileKind = kind;
    this.state.openFileContent = null;
    this.state.openFileData = null;
    this.state.openFileB64 = null;

    // Text-like: read utf-8 (also the only path the agent can use as text).
    if (kind === "code" || kind === "text") {
      let content;
      if (P) {
        try {
          content = (await P.readText({ name })).content;
        } catch {
          this.state.openFileKind = "binary";
          await this.refreshFiles();
          return `'${name}'를 텍스트로 읽을 수 없어요.`;
        }
      } else {
        const f = LS.get(FILES_KEY, {});
        content = f[name] ?? "";
      }
      this.state.openFileContent = content;
      await this.refreshFiles();
      return `파일 '${name}':\n${content}`;
    }

    // Everything else: read bytes (base64) for a rich preview.
    if (P) {
      try {
        const r = await P.readBase64({ name });
        this.state.openFileB64 = r.content;
        this.state.openFileData = `data:${r.mime};base64,${r.content}`;
      } catch (e) {
        this.state.openFileKind = "binary";
      }
    }
    await this.refreshFiles();
    const label = {
      image: "이미지", model: "3D 모델", audio: "오디오", video: "동영상",
      pdf: "PDF", docx: "Word 문서", sheet: "엑셀 시트", pptx: "PowerPoint", hwp: "한글 문서",
    }[kind] || "파일";
    return `'${name}' (${label})을 열었어요. DY OS 파일 화면에서 미리보기할 수 있어요.`;
  },

  async listFiles() {
    const files = await this.refreshFiles();
    if (!files.length) return "저장된 파일이 없어요.";
    return "파일 목록: " + files.map((f) => `${f.name}(${fmtSize(f.size)})`).join(", ");
  },

  // ---------- calculator ----------
  calc(expr) {
    this.app = "calc";
    const clean = String(expr || "");
    if (!/^[\d\s+\-*/%.()]+$/.test(clean)) {
      this.state.calc = { expr: clean, result: "지원하지 않는 문자" };
      this.render();
      return "계산식에 지원하지 않는 문자가 있어요.";
    }
    try {
      // eslint-disable-next-line no-new-func
      const r = Function(`"use strict"; return (${clean});`)();
      this.state.calc = { expr: clean, result: String(r) };
      this.render();
      return `${clean} = ${r}`;
    } catch (e) {
      this.state.calc = { expr: clean, result: "오류" };
      this.render();
      return `계산 오류: ${e.message}`;
    }
  },

  // ---------- a text snapshot of the current screen (for the agent) ----------
  screen() {
    switch (this.app) {
      case "home":
        return "DY OS 홈 화면. 앱: " + this.apps.map((a) => a.name).join(", ");
      case "browser": {
        const b = this.state.browser;
        return `DY OS 브라우저\nURL: ${b.url || "(없음)"}\n제목: ${b.title || "(없음)"}\n내용: ${(b.text || "").slice(0, 1200)}`;
      }
      case "notes": {
        const cur = this.state.openNote;
        const list = this.listNotes();
        return `DY OS 메모\n${list}` + (cur ? `\n\n열린 메모 '${cur}':\n${this.notes()[cur]}` : "");
      }
      case "files": {
        const cur = this.state.openFile;
        const names = this.state.filesCache.map((f) => `${f.name}(${fmtSize(f.size)})`).join(", ");
        const list = names || "저장된 파일이 없어요.";
        return (
          `DY OS 파일 (다운로드·에이전트 파일)\n${list}` +
          (cur && this.state.openFileContent != null
            ? `\n\n열린 파일 '${cur}':\n${this.state.openFileContent}`
            : "")
        );
      }
      case "calc": {
        const c = this.state.calc;
        return `DY OS 계산기\n${c.expr || "(입력 없음)"}${c.result ? " = " + c.result : ""}`;
      }
      default:
        return "DY OS";
    }
  },

  // ---------- rendering (phone style) ----------
  // DY OS looks like a phone: a home screen of app icons (4 per row), and each
  // app opens full-screen with a top app-bar and a bottom home button.
  render() {
    if (!this.el) return;
    this.el.innerHTML = "";
    const phone = document.createElement("div");
    phone.className = "dyos-phone";
    if (this.app === "home") phone.appendChild(this.homeScreen());
    else phone.appendChild(this.appFrame());
    this.el.appendChild(phone);
    this.tickClock();
  },

  homeScreen() {
    const home = document.createElement("div");
    home.className = "dyos-home";

    const bar = document.createElement("div");
    bar.className = "dyos-clockwrap";
    bar.innerHTML = `<div class="dyos-time" id="w11time"></div><div class="dyos-date" id="w11date"></div>`;
    home.appendChild(bar);

    // 4-icons-per-row app grid (phone home screen).
    const grid = document.createElement("div");
    grid.className = "dyos-grid";
    for (const a of this.apps) {
      const b = document.createElement("button");
      b.className = "dyos-app";
      b.innerHTML = `<span class="dyos-app-ico">${a.svg}</span><span class="dyos-app-name">${a.name}</span>`;
      b.onclick = () => this.open(a.id);
      grid.appendChild(b);
    }
    home.appendChild(grid);
    return home;
  },

  appFrame() {
    const frame = document.createElement("div");
    frame.className = "dyos-appframe";

    const bar = document.createElement("div");
    bar.className = "dyos-appbar";
    bar.innerHTML =
      `<button class="dyos-back" aria-label="뒤로">‹</button>` +
      `<span class="dyos-appbar-ico">${this.appSvg(this.app)}</span>` +
      `<span class="dyos-apptitle">${this.appName(this.app)}</span>`;
    bar.querySelector(".dyos-back").onclick = () => this.home();
    frame.appendChild(bar);

    const body = document.createElement("div");
    body.className = "dyos-appbody";
    body.appendChild(this[`view_${this.app}`]?.() ?? document.createTextNode(""));
    frame.appendChild(body);

    // Phone-style bottom nav: a single home pill returns to the app grid.
    const nav = document.createElement("div");
    nav.className = "dyos-navbar";
    const homeBtn = document.createElement("button");
    homeBtn.className = "dyos-navhome";
    homeBtn.setAttribute("aria-label", "홈");
    homeBtn.onclick = () => this.home();
    nav.appendChild(homeBtn);
    frame.appendChild(nav);
    return frame;
  },

  tickClock() {
    const t = this.el?.querySelector("#w11time");
    const d = this.el?.querySelector("#w11date");
    if (!t) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    t.textContent = `${hh}:${mm}`;
    if (d) d.textContent = now.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  },

  view_browser() {
    const b = this.state.browser;
    const wrap = document.createElement("div");
    wrap.className = "w11-browser";

    const form = document.createElement("form");
    form.className = "w11-omni";
    form.innerHTML =
      `<span class="w11-omni-ico">🔎</span>` +
      `<input placeholder="검색어 또는 https:// 주소 입력" />` +
      `<button type="button" class="w11-mode" title="웹/읽기 전환">${b.mode === "reader" ? "📄" : "🌐"}</button>` +
      `<button>이동</button>`;
    form.querySelector("input").value = b.url;
    form.onsubmit = (e) => {
      e.preventDefault();
      this.browse(form.querySelector("input").value);
    };
    form.querySelector(".w11-mode").onclick = () =>
      this.setBrowserMode(b.mode === "reader" ? "web" : "reader");
    wrap.appendChild(form);

    const DYB = window.Capacitor?.Plugins?.DYBrowser;
    if (b.mode === "web" && b.url && DYB) {
      // Native WebView overlay handles the actual page. Here (visible when the
      // overlay is closed) we offer to reopen it, plus a text preview.
      const openBtn = document.createElement("button");
      openBtn.className = "w11-open-native";
      openBtn.textContent = "🌐 브라우저 다시 열기";
      openBtn.onclick = () => DYB.open({ url: b.url });
      wrap.appendChild(openBtn);
      const page = document.createElement("div");
      page.className = "w11-page";
      if (b.title) {
        const h = document.createElement("div");
        h.className = "w11-page-title";
        h.textContent = b.title;
        page.appendChild(h);
      }
      const body = document.createElement("div");
      body.className = "w11-page-body";
      body.textContent = b.text || "";
      page.appendChild(body);
      wrap.appendChild(page);
    } else if (b.mode === "web" && b.url) {
      // Desktop fallback: iframe (may be blocked by some sites).
      const frame = document.createElement("iframe");
      frame.className = "w11-frame";
      frame.src = b.url;
      frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
      frame.setAttribute(
        "sandbox",
        "allow-forms allow-scripts allow-same-origin allow-popups allow-modals allow-storage-access-by-user-activation"
      );
      wrap.appendChild(frame);
    } else {
      // Reader mode — extracted text (works when framing is blocked).
      const page = document.createElement("div");
      page.className = "w11-page";
      if (b.title) {
        const h = document.createElement("div");
        h.className = "w11-page-title";
        h.textContent = b.title;
        page.appendChild(h);
      }
      const body = document.createElement("div");
      body.className = "w11-page-body";
      body.textContent = b.text || "주소를 입력하거나 에이전트에게 검색을 부탁하세요.";
      page.appendChild(body);
      wrap.appendChild(page);
    }
    return wrap;
  },

  view_notes() {
    const wrap = document.createElement("div");
    wrap.className = "w11-explorer";
    const notes = this.notes();
    const keys = Object.keys(notes);
    const list = document.createElement("div");
    list.className = "w11-list";
    if (!keys.length) list.innerHTML = `<p class="w11-empty">저장된 메모가 없어요.</p>`;
    for (const k of keys) {
      const item = document.createElement("button");
      item.className = "w11-list-item" + (this.state.openNote === k ? " open" : "");
      item.innerHTML = `<span class="w11-li-ico">📄</span><span class="w11-li-txt"><b>${k}</b><span>${(notes[k] || "").slice(0, 40)}</span></span>`;
      item.onclick = () => this.readNote(k);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    if (this.state.openNote && notes[this.state.openNote] != null) {
      const detail = document.createElement("div");
      detail.className = "w11-detail";
      detail.textContent = notes[this.state.openNote];
      wrap.appendChild(detail);
    }
    return wrap;
  },

  view_files() {
    const wrap = document.createElement("div");
    wrap.className = "w11-explorer";

    const bar = document.createElement("div");
    bar.className = "w11-files-bar";
    bar.innerHTML = `<span>📁 DY OS 폴더 · 다운로드/에이전트 파일</span>`;
    const refresh = document.createElement("button");
    refresh.className = "w11-refresh";
    refresh.textContent = "새로고침";
    refresh.onclick = () => this.refreshFiles();
    bar.appendChild(refresh);
    wrap.appendChild(bar);

    const files = this.state.filesCache || [];
    const list = document.createElement("div");
    list.className = "w11-list";
    if (!files.length) list.innerHTML = `<p class="w11-empty">폴더가 비어 있어요. DY browser에서 파일을 받으면 여기에 저장돼요.</p>`;
    for (const f of files) {
      const item = document.createElement("button");
      item.className = "w11-list-item" + (this.state.openFile === f.name ? " open" : "");
      item.innerHTML = `<span class="w11-li-ico">🗎</span><span class="w11-li-txt"><b>${f.name}</b><span>${fmtSize(f.size)}</span></span>`;
      item.onclick = () => this.readFile(f.name);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    if (this.state.openFile) wrap.appendChild(this.fileViewer());
    return wrap;
  },

  // Type-aware preview for the currently open file. Returns a container that may
  // be filled asynchronously (office/pdf libs load on demand).
  fileViewer() {
    const kind = this.state.openFileKind;
    const box = document.createElement("div");
    box.className = "w11-viewer";
    const data = this.state.openFileData;

    const loading = (msg) => {
      box.innerHTML = `<div class="w11-viewer-load">${msg}</div>`;
    };

    if (kind === "code" || kind === "text") {
      const pre = document.createElement("pre");
      pre.className = "w11-code";
      pre.textContent = this.state.openFileContent ?? "";
      box.appendChild(pre);
    } else if (kind === "image") {
      if (data) {
        const img = document.createElement("img");
        img.className = "w11-img";
        img.src = data;
        box.appendChild(img);
      } else loading("이미지를 불러올 수 없어요.");
    } else if (kind === "model") {
      loading("3D 뷰어 로딩 중…");
      loadLib("vendor/model-viewer.min.js")
        .then(() => {
          box.innerHTML = "";
          const mv = document.createElement("model-viewer");
          mv.className = "w11-model";
          mv.setAttribute("src", data);
          mv.setAttribute("camera-controls", "");
          mv.setAttribute("auto-rotate", "");
          mv.setAttribute("shadow-intensity", "1");
          box.appendChild(mv);
        })
        .catch((e) => loading(e.message));
    } else if (kind === "audio") {
      const a = document.createElement("audio");
      a.controls = true; a.src = data; a.className = "w11-media";
      box.appendChild(a);
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.controls = true; v.src = data; v.className = "w11-media";
      box.appendChild(v);
    } else if (kind === "pdf") {
      loading("PDF 여는 중…");
      this.renderPdf(box).catch((e) => loading("PDF 오류: " + e.message));
    } else if (kind === "docx") {
      loading("Word 문서 여는 중…");
      this.renderDocx(box).catch((e) => loading("Word 오류: " + e.message));
    } else if (kind === "sheet") {
      loading("엑셀 시트 여는 중…");
      this.renderSheet(box).catch((e) => loading("엑셀 오류: " + e.message));
    } else if (kind === "pptx") {
      loading("PowerPoint 여는 중…");
      this.renderPptx(box).catch((e) => loading("PPT 오류: " + e.message));
    } else if (kind === "archive") {
      loading("압축 파일 여는 중…");
      this.renderArchive(box).catch((e) => loading("압축 오류: " + e.message));
    } else if (kind === "hwp") {
      // No HWP preview engine on-device — show the standard unsupported card.
      this.unsupportedPreview(box);
    } else {
      // Unknown/binary extension: standard "no preview" card, plus an option to
      // try reading it as plain text (many source/config files have odd exts).
      this.unsupportedPreview(box);
      const btn = document.createElement("button");
      btn.className = "w11-open-native";
      btn.textContent = "📄 텍스트로 열어보기";
      btn.onclick = async () => {
        const P = this.dyfiles();
        if (!P) return;
        try {
          const c = (await P.readText({ name: this.state.openFile })).content;
          this.state.openFileKind = "text";
          this.state.openFileContent = c;
          this.render();
        } catch {
          box.innerHTML = `<div class="w11-viewer-load">텍스트로도 읽을 수 없어요 (바이너리 파일).</div>`;
        }
      };
      box.appendChild(btn);
    }
    return box;
  },

  // The "no preview available" card: file glyph + name + extension + notice.
  unsupportedPreview(box) {
    const name = this.state.openFile || "파일";
    const ext = String(name).split(".").pop().toLowerCase();
    const card = document.createElement("div");
    card.className = "w11-unsupported";
    card.innerHTML =
      `<div class="w11-unsupported-ico">${fileGlyph(ext)}</div>` +
      `<div class="w11-unsupported-name">${name}</div>` +
      `<div class="w11-unsupported-ext">.${ext} 파일</div>` +
      `<div class="w11-unsupported-msg">이 파일은 미리보기를 지원 안 합니다</div>`;
    box.appendChild(card);
  },

  async renderArchive(box) {
    const JSZip = await loadLib("vendor/jszip.js", "JSZip");
    const zip = await JSZip.loadAsync(b64ToBytes(this.state.openFileB64));
    const entries = Object.values(zip.files)
      .filter((f) => !f.dir)
      .sort((a, b) => a.name.localeCompare(b.name));
    box.innerHTML = `<div class="w11-sheet-name">📦 ${entries.length}개 항목</div>`;
    const list = document.createElement("div");
    list.className = "w11-arc-list";
    for (const f of entries.slice(0, 500)) {
      const size = f._data?.uncompressedSize ?? 0;
      const row = document.createElement("div");
      row.className = "w11-arc-row";
      row.innerHTML = `<span class="w11-arc-name">${f.name}</span><span class="w11-arc-size">${fmtSize(size)}</span>`;
      list.appendChild(row);
    }
    box.appendChild(list);
    if (entries.length > 500) {
      const more = document.createElement("div");
      more.className = "w11-viewer-load";
      more.textContent = `…외 ${entries.length - 500}개 더`;
      box.appendChild(more);
    }
  },

  async renderPdf(box) {
    const pdfjs = await loadLib("vendor/pdf.js", "pdfjsLib");
    pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.js";
    const doc = await pdfjs.getDocument({ data: b64ToBytes(this.state.openFileB64) }).promise;
    box.innerHTML = "";
    const pages = Math.min(doc.numPages, 20);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.3 });
      const canvas = document.createElement("canvas");
      canvas.className = "w11-pdf-page";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      box.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    }
    if (doc.numPages > pages) {
      const more = document.createElement("div");
      more.className = "w11-viewer-load";
      more.textContent = `…외 ${doc.numPages - pages}페이지 더`;
      box.appendChild(more);
    }
  },

  async renderDocx(box) {
    const mammoth = await loadLib("vendor/mammoth.js", "mammoth");
    const r = await mammoth.convertToHtml({ arrayBuffer: b64ToBytes(this.state.openFileB64).buffer });
    box.innerHTML = `<div class="w11-doc">${r.value}</div>`;
  },

  async renderSheet(box) {
    const XLSX = await loadLib("vendor/xlsx.js", "XLSX");
    const wb = XLSX.read(b64ToBytes(this.state.openFileB64), { type: "array" });
    box.innerHTML = "";
    wb.SheetNames.slice(0, 8).forEach((name) => {
      const h = document.createElement("div");
      h.className = "w11-sheet-name";
      h.textContent = name;
      box.appendChild(h);
      const holder = document.createElement("div");
      holder.className = "w11-sheet";
      holder.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[name]);
      box.appendChild(holder);
    });
  },

  async renderPptx(box) {
    const JSZip = await loadLib("vendor/jszip.js", "JSZip");
    const zip = await JSZip.loadAsync(b64ToBytes(this.state.openFileB64));
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    box.innerHTML = "";
    if (!slideNames.length) {
      box.innerHTML = `<div class="w11-viewer-load">슬라이드를 찾지 못했어요.</div>`;
      return;
    }
    for (let i = 0; i < slideNames.length; i++) {
      const xml = await zip.files[slideNames[i]].async("string");
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      const card = document.createElement("div");
      card.className = "w11-slide";
      card.innerHTML = `<div class="w11-slide-no">슬라이드 ${i + 1}</div><div>${texts.join("<br>") || "(텍스트 없음)"}</div>`;
      box.appendChild(card);
    }
  },

  view_calc() {
    const wrap = document.createElement("div");
    wrap.className = "w11-calc";
    const c = this.state.calc;
    wrap.innerHTML = `<div class="w11-calc-screen"><div class="w11-calc-expr">${c.expr || "0"}</div><div class="w11-calc-res">${c.result || ""}</div></div>`;
    const form = document.createElement("form");
    form.className = "w11-omni";
    form.innerHTML = `<input placeholder="예: (12000*1.1)/3" /><button>=</button>`;
    form.onsubmit = (e) => {
      e.preventDefault();
      this.calc(form.querySelector("input").value);
    };
    wrap.appendChild(form);
    return wrap;
  },

  // ---------- code (JavaScript / Python / C editor + runner) ----------
  // JavaScript runs natively; Python via Skulpt; C via JSCPP (both bundled).
  codeLangs: [
    { id: "js", name: "JavaScript", ext: "js", file: "script.js" },
    { id: "py", name: "Python", ext: "py", file: "script.py" },
    { id: "c", name: "C/C++", ext: "c", file: "main.c" },
  ],

  view_code() {
    const s = this.state.code;
    const wrap = document.createElement("div");
    wrap.className = "w11-code-app";

    // language selector (segmented)
    const seg = document.createElement("div");
    seg.className = "w11-seg";
    for (const L of this.codeLangs) {
      const b = document.createElement("button");
      b.className = "w11-seg-btn" + (s.lang === L.id ? " on" : "");
      b.textContent = L.name;
      b.onclick = () => { s.lang = L.id; this.render(); };
      seg.appendChild(b);
    }
    wrap.appendChild(seg);

    const ta = document.createElement("textarea");
    ta.className = "w11-editor";
    ta.spellcheck = false;
    ta.value = s.srcs[s.lang];
    ta.oninput = () => (s.srcs[s.lang] = ta.value);
    wrap.appendChild(ta);

    const lang = this.codeLangs.find((L) => L.id === s.lang);
    const bar = document.createElement("div");
    bar.className = "w11-actions";
    const run = document.createElement("button");
    run.className = "w11-btn primary";
    run.textContent = "▶ 실행";
    run.onclick = () => this.runCode();
    const save = document.createElement("button");
    save.className = "w11-btn";
    save.textContent = `💾 .${lang.ext} 저장`;
    save.onclick = async () => {
      const name = prompt("파일 이름", lang.file);
      if (name) { await this.writeFile(name, s.srcs[s.lang]); this.app = "code"; this.render(); }
    };
    bar.append(run, save);
    wrap.appendChild(bar);

    const out = document.createElement("pre");
    out.className = "w11-console";
    out.textContent = s.out || "출력이 여기에 표시됩니다.";
    wrap.appendChild(out);
    return wrap;
  },

  async runCode() {
    const s = this.state.code;
    const src = s.srcs[s.lang];
    if (s.lang === "js") return this.runJs(src);
    if (s.lang === "py") return this.runPy(src);
    if (s.lang === "c") return this.runC(src);
  },

  _setCodeOut(text) {
    const s = this.state.code;
    s.out = text || "(출력 없음)";
    this.app = "code";
    this.render();
    return s.out;
  },

  runJs(src) {
    const logs = [];
    const fakeConsole = {
      log: (...a) => logs.push(a.map(fmtVal).join(" ")),
      error: (...a) => logs.push("⚠ " + a.map(fmtVal).join(" ")),
      warn: (...a) => logs.push("⚠ " + a.map(fmtVal).join(" ")),
    };
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("console", `"use strict";\n${src}`);
      const ret = fn(fakeConsole);
      if (ret !== undefined) logs.push("→ " + fmtVal(ret));
    } catch (e) {
      logs.push("⚠ " + (e && e.message ? e.message : String(e)));
    }
    return this._setCodeOut(logs.join("\n"));
  },

  async runPy(src) {
    this._setCodeOut("Python 실행 중…");
    try {
      await loadLib("vendor/skulpt.min.js", "Sk");
      await loadLib("vendor/skulpt-stdlib.js"); // sets Sk.builtinFiles
      const out = [];
      const Sk = window.Sk;
      Sk.configure({
        output: (t) => out.push(t),
        read: (x) => {
          if (Sk.builtinFiles === undefined || Sk.builtinFiles.files[x] === undefined)
            throw new Error("모듈을 찾을 수 없어요: " + x);
          return Sk.builtinFiles.files[x];
        },
        __future__: Sk.python3,
      });
      await Sk.misceval.asyncToPromise(() =>
        Sk.importMainWithBody("<stdin>", false, src, true)
      );
      return this._setCodeOut(out.join("") || "(출력 없음)");
    } catch (e) {
      const msg = e && e.toString ? e.toString() : String(e);
      return this._setCodeOut("⚠ " + msg);
    }
  },

  async runC(src) {
    this._setCodeOut("C 실행 중…");
    try {
      const JSCPP = await loadLib("vendor/jscpp.js", "JSCPP");
      let out = "";
      const config = { stdio: { write: (s) => (out += s) } };
      const exitCode = JSCPP.run(src, "", config);
      out += `\n[프로그램 종료 코드 ${exitCode}]`;
      return this._setCodeOut(out || `[프로그램 종료 코드 ${exitCode}]`);
    } catch (e) {
      let msg = e && e.message ? e.message : String(e);
      // The on-device C/C++ interpreter runs <iostream> (cout/cin) reliably but
      // does not support printf/<string> — guide the user when they hit that.
      if (/cast failed|printf|no method/i.test(msg)) {
        msg += "\n\n※ 이 실행기는 printf 대신 <iostream>의 cout을 지원해요.\n   예: cout << \"결과 = \" << x << endl;";
      } else if (/cannot find library: string/i.test(msg)) {
        msg += "\n\n※ <string>은 아직 지원되지 않아요. char 배열이나 cout을 사용하세요.";
      }
      return this._setCodeOut("⚠ " + msg);
    }
  },

  // ---------- sheet (spreadsheet -> xlsx) ----------
  view_sheet() {
    const s = this.state.sheet;
    const wrap = document.createElement("div");
    wrap.className = "w11-sheet-app";
    const ribbon = document.createElement("div");
    ribbon.className = "w11-ribbon excel";
    ribbon.innerHTML = `<span class="w11-ribbon-tab">Excel</span><span class="w11-ribbon-info">${s.rows}행 × ${s.cols}열</span>`;
    wrap.appendChild(ribbon);
    const grid = document.createElement("div");
    grid.className = "w11-grid";
    grid.style.gridTemplateColumns = `28px repeat(${s.cols}, 1fr)`;
    grid.appendChild(cell("", "w11-gh"));
    for (let c = 0; c < s.cols; c++) grid.appendChild(cell(String.fromCharCode(65 + c), "w11-gh"));
    for (let r = 0; r < s.rows; r++) {
      grid.appendChild(cell(String(r + 1), "w11-gh"));
      for (let c = 0; c < s.cols; c++) {
        const key = `${r},${c}`;
        const inp = document.createElement("input");
        inp.className = "w11-gc";
        inp.value = s.data[key] || "";
        inp.oninput = () => (s.data[key] = inp.value);
        grid.appendChild(inp);
      }
    }
    wrap.appendChild(grid);
    const bar = document.createElement("div");
    bar.className = "w11-actions";
    const add = document.createElement("button");
    add.className = "w11-btn";
    add.textContent = "+ 행";
    add.onclick = () => { s.rows++; this.render(); };
    const save = document.createElement("button");
    save.className = "w11-btn primary";
    save.textContent = "💾 엑셀(.xlsx) 저장";
    save.onclick = () => this.saveSheet();
    bar.append(add, save);
    wrap.appendChild(bar);
    function cell(txt, cls) {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = txt;
      return d;
    }
    return wrap;
  },

  async saveSheet() {
    const s = this.state.sheet;
    const XLSX = await loadLib("vendor/xlsx.js", "XLSX");
    const aoa = [];
    for (let r = 0; r < s.rows; r++) {
      const row = [];
      for (let c = 0; c < s.cols; c++) row.push(s.data[`${r},${c}`] || "");
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const b64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
    const name = prompt("파일 이름", "표.xlsx") || "표.xlsx";
    const msg = await saveBinary(name, b64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    alert(msg);
  },

  // ---------- doc (text -> Word .docx / .txt) ----------
  view_doc() {
    const s = this.state.doc;
    const wrap = document.createElement("div");
    wrap.className = "w11-doc-app";
    const ribbon = document.createElement("div");
    ribbon.className = "w11-ribbon word";
    ribbon.innerHTML = `<span class="w11-ribbon-tab">Word</span><span class="w11-ribbon-info">${(s.body || "").length}자</span>`;
    wrap.appendChild(ribbon);
    const page = document.createElement("div");
    page.className = "w11-word-page";
    const title = document.createElement("input");
    title.className = "w11-doc-title";
    title.value = s.title;
    title.oninput = () => (s.title = title.value);
    page.appendChild(title);
    const ta = document.createElement("textarea");
    ta.className = "w11-editor word";
    ta.placeholder = "내용을 입력하세요…";
    ta.value = s.body;
    ta.oninput = () => (s.body = ta.value);
    page.appendChild(ta);
    wrap.appendChild(page);
    const bar = document.createElement("div");
    bar.className = "w11-actions";
    const t = document.createElement("button");
    t.className = "w11-btn";
    t.textContent = "💾 .txt 저장";
    t.onclick = async () => alert(await this.writeFile((s.title || "문서") + ".txt", s.body));
    const w = document.createElement("button");
    w.className = "w11-btn primary";
    w.textContent = "💾 Word(.docx) 저장";
    w.onclick = () => this.saveDocx();
    bar.append(t, w);
    wrap.appendChild(bar);
    return wrap;
  },

  async saveDocx() {
    const s = this.state.doc;
    const JSZip = await loadLib("vendor/jszip.js", "JSZip");
    const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const paras = (s.title ? [s.title] : [])
      .concat(String(s.body).split("\n"))
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`)
      .join("");
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    );
    zip.folder("_rels").file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    );
    zip.folder("word").file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`
    );
    const b64 = await zip.generateAsync({ type: "base64" });
    const name = prompt("파일 이름", (s.title || "문서") + ".docx") || "문서.docx";
    alert(await saveBinary(name, b64, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  },

  // ---------- presentation (PPT): on-screen designer + real .pptx export ----------
  slideThemes: [
    { name: "코발트", bg: "0B1220", panel: "16233F", title: "FFFFFF", accent: "3D7BFF", body: "C9D4E5" },
    { name: "선셋", bg: "1A0F14", panel: "3A1E12", title: "FFFFFF", accent: "FF6B3D", body: "F1DACE" },
    { name: "민트", bg: "0C1A15", panel: "123128", title: "FFFFFF", accent: "35D07F", body: "CFEBDD" },
    { name: "그레이프", bg: "150E22", panel: "2A1B45", title: "FFFFFF", accent: "9B6BFF", body: "DCD0F0" },
  ],

  view_slides() {
    const s = this.state.slides;
    const theme = this.slideThemes[s.theme] || this.slideThemes[0];
    const deck = s.deck;
    if (s.cur >= deck.length) s.cur = deck.length - 1;
    const cur = deck[s.cur];
    const wrap = document.createElement("div");
    wrap.className = "w11-slides-app";

    // Office-style ribbon
    const ribbon = document.createElement("div");
    ribbon.className = "w11-ribbon ppt";
    ribbon.innerHTML = `<span class="w11-ribbon-tab">프레젠테이션</span><span class="w11-ribbon-info">슬라이드 ${s.cur + 1} / ${deck.length}</span>`;
    wrap.appendChild(ribbon);

    // thumbnail strip
    const strip = document.createElement("div");
    strip.className = "w11-slide-strip";
    deck.forEach((sl, i) => {
      const th = document.createElement("button");
      th.className = "w11-thumb" + (i === s.cur ? " on" : "");
      th.innerHTML = `<span class="w11-thumb-no">${i + 1}</span><span class="w11-thumb-t">${xmlEsc(sl.title || "(제목)")}</span>`;
      th.onclick = () => { s.cur = i; this.render(); };
      strip.appendChild(th);
    });
    const addTh = document.createElement("button");
    addTh.className = "w11-thumb add";
    addTh.textContent = "＋";
    addTh.onclick = () => {
      deck.push({ layout: "content", title: "새 슬라이드", bullets: ["내용"] });
      s.cur = deck.length - 1;
      this.render();
    };
    strip.appendChild(addTh);
    wrap.appendChild(strip);

    // big slide preview
    wrap.appendChild(this.renderSlideCard(cur, theme, s.cur, deck.length));

    // editor
    const ed = document.createElement("div");
    ed.className = "w11-slide-editor";
    const tIn = document.createElement("input");
    tIn.className = "w11-doc-title";
    tIn.value = cur.title || "";
    tIn.placeholder = "슬라이드 제목";
    tIn.oninput = () => { cur.title = tIn.value; this.refreshSlidePreview(theme); this.syncStrip(); };
    ed.appendChild(tIn);

    if (cur.layout === "title") {
      const sub = document.createElement("input");
      sub.className = "w11-doc-title sub";
      sub.value = cur.subtitle || "";
      sub.placeholder = "부제목";
      sub.oninput = () => { cur.subtitle = sub.value; this.refreshSlidePreview(theme); };
      ed.appendChild(sub);
    } else {
      const ta = document.createElement("textarea");
      ta.className = "w11-editor sm";
      ta.placeholder = "한 줄에 항목 하나씩 입력하세요";
      ta.value = (cur.bullets || []).join("\n");
      ta.oninput = () => { cur.bullets = ta.value.split("\n"); this.refreshSlidePreview(theme); };
      ed.appendChild(ta);
    }
    wrap.appendChild(ed);

    // theme chips + actions
    const themes = document.createElement("div");
    themes.className = "w11-theme-row";
    this.slideThemes.forEach((t, i) => {
      const c = document.createElement("button");
      c.className = "w11-theme-chip" + (i === s.theme ? " on" : "");
      c.style.background = `#${t.accent}`;
      c.title = t.name;
      c.onclick = () => { s.theme = i; this.render(); };
      themes.appendChild(c);
    });
    wrap.appendChild(themes);

    const bar = document.createElement("div");
    bar.className = "w11-actions";
    const layoutBtn = document.createElement("button");
    layoutBtn.className = "w11-btn";
    layoutBtn.textContent = cur.layout === "title" ? "제목형 → 내용형" : "내용형 → 제목형";
    layoutBtn.onclick = () => {
      if (cur.layout === "title") { cur.layout = "content"; if (!cur.bullets) cur.bullets = ["내용"]; }
      else { cur.layout = "title"; if (!cur.subtitle) cur.subtitle = ""; }
      this.render();
    };
    const del = document.createElement("button");
    del.className = "w11-btn";
    del.textContent = "🗑 슬라이드 삭제";
    del.onclick = () => {
      if (deck.length <= 1) return alert("슬라이드가 최소 1장은 있어야 해요.");
      deck.splice(s.cur, 1);
      if (s.cur > 0) s.cur--;
      this.render();
    };
    const save = document.createElement("button");
    save.className = "w11-btn primary";
    save.textContent = "💾 PowerPoint(.pptx) 저장";
    save.onclick = () => this.savePptx();
    bar.append(layoutBtn, del, save);
    wrap.appendChild(bar);
    return wrap;
  },

  // Re-render just the preview card in place (avoids losing input focus on typing).
  refreshSlidePreview(theme) {
    const old = this.el?.querySelector(".w11-slide-card");
    if (!old) return;
    const s = this.state.slides;
    const fresh = this.renderSlideCard(s.deck[s.cur], theme, s.cur, s.deck.length);
    old.replaceWith(fresh);
  },
  syncStrip() {
    const s = this.state.slides;
    const t = this.el?.querySelectorAll(".w11-slide-strip .w11-thumb")[s.cur]?.querySelector(".w11-thumb-t");
    if (t) t.textContent = s.deck[s.cur].title || "(제목)";
  },

  // A PowerPoint-looking 16:9 slide preview.
  renderSlideCard(slide, theme, idx, total) {
    const card = document.createElement("div");
    card.className = "w11-slide-card";
    card.style.background = `#${theme.bg}`;
    const inner = document.createElement("div");
    inner.className = "w11-slide-inner";
    if (slide.layout === "title") {
      inner.innerHTML =
        `<div class="w11-slide-accent" style="background:#${theme.accent}"></div>` +
        `<div class="w11-slide-titlebig" style="color:#${theme.title}">${xmlEsc(slide.title || "")}</div>` +
        `<div class="w11-slide-sub" style="color:#${theme.body}">${xmlEsc(slide.subtitle || "")}</div>`;
    } else {
      const items = (slide.bullets || [])
        .filter((b) => b.trim() !== "")
        .map((b) => `<li style="color:#${theme.body}"><span style="color:#${theme.accent}">●</span>${xmlEsc(b)}</li>`)
        .join("");
      inner.innerHTML =
        `<div class="w11-slide-head" style="color:#${theme.title}">${xmlEsc(slide.title || "")}` +
        `<div class="w11-slide-rule" style="background:#${theme.accent}"></div></div>` +
        `<ul class="w11-slide-bullets">${items}</ul>`;
    }
    const no = document.createElement("div");
    no.className = "w11-slide-pageno";
    no.style.color = `#${theme.body}`;
    no.textContent = `${idx + 1} / ${total}`;
    inner.appendChild(no);
    card.appendChild(inner);
    return card;
  },

  async savePptx() {
    const s = this.state.slides;
    const theme = this.slideThemes[s.theme] || this.slideThemes[0];
    try {
      const b64 = await this.buildPptx(s.deck, theme);
      const name = prompt("파일 이름", "프레젠테이션.pptx") || "프레젠테이션.pptx";
      alert(await saveBinary(name, b64, "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
    } catch (e) {
      alert("PPT 저장 실패: " + (e && e.message ? e.message : e));
    }
  },

  // Build a valid .pptx (OOXML) from the deck. Each slide carries its own text
  // boxes with direct formatting so it opens cleanly in PowerPoint / Keynote.
  async buildPptx(deck, theme) {
    const JSZip = await loadLib("vendor/jszip.js", "JSZip");
    const zip = new JSZip();
    const N = deck.length;
    const W = 12192000, H = 6858000; // 16:9 EMU

    // slide XML
    const runP = (text, sz, colorHex, bullet, bold) => {
      const pPr = bullet
        ? `<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`
        : `<a:pPr algn="l"/>`;
      return (
        `<a:p>${pPr}<a:r><a:rPr lang="ko-KR" sz="${sz}" b="${bold ? 1 : 0}" dirty="0">` +
        `<a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill></a:rPr>` +
        `<a:t>${xmlEsc(text)}</a:t></a:r></a:p>`
      );
    };
    const txBox = (id, name, x, y, cx, cy, bodyXml) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${bodyXml}</p:txBody></p:sp>`;
    const rect = (id, x, y, cx, cy, colorHex) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;

    const slideXml = (slide) => {
      let shapes = "";
      if (slide.layout === "title") {
        shapes += rect(10, 685800, 3352800, 2743200, 96000, theme.accent);
        shapes += txBox(2, "Title", 685800, 2057400, W - 1371600, 1143000,
          runP(slide.title || "", 5400, theme.title, false, true));
        shapes += txBox(3, "Subtitle", 685800, 3505200, W - 1371600, 914400,
          runP(slide.subtitle || "", 2400, theme.body, false, false));
      } else {
        shapes += txBox(2, "Title", 685800, 411480, W - 1371600, 1005840,
          runP(slide.title || "", 4000, theme.title, false, true));
        shapes += rect(11, 685800, 1417320, 2438400, 68580, theme.accent);
        const bullets = (slide.bullets || []).filter((b) => b.trim() !== "");
        const body = bullets.length
          ? bullets.map((b) => runP(b, 2600, theme.body, true, false)).join("")
          : runP(" ", 2600, theme.body, false, false);
        shapes += txBox(3, "Body", 685800, 1706880, W - 1371600, 4351338, body);
      }
      return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
        `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
        shapes +
        `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`
      );
    };

    // static parts
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    zip.file("[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      deck.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
      `</Types>`);

    zip.folder("_rels").file(".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);

    const ppt = zip.folder("ppt");
    // presentation.xml: rId1=master, rId2..=slides
    ppt.file("presentation.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${deck.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);

    ppt.folder("_rels").file("presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      deck.map((_, i) => `<Relationship Id="rId${2 + i}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${2 + N}" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`);

    // slides
    const slidesDir = ppt.folder("slides");
    const slidesRels = slidesDir.folder("_rels");
    deck.forEach((sl, i) => {
      slidesDir.file(`slide${i + 1}.xml`, slideXml(sl));
      slidesRels.file(`slide${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
    });

    // slide master
    const masters = ppt.folder("slideMasters");
    masters.file("slideMaster1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
      `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>` +
      `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2600"/></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`);
    masters.folder("_rels").file("slideMaster1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`);

    // slide layout (blank)
    const layouts = ppt.folder("slideLayouts");
    layouts.file("slideLayout1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">` +
      `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`);
    layouts.folder("_rels").file("slideLayout1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);

    // theme
    ppt.folder("theme").file("theme1.xml", this._pptxTheme(theme));

    return zip.generateAsync({ type: "base64" });
  },

  _pptxTheme(theme) {
    const a = theme.accent, bg = theme.bg;
    const clr = (v) => `<a:srgbClr val="${v}"/>`;
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="DY">` +
      `<a:themeElements><a:clrScheme name="DY">` +
      `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
      `<a:dk2>${clr(bg)}</a:dk2><a:lt2>${clr("EEEEEE")}</a:lt2>` +
      `<a:accent1>${clr(a)}</a:accent1><a:accent2>${clr("FF6B3D")}</a:accent2><a:accent3>${clr("35D07F")}</a:accent3>` +
      `<a:accent4>${clr("9B6BFF")}</a:accent4><a:accent5>${clr("3D7BFF")}</a:accent5><a:accent6>${clr("F5C542")}</a:accent6>` +
      `<a:hlink>${clr("3D7BFF")}</a:hlink><a:folHlink>${clr("9B6BFF")}</a:folHlink></a:clrScheme>` +
      `<a:fontScheme name="DY"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="DY">` +
      `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
      `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
      `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
      `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
      `</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
    );
  },

  // ---------- 3D viewer ----------
  view_viewer3d() {
    const s = this.state.viewer3d;
    const wrap = document.createElement("div");
    wrap.className = "w11-3d-app";
    const pick = document.createElement("div");
    pick.className = "w11-3d-pick";
    const models = (this.state.filesCache || []).filter((f) => /\.(glb|gltf)$/i.test(f.name));
    if (!models.length) {
      pick.innerHTML = `<p class="w11-empty">폴더에 3D 파일(.glb/.gltf)이 없어요. DY browser에서 받아보세요.</p>`;
    }
    models.forEach((f) => {
      const b = document.createElement("button");
      b.className = "w11-btn" + (s.name === f.name ? " primary" : "");
      b.textContent = "📦 " + f.name;
      b.onclick = () => this.open3d(f.name);
      pick.appendChild(b);
    });
    wrap.appendChild(pick);
    if (s.data) {
      const holder = document.createElement("div");
      holder.className = "w11-3d-stage";
      loadLib("vendor/model-viewer.min.js").then(() => {
        const mv = document.createElement("model-viewer");
        mv.setAttribute("src", s.data);
        mv.setAttribute("camera-controls", "");
        mv.setAttribute("auto-rotate", "");
        mv.style.width = "100%";
        mv.style.height = "100%";
        holder.appendChild(mv);
      });
      wrap.appendChild(holder);
    }
    this.refreshFiles();
    return wrap;
  },

  async open3d(name) {
    const P = this.dyfiles();
    if (!P) return;
    try {
      const r = await P.readBase64({ name });
      this.state.viewer3d = { name, data: `data:${r.mime};base64,${r.content}` };
      this.render();
    } catch (e) {
      alert("열 수 없어요: " + e.message);
    }
  },
};

function fmtVal(v) {
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
