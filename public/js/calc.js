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

export function filterItems(items, { query = '', type = '', by = '' } = {}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (type && it.type !== type) return false;
    if (by && it.by !== by) return false;
    const text = [it.note, it.category, it.by, it.date, it.amount].join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const ofType = (items, type) => items.filter((it) => it.type === type);

/** 支出、收入、淨額（收入 − 支出）。 */
export function summarize(items) {
  let expense = 0;
  let income = 0;
  for (const it of items) {
    if (it.type === 'expense') expense += it.amount;
    if (it.type === 'income') income += it.amount;
  }
  return { expense, income, net: income - expense };
}

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

export const nf = new Intl.NumberFormat('zh-Hant-TW');
export const money = (n) => nf.format(Math.round(n));

/** 帶正負號的金額，例如「−1,200」。 */
export const signedMoney = (n) => `${n < 0 ? '−' : ''}${money(Math.abs(n))}`;

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
