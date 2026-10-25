// Small persistent store for this browser: settings, drafts and saved sheets. Storage can be
// unavailable (private windows, blocked site data), so every access is guarded and the app keeps
// working from memory.

const PREFIX = 'terrasim.';
const memory = new Map();
const listeners = new Map();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch {}
  return memory.has(key) ? memory.get(key) : fallback;
}

function write(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  for (const fn of listeners.get(key) || []) fn(value);
}

export const store = {
  get: read,
  set: write,
  update(key, fallback, fn) { const v = fn(read(key, fallback)); write(key, v); return v; },
  on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key).delete(fn);
  },
};

export const settings = {
  get units() { return read('units', 'imperial'); },
  set units(v) { write('units', v); },
};
