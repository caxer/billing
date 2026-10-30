// 純計算，不碰網路。金額一律以「元」為單位存整數。

export const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y} 年 ${m} 月`;
}

export function dayCount(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export const todayKey = () => {
  const d = new Date();
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 只接受有效的本地日期，不讓 2 月 30 日被自動轉成 3 月。 */
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= dayCount(value.slice(0, 7));
}

export function parseAmount(value) {
  const input = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(input)) return null;
  const clean = input.replace(/,/g, '');
  const amount = Number(clean);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function filterItems(items, { query = '', type = '', by = '', category = '' } = {}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (type && it.type !== type) return false;
    if (by && it.by !== by) return false;
    if (category && it.category !== category) return false;
    const text = [it.note, it.category, it.by, it.date, it.amount].join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** 歷史轉入的帳戶結餘調整：讓土銀與公積金餘額對上原表，不算收支。 */
export const ADJUSTMENT = '結餘調整';
export const isAdjustment = (it) => it.category === ADJUSTMENT;

const ofType = (items, type) => items.filter((it) => it.type === type && !isAdjustment(it));

/** 分類佔比，由大到小。 */
export function byCategory(items, type) {
  const totals = new Map();
  for (const it of ofType(items, type)) {
    totals.set(it.category, (totals.get(it.category) || 0) + it.amount);
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}

/** 每日支出／收入，補滿整個月份方便畫長條圖。parts 是當天各記帳人的金額，供堆疊圖使用。 */
export function byDay(items, month, type) {
  const days = dayCount(month);
  const buckets = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    date: `${month}-${String(i + 1).padStart(2, '0')}`,
    total: 0,
    parts: new Map(),
  }));
  for (const it of ofType(items, type)) {
    if (!it.date?.startsWith(`${month}-`)) continue;
    const d = Number(it.date?.slice(-2));
    if (d < 1 || d > days) continue;
    const bucket = buckets[d - 1];
    bucket.total += it.amount;
    const who = it.by || '';
    bucket.parts.set(who, (bucket.parts.get(who) || 0) + it.amount);
  }
  return buckets;
}

/** 明細排序：日期或金額，desc 為新到舊／大到小；同值依日期再依建立時間。 */
/**
 * 排序：日期、金額預設新到舊／大到小；名稱、分類預設由前到後（分類依 categoryOrder，沒列到的接在後面依筆畫）。
 * dir 為 asc 時整個反過來；同名稱或同分類再依日期新到舊。
 */
export function sortItems(items, { sort = 'date', dir = 'desc', categoryOrder = [] } = {}) {
  const sign = dir === 'asc' ? -1 : 1;
  const text = (a, b) => a.localeCompare(b, 'zh-Hant');
  const name = (it) => String(it.note || '').trim() || it.category;
  const rank = (c) => { const i = categoryOrder.indexOf(c); return i < 0 ? categoryOrder.length : i; };
  const key = {
    amount: (a, b) => b.amount - a.amount,
    name: (a, b) => text(name(a), name(b)),
    category: (a, b) => rank(a.category) - rank(b.category) || text(a.category, b.category),
  }[sort] || (() => 0);
  return [...items].sort((a, b) => sign * (key(a, b) ||
    b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt))));
}

/** 依日期新到舊排，同一天則後存的排前面。 */
export function byDateDesc(items) {
  return [...items].sort(
    (a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}

/** 對比上期的增減百分比。上期為 0 時回傳 null，代表無法比較。 */
export function changePercent(current, previous) {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** 日期欄位按鈕上顯示的文字；今年省略年份。 */
export function dateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '選擇日期';
  const [year, month, day] = value.split('-').map(Number);
  return year === new Date().getFullYear()
    ? `${month} 月 ${day} 日`
    : `${year} 年 ${month} 月 ${day} 日`;
}

/** 兩個 YYYY-MM-DD 相差幾天（to − from），用 UTC 算才不受日光節約影響。 */
export function daysBetween(from, to) {
  const utc = (value) => Date.UTC(...value.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  return Math.round((utc(to) - utc(from)) / 86400000);
}

/** 記事離今天多遠：今天、還剩 N 天、距今 N 天。 */
export function daysLabel(date, today = todayKey()) {
  const diff = daysBetween(today, date);
  return diff === 0 ? '今天' : diff > 0 ? `還剩 ${diff} 天` : `距今 ${-diff} 天`;
}

/** 記事的重複週期：每週、每月。 */
export const REPEATS = { week: '每週', month: '每月' };

/** 第 n 次（從 0 起）的日期：每週加 7 天；每月同一天，那個月沒有這天就用月底（例如 31 日在 2 月是 28／29 日）。 */
function nthDate(start, repeat, n) {
  const [y, m, d] = start.split('-').map(Number);
  const pad = (v) => String(v).padStart(2, '0');
  if (repeat === 'week') {
    const t = new Date(Date.UTC(y, m - 1, d + 7 * n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const index = (y * 12 + m - 1) + n;
  const year = Math.floor(index / 12), month = index % 12 + 1;
  return `${year}-${pad(month)}-${pad(Math.min(d, new Date(Date.UTC(year, month, 0)).getUTCDate()))}`;
}

/** 記事在 [from, to] 之間的每一天；不重複的記事只有自己那天，重複的從起始日開始往後。 */
export function noteDates(it, from, to) {
  if (!REPEATS[it.repeat]) return it.date >= from && it.date <= to ? [it.date] : [];
  const out = [];
  // 先跳到接近 from 的那一次，避免從很久以前一步一步算。
  let n = Math.max(0, it.repeat === 'week' ? Math.floor(daysBetween(it.date, from) / 7) : (Number(from.slice(0, 4)) - Number(it.date.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(it.date.slice(5, 7)) - 1);
  for (let date = nthDate(it.date, it.repeat, n); date <= to; date = nthDate(it.date, it.repeat, ++n)) {
    if (date >= from) out.push(date);
  }
  return out;
}

/** 重複記事下一次的日期（今天或以後）。 */
export function nextNoteDate(it, today = todayKey()) {
  if (!REPEATS[it.repeat] || it.date >= today) return it.date;
  return noteDates(it, today, nthDate(today, it.repeat, 1))[0];
}

export const nf = new Intl.NumberFormat('zh-Hant-TW');
export const money = (n) => nf.format(Math.round(n));

/** billing 平均與極值：月份採正支出，年度優先完整年度；未知值保留缺口。 */
export function seriesStats(values, complete = null) {
  const known = values.map((value, index) => ({ value, index })).filter((p) => Number.isFinite(p.value));
  const full = complete ? known.filter((p) => complete[p.index]) : [];
  const positives = known.filter((p) => p.value > 0);
  const pool = complete ? (full.length ? full : known) : positives;
  const average = pool.length ? pool.reduce((sum, p) => sum + p.value, 0) / pool.length : null;
  let sum = 0;
  const cumulative = values.map((v) => { if (!Number.isFinite(v)) return null; sum += v; return sum; });
  const extremes = complete ? known : (positives.length ? positives : known);
  const max = extremes.length ? Math.max(...extremes.map((p) => p.value)) : null;
  const min = extremes.length ? Math.min(...extremes.map((p) => p.value)) : null;
  return { average, cumulative, highest: extremes.filter((p) => p.value === max), lowest: extremes.filter((p) => p.value === min),
    count: known.length, averageCount: pool.length, completeAverage: !!full.length, total: known.length ? sum : null };
}
