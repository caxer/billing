// 密碼加密：PBKDF2-SHA256 拉金鑰，再用 AES-256-GCM 加密設定內容。
// 只在安全來源運作（https 或 127.0.0.1），GitHub Pages 與本機預覽都符合。
//
// 保護的目標是「公開的 secret.json 就算被下載，也解不開」。
// 拿到密碼的人就能在瀏覽器裡解出 GitHub token，這點無法避免。

const ITERATIONS = 600000;

const te = new TextEncoder();
const td = new TextDecoder();

function toB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromB64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 把字串加密成可公開存放的盒子。 */
export async function seal(plain, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain));
  return {
    v: 1,
    iter: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

/** 解開盒子。密碼錯誤或內容被竄改都會丟出錯誤。 */
export async function open(box, password) {
  const salt = fromB64(box.salt);
  const iv = fromB64(box.iv);
  const key = await deriveKey(password, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromB64(box.ct));
  } catch {
    throw new Error('密碼錯誤');
  }
  return td.decode(plain);
}
