// Shared by billing, salary and teacher. Keep the three copies identical.
// Storage/encryption formats belong to each app; device verification lives here.
(function () {
  'use strict';
  const random = size => crypto.getRandomValues(new Uint8Array(size));
  async function available() {
    if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials?.create ||
        !navigator.credentials?.get || !globalThis.crypto?.subtle) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch { return false; }
  }
  function prf(credential) {
    const result = credential?.getClientExtensionResults()?.prf?.results?.first;
    if (!result || result.byteLength !== 32) throw new Error('這個裝置或瀏覽器尚不支援安全的 Face ID 解鎖，請使用密碼登入。');
    return result;
  }
  async function register(name, salt) {
    // Start directly in the button handler, before any network/capability await.
    const credential = await navigator.credentials.create({ publicKey: {
      rp: { name }, user: { id: random(32), name, displayName: name + '登入' },
      challenge: random(32), timeout: 60000,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      attestation: 'none', extensions: { prf: { eval: { first: salt } } },
    } });
    if (!credential || credential.type !== 'public-key' || !credential.rawId?.byteLength) throw new Error('未完成 Face ID 設定，仍可使用密碼登入。');
    const extension = credential.getClientExtensionResults()?.prf;
    if (!extension?.enabled && !extension?.results?.first) prf(credential);
    // If registration supplies no PRF, complete on a second button tap.
    return { id: credential.rawId, result: extension?.results?.first ? prf(credential) : null };
  }
  async function assertion(id, salt) {
    const credential = await navigator.credentials.get({ publicKey: {
      challenge: random(32), timeout: 60000, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id, transports: ['internal'] }],
      extensions: { prf: { eval: { first: salt } } },
    } });
    const actual = new Uint8Array(credential?.rawId || []), expected = new Uint8Array(id);
    const data = new Uint8Array(credential?.response?.authenticatorData || []);
    if (!credential || credential.type !== 'public-key' || actual.length !== expected.length ||
        !actual.every((byte, i) => byte === expected[i]) || data.length < 37 || !(data[32] & 4)) {
      throw new Error('未完成裝置驗證，請重試或使用密碼登入。');
    }
    return prf(credential);
  }
  const keyFrom = result => crypto.subtle.importKey('raw', result, 'AES-GCM', false, ['encrypt', 'decrypt']);
  function errorMessage(error) {
    if (['NotAllowedError', 'AbortError'].includes(error?.name)) return 'Face ID 驗證已取消或逾時；可重試或使用密碼登入。';
    if (['NotSupportedError', 'SecurityError'].includes(error?.name)) return '目前瀏覽器無法使用 Face ID，請用支援通行密鑰的瀏覽器開啟 HTTPS 網址，或使用密碼登入。';
    return error?.message || 'Face ID 登入失敗，請使用密碼登入。';
  }
  function autoLogin({ enabled, unlocked, busy, promptBusy = busy, suspend, unlock, restore }) {
    let pending = false, running = false;
    const resume = async () => {
      if (enabled() && !running && !busy() && document.visibilityState === 'hidden' && unlocked()) {
        pending = true; suspend();
      }
      if (!pending || running || !enabled() || busy() || document.visibilityState !== 'visible') return;
      pending = false; running = true;
      try { await unlock(); } finally {
        running = false;
        if (enabled() && document.visibilityState === 'hidden' && unlocked()) {
          pending = true; suspend();
        }
      }
    };
    const visibility = () => {
      if (!enabled() || running || promptBusy()) return;
      if (document.visibilityState === 'hidden' && unlocked()) {
        pending = true; suspend();
      } else if (document.visibilityState === 'visible') void resume();
    };
    const pageshow = event => {
      if (!event.persisted || !enabled()) return;
      if (restore) return restore();
      pending = true; suspend(); void resume();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', pageshow);
    return {
      start: () => { pending = true; return resume(); }, resume,
      clear: () => { pending = false; },
      dispose: () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', pageshow); },
    };
  }
  globalThis.FaceIDCore = Object.freeze({ available, register, assertion, keyFrom, errorMessage, autoLogin });
})();
