// 禁止網站儲存或空間已滿時，仍能在記憶體中使用帳本。
export function readStored(key, storage = 'localStorage') {
  try { return globalThis[storage].getItem(key); }
  catch { return null; }
}

export function writeStored(key, value, storage = 'localStorage') {
  try {
    globalThis[storage].setItem(key, value);
    return true;
  } catch { return false; }
}

export function removeStored(key, storage = 'localStorage') {
  try { globalThis[storage].removeItem(key); }
  catch { /* 儲存不可用不影響目前操作。 */ }
}
