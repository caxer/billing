// HTML 文字與帶引號的屬性共用跳脫，保留原始備註及分類文字。
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
