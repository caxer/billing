// Shared by billing, salary and teacher. Keep the three copies identical (node scripts/link-key.mjs --sync).
// 首次開啟指引：LINE 等 App 內建瀏覽器無法加到主畫面，帶著專屬連結開啟時先請使用者改用 Safari／瀏覽器；
// 手機瀏覽器登入後提示加到主畫面（Android 支援時一鍵安裝）。畫面與樣式都在這裡，不依賴各網站的 CSS。
// 用法：讀金鑰前 await OpenGuide.gate()；登入成功後 OpenGuide.afterLogin({ fresh })。
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const IN_APP = [
    [/\bLine\//i, 'LINE'], [/Instagram/i, 'Instagram'], [/MessengerForiOS|FBAN\/Messenger|\bOrca-Android\b/i, 'Messenger'],
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'], [/MicroMessenger/i, '微信'], [/Barcelona/i, 'Threads'],
    [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
  ];
  const EXTERNAL = 'openExternalBrowser';
  const KEY = /^[A-Za-z0-9_-]{43}$/;
  const state = { info: null, link: '', guided: false };

  /** 判斷目前的瀏覽器；app 是內建瀏覽器的 App 名稱，一般瀏覽器為空字串。 */
  function info(ua = navigator.userAgent, {
    touch = navigator.maxTouchPoints > 1,
    standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,
  } = {}) {
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch);
    const android = /Android/.test(ua);
    if (standalone || (!ios && !android)) return { ios, android, standalone, app: '' };
    let app = IN_APP.find(([pattern]) => pattern.test(ua))?.[1] || '';
    // 其他 App 的 WebView：Android 帶 "; wv)"，iOS 沒有 Safari 字樣（主畫面 App 已在上面排除）。
    if (!app && (android ? /; wv\)/.test(ua) : !/Safari\//.test(ua))) app = 'App';
    return { ios, android, standalone: false, app };
  }

  /**
   * 從內建瀏覽器改用外部瀏覽器開啟同一個網址（保留 #k=）。
   * LINE 認得 ?openExternalBrowser=1；iPhone 其他 App 用 iOS 17 起的 x-safari-https://；
   * Android 其他 App 用 intent:// 指定 Chrome（Android 取最後一個 # 之後當 intent 參數）。
   */
  function externalUrl(href, browser) {
    const url = new URL(href);
    if (browser.app === 'LINE') { url.searchParams.set(EXTERNAL, '1'); return url.href; }
    if (browser.ios) return 'x-safari-' + url.href;
    return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${url.protocol.slice(0, -1)};package=com.android.chrome;end`;
  }

  /** 網址上的專屬連結（只留 #k=）；沒有時回傳空字串。 */
  function keyLink(href = location.href) {
    const [base, hash = ''] = href.split('#');
    const key = new URLSearchParams(hash).get('k');
    return key && KEY.test(key) ? base + '#k=' + key : '';
  }

  /* ---------- 記住提示過（各網站分開，三個網站同網域） ---------- */

  const storeKey = name => 'open-guide:' + new URL('./', location.href).pathname + ':' + name;
  // 第一次回傳 true；無法記住時每次都 true。
  function once(name) {
    try { if (localStorage.getItem(storeKey(name))) return false; localStorage.setItem(storeKey(name), '1'); } catch { /* 無法記住 */ }
    return true;
  }
  function seen(name) {
    try { return !!localStorage.getItem(storeKey(name)); } catch { return false; }
  }

  /* ---------- 畫面 ---------- */

  const CSS = `
.og-screen { position: fixed; inset: 0; z-index: 2000; overflow: auto; background: #101419; color: #f3f6f8; color-scheme: dark; font: 16px/normal -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", system-ui, sans-serif; }
.og-screen *, .og-bar * { box-sizing: border-box; }
.og-page { max-width: 460px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom)); min-height: 100svh; display: flex; flex-direction: column; }
.og-screen .login-brand { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; }
.og-screen .brand-mark { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 13px; background: rgba(120,220,192,.12); color: #78dcc0; }
.og-card { margin-top: 46px; padding: 24px 20px; border: 1px solid rgba(255,255,255,.13); border-radius: 22px; background: #1b2129; }
.og-icon { color: #78dcc0; display: inline-flex; padding: 10px; background: rgba(120,220,192,.08); border-radius: 14px; }
.og-card h2 { font-size: 21px; margin: 18px 0 8px; letter-spacing: -.02em; font-weight: 700; }
.og-note { font-size: 12px; line-height: 1.7; margin: 0 0 20px; color: #94a1ae; }
.og-primary { width: 100%; min-height: 50px; padding: 12px 16px; font: inherit; font-size: 15px; font-weight: 600; display: flex; justify-content: center; align-items: center; border: 1px solid #78dcc0; border-radius: 12px; background: #78dcc0; color: #10231e; text-decoration: none; cursor: pointer; }
.og-text { width: 100%; min-height: 44px; margin-top: 8px; padding: 8px 12px; font: inherit; font-size: 14px; color: #b0bbc6; border: 0; background: transparent; cursor: pointer; }
.og-screen a:focus-visible, .og-screen button:focus-visible, .og-bar button:focus-visible { outline: 2px solid #78dcc0; outline-offset: 3px; }
.og-bar { pointer-events: none; position: fixed; z-index: 1500; left: 50%; bottom: calc(10px + env(safe-area-inset-bottom)); transform: translateX(-50%); width: min(500px, calc(100vw - 24px)); display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border: 1px solid rgba(255,255,255,.18); border-radius: 12px; background: #1b2129; color: #f3f6f8; box-shadow: 0 8px 24px rgba(0,0,0,.3); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", system-ui, sans-serif; }
.og-bar[hidden], .og-bar [hidden], .og-screen [hidden] { display: none !important; }
.og-bar-text { flex: 1; min-width: 0; }
.og-bar button { pointer-events: auto; flex: none; min-height: 36px; padding: 4px 10px; font: inherit; border: 1px solid rgba(255,255,255,.18); border-radius: 9px; background: transparent; color: #f3f6f8; cursor: pointer; }
.og-bar .og-bar-install { background: #78dcc0; border-color: #78dcc0; color: #10231e; font-weight: 600; }`;
  const ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

  function addStyle() {
    if (document.getElementById('og-style')) return;
    document.head.append(Object.assign(document.createElement('style'), { id: 'og-style', textContent: CSS }));
  }
  function make(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const area = make('textarea', { value: text, readOnly: true });
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area); area.select();
      try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
    }
  }
  function copyButton(button, text, done) {
    const label = button.textContent;
    button.onclick = async () => {
      button.textContent = await copy(text) ? done : '無法複製，請長按網址列複製';
      setTimeout(() => { button.textContent = label; }, 4000);
    };
  }

  const appName = browser => browser.app === 'App' ? '這個 App' : browser.app;
  const browserName = browser => browser.ios ? 'Safari' : '瀏覽器';

  /** 內建瀏覽器的指引卡；選「先在這裡使用」才 resolve。 */
  function showInApp(browser) {
    addStyle();
    const name = browserName(browser), line = browser.app === 'LINE';
    const open = make('a', { id: 'og-open', className: 'og-primary', href: externalUrl(location.href, browser), textContent: `用 ${name} 開啟`,
      title: 'App 內建瀏覽器無法加到主畫面，也可能不保留登入。改用瀏覽器開啟後再加到主畫面。' });
    const copyLink = make('button', { id: 'og-copy', type: 'button', className: 'og-text', textContent: '複製連結',
      title: `複製專屬連結，到 ${name} 的網址列貼上開啟。連結就是鑰匙，請勿轉傳。` });
    const stay = make('button', { id: 'og-stay', type: 'button', className: 'og-text', textContent: '先在這裡使用', title: '在這裡也能使用，但無法加到主畫面。' });
    const brand = document.querySelector('.login-brand')?.cloneNode(true) || make('div', { className: 'login-brand', textContent: document.title });
    const card = make('section', { className: 'og-card' }, [
      make('span', { className: 'og-icon', innerHTML: ICON }),
      make('h2', { id: 'og-title', textContent: `請用 ${name} 開啟` }),
      make('p', { id: 'og-note', className: 'og-note', textContent: `${appName(browser)} 內無法加到主畫面。` + (line ? '' : `沒反應時點右上角 ⋯ 改用${name}。`) }),
      open, copyLink, stay,
    ]);
    const screen = make('div', { id: 'og-screen', className: 'og-screen' }, [make('div', { className: 'og-page' }, [brand, card])]);
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-modal', 'true');
    screen.setAttribute('aria-labelledby', 'og-title');
    document.body.append(screen);
    copyButton(copyLink, location.href, `已複製，到 ${name} 貼上網址`);
    // LINE 直接轉去外部瀏覽器；回到這一頁（已帶參數）時不再自動轉，留卡片給使用者選。
    if (line && !new URL(location.href).searchParams.has(EXTERNAL)) location.replace(open.href);
    return new Promise(resolve => { stay.onclick = () => { screen.remove(); resolve(); }; });
  }

  let bar = null;
  function showBar(text, { copyText = '', install = false, onClose = null, timeout = 0 } = {}) {
    addStyle();
    bar?.remove();
    const close = make('button', { id: 'og-bar-close', type: 'button', textContent: '✕', title: '關閉' });
    close.setAttribute('aria-label', '關閉提示');
    const copyLink = make('button', { id: 'og-bar-copy', type: 'button', textContent: '複製連結', hidden: !copyText,
      title: '主畫面第一次開啟時要貼上專屬連結，先複製起來。' });
    const go = make('button', { id: 'og-bar-install', type: 'button', className: 'og-bar-install', textContent: '安裝', hidden: !install,
      title: '加到主畫面，像 App 一樣開啟。' });
    bar = make('div', { id: 'og-bar', className: 'og-bar' }, [make('span', { id: 'og-bar-text', className: 'og-bar-text', textContent: text }), copyLink, go, close]);
    bar.setAttribute('role', 'status');
    document.body.append(bar);
    if (copyText) copyButton(copyLink, copyText, '已複製');
    go.onclick = runInstall;
    close.onclick = () => { onClose?.(); hideBar(); };
    if (timeout) { const current = bar; setTimeout(() => { if (bar === current) hideBar(); }, timeout); }
  }
  function hideBar() { bar?.remove(); bar = null; onPrompt = null; }
  // 提示不擋操作：除了按鈕，點擊會穿透到下面；點提示以外的地方就收起（不算關掉，Android 之後仍可能再提示）。
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', event => { if (bar && !bar.contains(event.target)) hideBar(); }, true);
  }

  /* ---------- 加到主畫面 ---------- */

  // Android Chrome 等符合安裝條件時給 beforeinstallprompt，留著讓「安裝」按鈕叫出系統安裝視窗。
  let installPrompt = null, onPrompt = null;
  if (typeof window !== 'undefined') {
    addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; onPrompt?.(); });
    addEventListener('appinstalled', () => { installPrompt = null; hideBar(); });
  }
  async function runInstall() {
    const prompt = installPrompt;
    if (!prompt) return;
    installPrompt = null;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'dismissed') once('install');
    hideBar();
  }
  function androidMenu(ua) {
    if (/SamsungBrowser/.test(ua)) return '點下方 ☰ →「新增頁面至」→「主螢幕」';
    if (/Chrome\//.test(ua) && !/EdgA|OPR|Firefox/.test(ua)) return '點右上角 ⋮ →「加到主畫面」';
    return '從瀏覽器選單選「加到主畫面」';
  }

  /**
   * iPhone 只在第一次用連結登入時提示：主畫面與 Safari 分開儲存，從主畫面第一次開啟要貼上連結，所以附「複製連結」。
   * Android 共用登入：可一鍵安裝時就提示；不支援一鍵安裝時只在第一次登入教選單。關掉後不再出現。
   */
  function installTip(browser, { fresh, link, ua = navigator.userAgent }) {
    if (browser.standalone || browser.app || (!browser.ios && !browser.android)) return;
    const closed = () => once('install');
    if (browser.ios) {
      if (fresh) showBar('點分享 →「加入主畫面」', { copyText: link, onClose: closed });
      return;
    }
    const draw = () => {
      showBar(installPrompt ? '加到主畫面，下次一點就開' : androidMenu(ua), { install: !!installPrompt, onClose: closed });
      onPrompt = draw; // 安裝條件晚一點才成立時，補上按鈕
    };
    if (seen('install') && !fresh) return;
    if (installPrompt || fresh) draw();
    else onPrompt = draw;
  }

  /* ---------- 對外 ---------- */

  /** 讀金鑰前呼叫：內建瀏覽器帶著專屬連結時先顯示指引卡，選「先在這裡使用」才繼續。 */
  async function gate() {
    state.info = info();
    if (state.info.app && keyLink()) {
      state.link = keyLink(); state.guided = true;
      once('inapp');
      return showInApp(state.info);
    }
    // 外部瀏覽器開啟後拿掉 LINE 的參數，不影響 #k=。
    const url = new URL(location.href);
    if (url.searchParams.has(EXTERNAL)) {
      url.searchParams.delete(EXTERNAL);
      try { history.replaceState(history.state, '', url.pathname + url.search + url.hash); } catch { /* 留著也無妨 */ }
    }
    state.link = keyLink();
  }

  /** 登入成功後呼叫：內建瀏覽器提醒一次；一般手機瀏覽器提示加到主畫面。 */
  function afterLogin({ fresh = false } = {}) {
    const browser = state.info || (state.info = info());
    if (browser.app) {
      if (!state.guided && once('inapp')) showBar(`${appName(browser)} 內無法加到主畫面，建議改用 ${browserName(browser)} 開啟專屬連結。`, { timeout: 8000 });
      return;
    }
    installTip(browser, { fresh, link: state.link });
  }

  root.OpenGuide = { info, externalUrl, keyLink, gate, afterLogin };
})();
