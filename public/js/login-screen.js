import './link-key.js';
// Shared link-key presentation; unlocking stays in each app.
// 沒有密碼欄：只顯示「用專屬連結開啟」，主畫面 App 可貼上連結一次。
export function initLoginScreen(root, { onKey }) {
  const find = name => root.querySelector('[data-login-' + name + ']');
  const paste = find('paste'), error = find('error');
  let busy = false, visible = !root.hidden;
  function draw() {
    root.hidden = !visible;
    paste.disabled = busy;
    find('paste-label').textContent = busy ? '正在開啟…' : '貼上專屬連結';
  }
  function show(message) {
    error.textContent = message || '';
    error.hidden = !message;
  }
  paste.addEventListener('click', async () => {
    if (busy) return;
    show('');
    let key;
    try { key = await LinkKey.fromClipboard(); }
    catch (err) { show(err.message); return; }
    await onKey(key);
  });
  return {
    show,
    render(options = {}) {
      busy = options.busy ?? busy; visible = options.visible ?? visible;
      if (options.message !== undefined) show(options.message);
      draw();
    },
  };
}
