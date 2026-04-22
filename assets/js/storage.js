// localStorage persistence (v2 plan §8) — schema v1 + checksum + export/import.

const SCHEMA_VERSION = 1;
const KEY_PREFIX = "fc:tier:";

/** Synchronous fnv-1a 32-bit (good-enough integrity check). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState(tier) {
  return {
    version: SCHEMA_VERSION,
    lastModified: new Date().toISOString(),
    tier,
    today: todayStr(),
    stats: { newToday: 0, reviewedToday: 0 },
    cards: {},
  };
}

function key(tier) {
  return `${KEY_PREFIX}${tier}`;
}

/** Load tier state, repair if corrupted. */
export function load(tier) {
  const raw = localStorage.getItem(key(tier));
  if (!raw) return defaultState(tier);
  try {
    const obj = JSON.parse(raw);
    const { checksum, ...payload } = obj;
    if (checksum && checksum !== fnv1a(JSON.stringify(payload))) {
      console.warn(`[storage] tier${tier} checksum mismatch — using anyway`);
    }
    if ((payload.version || 0) !== SCHEMA_VERSION) {
      console.warn(`[storage] tier${tier} version mismatch, resetting`);
      return defaultState(tier);
    }
    // Roll over per-day stats
    if (payload.today !== todayStr()) {
      payload.today = todayStr();
      payload.stats = { newToday: 0, reviewedToday: 0 };
    }
    return payload;
  } catch (e) {
    console.error(`[storage] tier${tier} parse failed, resetting`, e);
    return defaultState(tier);
  }
}

/** Save tier state with checksum + last-modified bump. */
export function save(state) {
  state.version = SCHEMA_VERSION;
  state.lastModified = new Date().toISOString();
  const payload = JSON.stringify(state);
  const checksum = fnv1a(payload);
  localStorage.setItem(key(state.tier), JSON.stringify({ ...state, checksum }));
}

/** Bump per-day counters. */
export function bumpStats(state, kind) {
  if (state.today !== todayStr()) {
    state.today = todayStr();
    state.stats = { newToday: 0, reviewedToday: 0 };
  }
  if (kind === "new") state.stats.newToday += 1;
  else if (kind === "review") state.stats.reviewedToday += 1;
}

/** Export ALL tier states as one JSON blob. */
export function exportAll() {
  const dump = {
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tiers: {},
  };
  for (let t = 1; t <= 7; t += 1) {
    const raw = localStorage.getItem(key(t));
    if (raw) dump.tiers[t] = JSON.parse(raw);
  }
  return JSON.stringify(dump, null, 2);
}

/** Import a previously exported blob. Returns count of tiers restored. */
export function importAll(jsonText) {
  const obj = JSON.parse(jsonText);
  if (!obj || obj.schema !== SCHEMA_VERSION) {
    throw new Error(`Schema mismatch (got ${obj?.schema}, need ${SCHEMA_VERSION})`);
  }
  let count = 0;
  for (const [t, payload] of Object.entries(obj.tiers || {})) {
    localStorage.setItem(key(Number(t)), JSON.stringify(payload));
    count += 1;
  }
  return count;
}

/** Trigger a download of the export blob. */
export function downloadExport() {
  const blob = new Blob([exportAll()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `flashcards-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
