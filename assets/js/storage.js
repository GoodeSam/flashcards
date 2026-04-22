// localStorage 持久化（账号命名空间版）
// 所有 key = fc:u:<userId>:tier:<N>，由 auth.userKey() 拼接。

import { userKey, getCurrentId, getUser, listUsers, createUser } from "./auth.js";
import { getTimeScale, setTimeScale } from "./srs.js";

const SCHEMA_VERSION = 1;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function todayStr() {
  // Under test-mode (scale>1), a "day" compresses — use an hour/minute bucket
  // so the newToday / reviewedToday counters reset on the same accelerated cadence.
  const scale = getTimeScale();
  if (scale > 1) {
    const bucketMs = 86_400_000 / scale; // e.g. 24× → 1h buckets
    const bucket = Math.floor(Date.now() / bucketMs);
    return `s${scale}:${bucket}`;
  }
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

function tierKey(userId, tier) {
  return userKey(userId, `tier:${tier}`);
}

function requireUserId() {
  const id = getCurrentId();
  if (!id) throw new Error("未登录");
  return id;
}

/** 加载某档某用户的进度，损坏自动重置。 */
export function load(tier, userId = requireUserId()) {
  const raw = localStorage.getItem(tierKey(userId, tier));
  if (!raw) return defaultState(tier);
  try {
    const obj = JSON.parse(raw);
    const { checksum, ...payload } = obj;
    if (checksum && checksum !== fnv1a(JSON.stringify(payload))) {
      console.warn(`[storage] u=${userId} tier${tier} checksum mismatch — using anyway`);
    }
    if ((payload.version || 0) !== SCHEMA_VERSION) {
      console.warn(`[storage] u=${userId} tier${tier} version mismatch, resetting`);
      return defaultState(tier);
    }
    if (payload.today !== todayStr()) {
      payload.today = todayStr();
      payload.stats = { newToday: 0, reviewedToday: 0 };
    }
    return payload;
  } catch (e) {
    console.error(`[storage] u=${userId} tier${tier} parse failed, resetting`, e);
    return defaultState(tier);
  }
}

export function save(state, userId = requireUserId()) {
  state.version = SCHEMA_VERSION;
  state.lastModified = new Date().toISOString();
  const payload = JSON.stringify(state);
  const checksum = fnv1a(payload);
  localStorage.setItem(tierKey(userId, state.tier), JSON.stringify({ ...state, checksum }));
}

// ── Per-user settings ────────────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({
  autoPlayAudio: "off", // "off" | "new" | "all"
  testTimeScale: 1,     // 1 = real time; 24 = 1 day → 1 hour
});

function settingsKey(userId) {
  return userKey(userId, "settings");
}

export function loadSettings(userId = requireUserId()) {
  try {
    const raw = localStorage.getItem(settingsKey(userId));
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial, userId = requireUserId()) {
  const merged = { ...loadSettings(userId), ...partial };
  localStorage.setItem(settingsKey(userId), JSON.stringify(merged));
  setTimeScale(merged.testTimeScale || 1);
  return merged;
}

/** Load current user's settings AND apply side-effects (SRS time scale). */
export function applySettings(userId = requireUserId()) {
  const s = loadSettings(userId);
  setTimeScale(s.testTimeScale || 1);
  return s;
}

export function bumpStats(state, kind) {
  if (state.today !== todayStr()) {
    state.today = todayStr();
    state.stats = { newToday: 0, reviewedToday: 0 };
  }
  if (kind === "new") state.stats.newToday += 1;
  else if (kind === "review") state.stats.reviewedToday += 1;
}

// ── Export / Import ──────────────────────────────────────────────────

/** 导出：当前用户的所有档进度 + 用户元数据。 */
export function exportAll(userId = requireUserId()) {
  const user = getUser(userId);
  const dump = {
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    user: user ? { id: user.id, name: user.name, hint: user.hint, ph: user.ph } : null,
    settings: loadSettings(userId),
    tiers: {},
  };
  for (let t = 1; t <= 7; t += 1) {
    const raw = localStorage.getItem(tierKey(userId, t));
    if (raw) dump.tiers[t] = JSON.parse(raw);
  }
  return JSON.stringify(dump, null, 2);
}

/**
 * 导入：把备份恢复到指定用户名（不存在则创建）。
 *  - 若同名账号存在 → 合并：每张卡按 lastModified 取较新者
 *  - 若不存在 → 创建新账号并恢复全部进度
 * 返回 { user, tiersRestored, mode: 'new' | 'merge' }。
 */
export async function importAll(jsonText, opts = {}) {
  const obj = JSON.parse(jsonText);
  if (!obj || obj.schema !== SCHEMA_VERSION) {
    throw new Error(`schema 不兼容（备份 v${obj?.schema}，当前 v${SCHEMA_VERSION}）`);
  }
  if (!obj.user || !obj.user.name) {
    throw new Error("备份缺用户信息");
  }
  const targetName = opts.renameTo || obj.user.name;

  let user = listUsers().find((u) => u.name.toLowerCase() === targetName.toLowerCase());
  let mode = "new";
  if (!user) {
    user = await createUser({ name: targetName, passphrase: null, hint: obj.user.hint });
    // 把备份里的口令哈希照搬过来（用户原口令仍可登录）
    if (obj.user.ph) {
      const users = listUsers();
      const u = users.find((x) => x.id === user.id);
      u.ph = obj.user.ph;
      localStorage.setItem("fc:users", JSON.stringify(users));
    }
  } else {
    mode = "merge";
  }

  // Restore settings (overwrite for new accounts; merge for existing)
  if (obj.settings) {
    if (mode === "new") {
      saveSettings(obj.settings, user.id);
    } else {
      saveSettings(obj.settings, user.id); // partial-merge happens inside saveSettings
    }
  }

  let tiersRestored = 0;
  for (const [t, payload] of Object.entries(obj.tiers || {})) {
    const tierNum = Number(t);
    if (mode === "new") {
      localStorage.setItem(tierKey(user.id, tierNum), JSON.stringify(payload));
      tiersRestored += 1;
    } else {
      // merge: 同卡按更新时间取较新
      const existing = load(tierNum, user.id);
      const incoming = payload;
      for (const [cardId, inState] of Object.entries(incoming.cards || {})) {
        const exState = existing.cards[cardId];
        const inMs = inState.history?.length
          ? inState.history[inState.history.length - 1].ts
          : 0;
        const exMs = exState?.history?.length
          ? exState.history[exState.history.length - 1].ts
          : 0;
        if (!exState || inMs > exMs) {
          existing.cards[cardId] = inState;
        }
      }
      // stats 取最大
      existing.stats.newToday = Math.max(existing.stats.newToday, incoming.stats?.newToday || 0);
      existing.stats.reviewedToday = Math.max(
        existing.stats.reviewedToday,
        incoming.stats?.reviewedToday || 0,
      );
      save(existing, user.id);
      tiersRestored += 1;
    }
  }

  return { user, tiersRestored, mode };
}

/** 触发当前用户备份 .json 文件下载。 */
export function downloadExport(userId = requireUserId()) {
  const user = getUser(userId);
  const blob = new Blob([exportAll(userId)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `flashcards-${user?.name || "backup"}-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
