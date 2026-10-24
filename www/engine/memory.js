// Local-first, markdown-style persistent memory.
//
// Local-first agent memory, stored like markdown notes. On mobile we keep it in
// localStorage for portability (works in browser dev and in the Capacitor
// WebView), exposed as a simple key -> note store plus a rolling digest that
// gets injected into the system prompt.

const KEY = "dyagent.memory.v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function save(notes) {
  localStorage.setItem(KEY, JSON.stringify(notes));
}

export const Memory = {
  all() {
    return load();
  },

  // Append a note. `topic` groups related notes; overwriting the same topic
  // replaces it (so the model can update facts instead of duplicating them).
  remember(topic, content) {
    const notes = load();
    const idx = notes.findIndex((n) => n.topic === topic);
    const note = { topic, content, ts: Date.now() };
    if (idx >= 0) notes[idx] = note;
    else notes.push(note);
    save(notes);
    return note;
  },

  forget(topic) {
    const notes = load().filter((n) => n.topic !== topic);
    save(notes);
  },

  clear() {
    save([]);
  },

  // Compact markdown digest injected into the system prompt.
  digest(limit = 40) {
    const notes = load().slice(-limit);
    if (!notes.length) return "";
    return notes.map((n) => `- **${n.topic}**: ${n.content}`).join("\n");
  },
};
