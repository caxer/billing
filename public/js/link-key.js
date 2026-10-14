// Shared by billing, salary and teacher. Keep the three copies identical.
// 專屬連結 #k=<金鑰> 只在第一次開啟時讀取：讀到後立刻從網址列移除，
// 匯入成不可匯出的 AES-GCM 金鑰存進這個網站目錄的 IndexedDB，之後開啟不必輸入。
// 金鑰原文不寫進任何儲存；公開檔案只放用這把金鑰加密的密文。
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const PARAM = 'k';
  const PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const label = text => new TextEncoder().encode(text);
  const BROKEN = '專屬連結不完整，請重新複製整段連結再開啟。';

  /** 產生新金鑰（電腦端腳本使用）。 */
  const create = () => encode(crypto.getRandomValues(new Uint8Array(32)));

  /** 網址加上金鑰；不保留原本的 hash。 */
  const link = (base, key) => base.split('#')[0] + '#' + PARAM + '=' + key;

  /** 從貼上的連結或金鑰取出金鑰；格式不對回傳 null。 */
  function parse(text) {
    const value = String(text || '').trim();
    if (PATTERN.test(value)) return value;
    try {
      const found = new URLSearchParams(new URL(value).hash.slice(1)).get(PARAM);
      return found && PATTERN.test(found) ? found : null;
    } catch { return null; }
  }

  /** 讀出網址上的 #k= 並立即移除；沒有時回傳 null，格式不對回傳空字串。 */
  function take() {
    // 只拿掉 k=，其他 hash 片段原樣保留（例如 #test）。
    const parts = location.hash.slice(1).split('&');
    const found = parts.find(part => part.startsWith(PARAM + '='));
    if (found === undefined) return null;
    const value = found.slice(PARAM.length + 1);
    const rest = parts.filter(part => part && !part.startsWith(PARAM + '=')).join('&');
    try { history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : '')); }
    catch { location.hash = rest; }
    return PATTERN.test(value || '') ? value : '';
  }

  async function importKey(key) {
    if (!PATTERN.test(key || '')) throw new Error(BROKEN);
    return crypto.subtle.importKey('raw', decode(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** 用金鑰（字串或 CryptoKey）加密文字；context 綁定用途，換地方用會解不開。 */
  async function seal(key, text, context) {
    const cryptoKey = typeof key === 'string' ? await importKey(key) : key;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: label(context) }, cryptoKey, new TextEncoder().encode(text));
    return { iv: encode(iv), ct: encode(ct) };
  }

  async function open(key, box, context) {
    const cryptoKey = typeof key === 'string' ? await importKey(key) : key;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(box.iv), additionalData: label(context) }, cryptoKey, decode(box.ct));
      return new TextDecoder().decode(plain);
    } catch { throw Object.assign(new Error('這條專屬連結已失效，請向管理者索取新的連結。'), { code: 'revoked' }); }
  }

  /** 依序試每一格，回傳第一格解得開的內容。 */
  async function openAny(key, slots, context) {
    for (const slot of Array.isArray(slots) ? slots : []) {
      try { return await open(key, slot, context); } catch { /* 下一格 */ }
    }
    throw Object.assign(new Error('這條專屬連結已失效，請向管理者索取新的連結。'), { code: 'revoked' });
  }

  /* ---------- 這台裝置的儲存 ---------- */

  let opened;
  function db() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('link-key:' + new URL('./', location.href).pathname, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opened = null; reject(request.error); };
    });
    return opened;
  }
  function run(mode, action) {
    return db().then(connection => new Promise((resolve, reject) => {
      const transaction = connection.transaction('keys', mode);
      const request = action(transaction.objectStore('keys'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('storage'));
    }));
  }

  /** 讀出這台裝置記住的金鑰；沒有或無法讀取時回傳 null。 */
  async function load() {
    try {
      const key = await run('readonly', store => store.get('main'));
      return key instanceof CryptoKey && key.algorithm?.name === 'AES-GCM' && !key.extractable ? key : null;
    } catch { return null; }
  }

  /** 記住金鑰；瀏覽器不允許時回傳 false，這次開著仍可使用。 */
  async function save(key) {
    try {
      await run('readwrite', store => store.put(key, 'main'));
      try { await navigator.storage?.persist?.(); } catch { /* 系統可自行決定 */ }
      return (await load()) !== null;
    } catch { return false; }
  }

  async function forget() {
    try { await run('readwrite', store => store.delete('main')); } catch { /* 沒有可移除的金鑰 */ }
    return (await load()) === null;
  }

  /** 開啟流程共用：網址有金鑰就用網址的（尚未保存），否則讀這台裝置記住的。 */
  async function current() {
    const fromUrl = take();
    if (fromUrl === '') throw new Error(BROKEN);
    if (fromUrl) return { key: await importKey(fromUrl), fresh: true };
    const key = await load();
    return key ? { key, fresh: false } : null;
  }

  /** 讀剪貼簿裡的連結（iPhone 會先顯示「貼上」確認）。 */
  async function fromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch { throw new Error('無法讀取剪貼簿。請先複製專屬連結，再按一次並選「貼上」。'); }
    const key = parse(text);
    if (!key) throw new Error('剪貼簿裡不是專屬連結。請複製完整連結後再試。');
    return importKey(key);
  }

  // 頁面開著時又點了專屬連結（只改 hash）也要重新開啟，才會讀到新金鑰。
  if (typeof location !== 'undefined' && typeof addEventListener === 'function') {
    addEventListener('hashchange', () => {
      if (new URLSearchParams(location.hash.slice(1)).has(PARAM)) location.reload();
    });
  }

  root.LinkKey = { create, link, parse, take, importKey, seal, open, openAny, load, save, forget, current, fromClipboard };
})();
