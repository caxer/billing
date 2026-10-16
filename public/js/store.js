// 資料層：對外只提供幾個動作，底下換成本機端點或 GitHub Contents API。
//
// 檔案配置（私人 repo 或 local/data/）
//   settings.json              分類、人物、每月額度
//   records/2026-10.json       該月所有紀錄
//
// GitHub 沒有推播，「即時」靠輪詢檔案 sha。寫入必須帶目前 sha，
// 兩台手機同時改同個月會拿到 409，由呼叫端重試。

import { removeStored } from './storage.js';
import { validDate } from './calc.js';
import { validMonth, validateHistory, GROUPS } from './billing.js';
import './link-key.js';
import { normalizeDataCredentials } from './data-repo.js';

const GITHUB_API = 'https://api.github.com';

export const isLocal = () =>
  ['127.0.0.1', 'localhost'].includes(location.hostname);

let session = null; // { owner, repo, branch, token }，只放記憶體

function validSession(value) {
  return value && ['owner', 'repo', 'token'].every((key) => typeof value[key] === 'string' && value[key].trim()) &&
    (value.branch === undefined || typeof value.branch === 'string');
}

/** 舊版留下的明文登入與 Face ID 設定，改用專屬連結後一律清除。 */
export function clearLegacy() {
  for (const key of ['spa-session', 'spa-biometric']) {
    removeStored(key);
    removeStored(key, 'sessionStorage');
  }
  removeStored('spa-skip-auto-biometric', 'sessionStorage');
}

function contentsUrl(path) {
  if (!session) throw new Error('尚未解鎖');
  const base = `${GITHUB_API}/repos/${encodeURIComponent(session.owner)}/${encodeURIComponent(session.repo)}/contents/${path}`;
  return session.branch ? `${base}?ref=${encodeURIComponent(session.branch)}` : base;
}

/* ---------- 登入 ---------- */

export const SECRET_CONTEXT = 'billing/secret/v2';

/** 用專屬連結的金鑰（CryptoKey）解開 secret.json 裡的 token。 */
export async function unlock(key) {
  if (isLocal()) {
    session = { local: true };
    return;
  }
  const res = await fetch('secret.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('找不到 secret.json');
  const box = await res.json();
  if (box?.v !== 2 || !Array.isArray(box.slots)) throw new Error('網站尚未改用專屬連結，請在電腦執行 npm run link 後重新發布。');
  const unlocked = JSON.parse(await LinkKey.openAny(key, box.slots, SECRET_CONTEXT));
  if (!validSession(unlocked)) throw new Error('登入設定格式錯誤');
  session = normalizeDataCredentials(unlocked);
}

export function lock() {
  session = null;
}

/* ---------- 底層讀寫 ---------- */

async function readFile(path) {
  if (isLocal()) {
    const res = await fetch(`/api/data/${path}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`本機讀取失敗（${res.status}）`);
    return { text: await res.text(), sha: res.headers.get('ETag') };
  }

  const res = await fetch(contentsUrl(path), {
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub 拒絕存取，token 可能失效');
  }
  if (!res.ok) throw new Error(`GitHub 讀取失敗（${res.status}）`);
  const data = await res.json();
  return { text: decodeBase64(data.content), sha: data.sha };
}

async function writeFile(path, text, sha) {
  if (isLocal()) {
    const res = await fetch(`/api/data/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(sha ? { 'If-Match': sha } : { 'If-None-Match': '*' }) },
      body: text,
    });
    if (res.status === 409) {
      const err = new Error('conflict');
      err.conflict = true;
      throw err;
    }
    if (!res.ok) throw new Error(`本機寫入失敗（${res.status}）`);
    return;
  }

  const payload = { message: `更新 ${path}`, content: encodeBase64(text) };
  if (sha) payload.sha = sha;
  if (session.branch) payload.branch = session.branch;

  const res = await fetch(contentsUrl(path).split('?')[0], {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 409 || res.status === 422) {
    const err = new Error('conflict');
    err.conflict = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub 拒絕寫入，token 可能失效');
  }
  if (!res.ok) throw new Error(`GitHub 寫入失敗（${res.status}）`);
}

function decodeBase64(b64) {
  const clean = b64.replace(/\s/g, '');
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/* ---------- 記錄 ---------- */

const emptyMonth = (month) => ({ month, items: [] });

export function validateItems(items, month) {
  const ids = new Set();
  if (!Array.isArray(items)) throw new Error(`${month} 的資料格式損毀`);
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !it.id || ids.has(it.id) ||
        !['expense', 'income'].includes(it.type) || !Number.isSafeInteger(it.amount) || it.amount <= 0 ||
        typeof it.date !== 'string' || !validDate(it.date) || !it.date.startsWith(`${month}-`) ||
        typeof it.category !== 'string' || !it.category.trim() ||
        (it.by !== undefined && typeof it.by !== 'string') ||
        (it.note !== undefined && typeof it.note !== 'string') ||
        (it.billingGroup !== undefined && !GROUPS.includes(it.billingGroup)) ||
        (it.createdAt !== undefined && typeof it.createdAt !== 'string')) {
      throw new Error(`${month} 的資料格式損毀`);
    }
    ids.add(it.id);
  }
}

/** 讀某個月。回傳 { month, items, sha }，沒有資料時 items 為空陣列。 */
export async function loadMonth(month) {
  const path = `records/${month}.json`;
  const found = await readFile(path);
  if (!found) return { ...emptyMonth(month), sha: null };
  try {
    const data = JSON.parse(found.text);
    if (!data) throw new Error('invalid records');
    validateItems(data.items, month);
    return { month, items: data.items, sha: found.sha };
  } catch {
    throw new Error(`${month} 的資料格式損毀`);
  }
}

/** 寫某個月。sha 為 null 表示新檔。 */
export async function saveMonth(month, items, sha) {
  validateItems(items, month);
  const payload = JSON.stringify({ month, items, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(`records/${month}.json`, payload, sha);
}

/* ---------- 設定 ---------- */

export async function loadSettings() {
  const found = await readFile('settings.json');
  if (!found) return { settings: null, sha: null };
  return { settings: JSON.parse(found.text), sha: found.sha };
}

export async function saveSettings(settings, sha) {
  const payload = JSON.stringify(settings, null, 2);
  await writeFile('settings.json', payload, sha);
}

/* ---------- 歷史月結與月份目錄 ---------- */

export function validateArchive(archive) {
  if (!archive || archive.version !== 2 ||
      !validMonth(archive.cutoverMonth) || !Array.isArray(archive.years) || archive.years.some((y) => !/^\d{4}$/.test(y))) {
    throw new Error('歷史月結設定格式損毀');
  }
  if (!validMonth(archive.historyThrough) || archive.historyThrough >= archive.cutoverMonth) {
    throw new Error('歷史截止月份必須早於正式記帳月份');
  }
  if (archive.migratedThrough !== undefined && archive.migratedThrough !== archive.historyThrough) throw new Error('歷史轉入記帳的月份與歷史截止月份不同');
  validateHistory(archive.data);
  if (JSON.stringify(Object.keys(archive.data).sort()) !== JSON.stringify([...archive.years].sort())) throw new Error('歷史年度清單與資料不一致');
}

export async function loadHistory() {
  const found = await readFile('billing-history.json');
  if (!found) return { archive: null, sha: null };
  let archive;
  try { archive = JSON.parse(found.text); validateArchive(archive); }
  catch { throw new Error('歷史月結設定格式損毀'); }
  return { archive, sha: found.sha };
}

/** 目錄只列出月份與版本，年表同步只重讀有變更的月檔。 */
export async function listMonths() {
  if (isLocal()) {
    const res = await fetch('/api/months', { cache: 'no-store' });
    if (!res.ok) throw new Error('無法讀取月份目錄');
    return res.json();
  }
  const res = await fetch(contentsUrl('records'), { cache: 'no-store', headers: {
    Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json',
  } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`無法讀取月份目錄（${res.status}）`);
  const files = await res.json();
  if (!Array.isArray(files)) throw new Error('月份目錄格式錯誤');
  return files.filter((f) => f.type === 'file' && /^\d{4}-(?:0[1-9]|1[0-2])\.json$/.test(f.name))
    .map((f) => ({ month: f.name.slice(0, 7), sha: f.sha }));
}

/* ---------- 輪詢 ---------- */

/** 訂閱別人的變更。回傳取消訂閱的函式。 */
export function watch(month, onChange) {
  if (isLocal()) return () => {};
  const path = `records/${month}.json`;
  let stopped = false;
  let running = false;
  // 只有回呼成功套用的版本才算已同步；讀取或寫入本身不能提前確認。
  let appliedSha = Symbol('尚未同步');

  const tick = async () => {
    if (stopped || running || !session || document.visibilityState === 'hidden') return;
    running = true;
    try {
      const res = await fetch(contentsUrl(path), {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (stopped || (!res.ok && res.status !== 404)) return;
      const next = res.status === 404 ? null : (await res.json()).sha;
      if (stopped || appliedSha === next) return;
      await onChange(next);
      if (!stopped) appliedSha = next;
    } catch {
      /* 斷網就下一輪再試 */
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, 10000);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  tick();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
