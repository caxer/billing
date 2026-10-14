// Passwords stay in the form/request only; never persist them in browser storage.
export function initLocalPassword(root) {
  let timer, sending = false, latest;
  const form = () => root.querySelector('#local-password-form');
  function draw(status) {
    latest = status;
    if (!form()) return;
    const busy = sending || status.state === 'running';
    for (const input of form().querySelectorAll('input, button')) input.disabled = busy;
    root.querySelector('#local-password-status').textContent = status.message || '';
    // 密碼卡平常收合；發布中或需要重試時自動展開。
    if (busy || (status.state === 'failed' && status.saved)) root.querySelector('#local-password-card').open = true;
    root.querySelector('#local-password-retry').hidden = !(status.state === 'failed' && status.saved);
    root.querySelector('#local-password-retry').disabled = busy;
    form().hidden = status.state === 'failed' && status.saved;
  }
  async function refresh() {
    clearTimeout(timer);
    if (!form()) return;
    try {
      const response = await fetch('/api/local-password', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      draw(await response.json());
      if (latest.state === 'running') timer = setTimeout(refresh, 2000);
    } catch {
      root.querySelector('#local-password-status').textContent = '無法讀取發布狀態，請確認本機服務仍在執行，再重新開啟設定。';
    }
  }
  async function send(body) {
    if (sending) return;
    sending = true;
    draw({ ...latest, message: '正在處理…' });
    try {
      const response = await fetch('/api/local-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '無法修改密碼。');
      form()?.reset();
      draw(result);
    } catch (error) {
      draw({ ...(latest || {}), state: latest?.state || 'idle', message: error.message });
    } finally {
      sending = false;
      if (latest) draw(latest);
      if (latest?.state === 'running') timer = setTimeout(refresh, 1000);
    }
  }
  root.addEventListener('submit', event => {
    if (event.target.id !== 'local-password-form') return;
    event.preventDefault();
    const data = new FormData(event.target);
    const body = Object.fromEntries(data);
    if (body.newPassword !== body.confirmPassword) {
      root.querySelector('#local-password-status').textContent = '兩次新密碼不一致。'; return;
    }
    void send(body);
  });
  root.addEventListener('click', event => {
    if (event.target.closest('#local-password-retry')) void send({ action: 'retry' });
  });
  return { refresh };
}
