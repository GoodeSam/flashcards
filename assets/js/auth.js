// 本地账号管理 (方案 C)
// 不是真正的认证 — 仅用账号名将每用户进度隔离在 localStorage 命名空间内。
// 可选口令仅做"软门"，防同设备其他人误操作；同设备下纯客户端无法防破解。

const KEY_USERS = "fc:users";
const KEY_LAST = "fc:lastUser";       // localStorage：上次登录的用户 id
const KEY_CURRENT = "fc:current";     // sessionStorage：本会话的当前用户 id
const KEY_LEGACY_PREFIX = "fc:tier:"; // 旧版未命名空间的 key，可迁移

// ── User CRUD ────────────────────────────────────────────────────────
export function listUsers() {
  try {
    return JSON.parse(localStorage.getItem(KEY_USERS) || "[]");
  } catch {
    return [];
  }
}

export function findUser(predicate) {
  return listUsers().find(predicate);
}

export function getUser(id) {
  return findUser((u) => u.id === id);
}

function saveUsers(users) {
  localStorage.setItem(KEY_USERS, JSON.stringify(users));
}

async function hashPassphrase(pw) {
  if (!pw) return null;
  const data = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function genId() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return "u_" + Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createUser({ name, passphrase, hint }) {
  name = (name || "").trim();
  if (!name) throw new Error("用户名不能为空");
  if (name.length > 24) throw new Error("用户名最多 24 字符");
  const users = listUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("此用户名已存在");
  }
  const user = {
    id: genId(),
    name,
    hint: (hint || "").slice(0, 80),
    ph: await hashPassphrase(passphrase),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

export async function verifyPassphrase(user, passphrase) {
  if (!user.ph) return true; // 无口令账户直接通过
  const h = await hashPassphrase(passphrase);
  return h === user.ph;
}

export async function changePassphrase(userId, newPassphrase) {
  const users = listUsers();
  const u = users.find((x) => x.id === userId);
  if (!u) throw new Error("用户不存在");
  u.ph = await hashPassphrase(newPassphrase);
  saveUsers(users);
}

export function deleteUser(userId) {
  // 删除用户记录 + 该用户所有 tier 进度
  const users = listUsers().filter((u) => u.id !== userId);
  saveUsers(users);
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.startsWith(`fc:u:${userId}:`)) {
      localStorage.removeItem(k);
      i -= 1;
    }
  }
  if (localStorage.getItem(KEY_LAST) === userId) localStorage.removeItem(KEY_LAST);
  if (sessionStorage.getItem(KEY_CURRENT) === userId) sessionStorage.removeItem(KEY_CURRENT);
}

// ── Session ──────────────────────────────────────────────────────────
export function setCurrent(userId) {
  sessionStorage.setItem(KEY_CURRENT, userId);
  localStorage.setItem(KEY_LAST, userId);
}

export function getCurrentId() {
  return sessionStorage.getItem(KEY_CURRENT);
}

export function getCurrent() {
  const id = getCurrentId();
  return id ? getUser(id) : null;
}

export function logout() {
  sessionStorage.removeItem(KEY_CURRENT);
}

/** 自动登录：上次用户存在且无口令 → 直接登录 */
export function tryAutoLogin() {
  if (getCurrentId()) return getCurrent();
  const lastId = localStorage.getItem(KEY_LAST);
  if (!lastId) return null;
  const u = getUser(lastId);
  if (u && !u.ph) {
    setCurrent(u.id);
    return u;
  }
  return null;
}

/** 任何受保护页都先调用：拿不到当前用户就返回 false（调用方负责重定向） */
export function requireAuth() {
  return tryAutoLogin() || getCurrent();
}

// ── Per-user storage key ─────────────────────────────────────────────
export function userKey(userId, suffix) {
  return `fc:u:${userId}:${suffix}`;
}

// ── Pre-namespace 迁移 ───────────────────────────────────────────────
export function hasLegacyData() {
  for (let t = 1; t <= 7; t += 1) {
    if (localStorage.getItem(`${KEY_LEGACY_PREFIX}${t}`)) return true;
  }
  return false;
}

/** 把 fc:tier:N 旧数据搬迁到 fc:u:<userId>:tier:N，并删除旧 key */
export function migrateLegacyTo(userId) {
  let count = 0;
  for (let t = 1; t <= 7; t += 1) {
    const k = `${KEY_LEGACY_PREFIX}${t}`;
    const v = localStorage.getItem(k);
    if (v) {
      localStorage.setItem(userKey(userId, `tier:${t}`), v);
      localStorage.removeItem(k);
      count += 1;
    }
  }
  return count;
}
