// 相機照片的讀取與縮圖（與 teacher/public/js/photo.js 相同）：部分 iOS／內建瀏覽器只能用 Image 或 FileReader 解碼。
function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取照片'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src, release = () => {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const close = () => { image.onload = image.onerror = null; image.src = ''; release(); };
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) { close(); reject(new Error('照片尺寸不正確')); return; }
      resolve({ image, width: image.naturalWidth, height: image.naturalHeight, close });
    };
    image.onerror = () => { close(); reject(new Error('瀏覽器無法解碼照片')); };
    image.src = src;
  });
}

async function decodeBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    for (const options of [{ imageOrientation: 'from-image' }, undefined]) {
      try {
        const image = options ? await createImageBitmap(file, options) : await createImageBitmap(file);
        if (image.width && image.height) return { image, width: image.width, height: image.height, close: () => image.close?.() };
        image.close?.();
      } catch { /* 換下一種讀取方式，不把瀏覽器相容性錯誤當成照片損壞。 */ }
    }
  }
  throw new Error('無法建立照片 bitmap');
}

async function decodeImage(file) {
  if (typeof URL.createObjectURL === 'function') {
    try {
      const url = URL.createObjectURL(file);
      return await loadImage(url, () => URL.revokeObjectURL(url));
    } catch { /* 某些內建瀏覽器不允許 Image 讀取 blob URL。 */ }
  }
  return loadImage(await readDataURL(file));
}

export async function decodePhoto(file) {
  // iOS 的 Chrome 也使用 WebKit；優先走 Image，避開舊版 bitmap 的解碼與方向問題。
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const decoders = ios ? [decodeImage, decodeBitmap] : [decodeBitmap, decodeImage];
  for (const decode of decoders) {
    try { return await decode(file); } catch { /* 換另一種瀏覽器解碼路徑。 */ }
  }
  throw new Error('瀏覽器無法解碼照片');
}

export async function exportJPEG(canvas) {
  if (typeof canvas.toBlob === 'function') {
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (blob?.size) return blob;
    } catch { /* 改用 data URL 匯出。 */ }
  }
  const data = canvas.toDataURL('image/jpeg', 0.9);
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(data);
  if (!match) throw new Error('照片無法匯出');
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

export async function preparePhoto(file) {
  if (!file.size) throw new Error('照片是空的，請重新拍照或從相簿選取。');
  let decoded;
  try { decoded = await decodePhoto(file); }
  catch {
    const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
    throw new Error(heic
      ? '這個瀏覽器無法讀取 HEIC／HEIF 照片。請到 iPhone「設定 → 相機 → 格式」選「最相容」，再重新拍照。'
      : '這個瀏覽器無法讀取照片。請重新拍照，或先將照片存入相簿再選取。');
  }
  const canvas = document.createElement('canvas');
  const small = document.createElement('canvas');
  try {
    const scale = Math.min(1, 2000 / Math.max(decoded.width, decoded.height));
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('無法建立照片畫布');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    const blob = await exportJPEG(canvas);
    const thumbnailScale = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
    small.width = Math.max(1, Math.round(canvas.width * thumbnailScale));
    small.height = Math.max(1, Math.round(canvas.height * thumbnailScale));
    const thumbnailContext = small.getContext('2d');
    let thumb = '';
    if (thumbnailContext) {
      thumbnailContext.drawImage(canvas, 0, 0, small.width, small.height);
      thumb = small.toDataURL('image/jpeg', 0.72);
    }
    return { blob, thumb, width: canvas.width, height: canvas.height };
  } catch {
    throw new Error('照片處理失敗。請關閉其他分頁後重試，或從相簿選擇較小的照片。');
  } finally {
    decoded.close();
    canvas.width = canvas.height = small.width = small.height = 0;
  }
}
