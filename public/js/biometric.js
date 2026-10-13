import './faceid-core.js';
// 通行密鑰 PRF 產生解密金鑰；裝置驗證成功後才能讀取加密登入資訊。
import { readStored, writeStored, removeStored } from './storage.js';

const KEY = 'spa-biometric';
let pending = null;
export const hasPending = () => pending !== null;
const encoder = new TextEncoder();
const random = (length) => crypto.getRandomValues(new Uint8Array(length));
const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('生物辨識設定損毀，請用密碼登入後重新設定');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

export const configured = () => readStored(KEY) !== null;

export const available = () => FaceIDCore.available();

function readVault() {
  try {
    const vault = JSON.parse(readStored(KEY));
    if (!vault || vault.version !== 1 || vault.origin !== location.origin ||
        !decode(vault.id).length || decode(vault.salt).length !== 32 || decode(vault.iv).length !== 12 || decode(vault.ct).length < 16) throw new Error();
    return vault;
  } catch { throw new Error('生物辨識設定損毀，請用密碼登入後重新設定'); }
}

const assertion = (id, salt) => FaceIDCore.assertion(decode(id), decode(salt));

const parameters = (vault) => ({ name: 'AES-GCM', iv: decode(vault.iv),
  additionalData: encoder.encode(`shared-ledger:${vault.origin}:${vault.id}`) });

/** 成功保存密文前不修改現有登入。Safari 可在建立後再取得 PRF 結果。 */
export async function enroll(session) {
  pending = null;
  const salt = random(32);
  const { id, result } = await FaceIDCore.register('帳本紀錄', salt);
  const vault = { version: 1, origin: location.origin, id: encode(id), salt: encode(salt) };
  if (result) return saveSession(vault, result, session);
  pending = vault;
  return { pending: true };
}

export async function completeRegistration(session) {
  if (!pending) throw new Error('請重新建立通行密鑰。');
  const vault = pending;
  return saveSession(vault, await assertion(vault.id, vault.salt), session);
}

async function saveSession(record, result, session) {
  const vault = { ...record, iv: encode(random(12)) };
  const key = await FaceIDCore.keyFrom(result);
  vault.ct = encode(await crypto.subtle.encrypt(parameters(vault), key, encoder.encode(JSON.stringify(session))));
  const saved = JSON.stringify(vault);
  if (!writeStored(KEY, saved) || readStored(KEY) !== saved) throw new Error('無法保存裝置設定，請允許網站儲存後再試');
  pending = null;
  return { ready: true };
}

export async function unlock() {
  const vault = readVault();
  const key = await FaceIDCore.keyFrom(await assertion(vault.id, vault.salt));
  try {
    const plain = await crypto.subtle.decrypt(parameters(vault), key, decode(vault.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error('無法解開裝置登入資訊，請用密碼登入後重新設定'); }
}

export function forget() {
  removeStored(KEY);
  if (configured()) throw new Error('無法移除裝置設定，請允許網站儲存後再試');
  pending = null;
}

export const errorMessage = error => FaceIDCore.errorMessage(error);
