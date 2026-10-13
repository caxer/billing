// Shared password/Face ID presentation; authentication stays in each app.
export function initLoginScreen(root) {
  const find = name => root.querySelector('[data-login-' + name + ']');
  const input = find('field'), toggle = find('toggle');
  let credential = false, busy = false, visible = !root.hidden, usePassword = false;
  let passwordLabel = '解鎖資料';
  const icon = {
    face: 'M8 3H4v4 M16 3h4v4 M4 17v4h4 M20 17v4h-4 M8 9v2 M16 9v2 M12 9v4h-1 M8 16s4 3 8 0',
    lock: 'M7 11V7a5 5 0 0 1 10 0v4 M5 11h14v10H5z M12 15v2',
  };
  function hidePassword() {
    input.type = 'password'; toggle.textContent = '顯示';
    toggle.setAttribute('aria-label', '顯示密碼'); toggle.setAttribute('aria-pressed', 'false');
  }
  function draw() {
    const password = !credential || usePassword;
    root.hidden = !visible;
    find('password').hidden = !password;
    find('face').hidden = password;
    find('biometric').hidden = !credential;
    find('face-choice').hidden = !credential;
    input.required = password;
    input.disabled = busy || !password;
    for (const button of root.querySelectorAll('button')) button.disabled = busy;
    find('biometric-label').textContent = busy ? '驗證中…' : 'Face ID／通行金鑰登入';
    find('submit-label').textContent = busy ? '正在解鎖…' : passwordLabel;
    find('icon').setAttribute('d', credential ? icon.face : icon.lock);
  }
  find('password-choice').addEventListener('click', () => { if (!busy) { usePassword = true; draw(); } });
  find('face-choice').addEventListener('click', () => { if (!busy) { usePassword = false; hidePassword(); draw(); } });
  toggle.addEventListener('click', () => {
    if (busy) return;
    const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; toggle.textContent = show ? '隱藏' : '顯示';
    toggle.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼'); toggle.setAttribute('aria-pressed', String(show));
    input.focus({ preventScroll: true });
    if (start !== null && end !== null) input.setSelectionRange(start, end, direction);
  });
  hidePassword();
  return {
    hidePassword,
    render(options = {}) {
      if (options.visible === true && !visible) { usePassword = false; hidePassword(); }
      credential = options.hasCredential ?? credential;
      busy = options.busy ?? busy; visible = options.visible ?? visible;
      passwordLabel = options.passwordLabel ?? passwordLabel;
      draw();
    },
  };
}
