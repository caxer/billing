// 月結的純計算與分類對應；歷史合計與新交易永遠擇一使用。
import { shiftMonth, seriesStats } from './calc.js';
export const GROUPS = ['日常', '房', '女兒', '兒子', '水電氣'];
export const STACK_GROUPS = [
  { key: 'utilities', name: '水電氣', color: '#38bdf8' },
  { key: 'house', name: '房', color: '#4ade80' },
  { key: 'daughter', name: '女兒', color: '#f472b6' },
  { key: 'son', name: '兒子', color: '#a78bfa' },
  { key: 'daily', name: '扣除列項後開銷', color: '#fbbf24' },
];
const ITEMS = {
  房: ['還款', '房貸', '管理', '火險', '房屋', '地價', '網路', '其他'],
  女兒: ['美語', '安親班', '補習班', '註冊費', '保險(郵局)', '其他'],
  兒子: ['美語', '安親班', '補習班', '註冊費', '保險(郵局)', '課照', '其他'],
  水電氣: ['電費', '水費', '燃氣'],
};
/** 水電氣由土銀帳戶扣款，記在土銀名下；它不是手機使用者，也沒有額度。 */
export const UTILITY_PAYER = '土銀';
/** 土銀某年的水電氣預算，存在 budgets.土銀.<年>；沒設定回傳 0。 */
export const utilityBudget = (settings, year) =>
  Number(settings?.budgets?.[UTILITY_PAYER]?.[year] ?? settings?.budgets?.[UTILITY_PAYER]?.default ?? 0);
/** 某人某月的支出額度，也是上繳公積金的額度；該月沒單獨設定就用 default。 */
export const monthlyBudget = (settings, person, month) =>
  Number(settings?.budgets?.[person]?.[month] ?? settings?.budgets?.[person]?.default ?? 0);
export const BILLING_CATEGORIES = Object.entries(ITEMS).flatMap(([group, items]) => items.map((item) => `${group}／${item}`));
export const validMonth = (value) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value || '');

export const historyEnd = (archive) => archive?.historyThrough ||
  (validMonth(archive?.cutoverMonth) ? shiftMonth(archive.cutoverMonth, -1) : null);

export function classify(category, mappings = {}) {
  if (Object.hasOwn(mappings, category) && GROUPS.includes(mappings[category])) return mappings[category];
  for (const group of GROUPS.slice(1)) {
    if (category?.startsWith(`${group}／`)) return group;
  }
  if (category === '水電瓦斯') return '水電氣';
  if (category === '房租') return '房';
  return '日常';
}

export function upgradeSettings(value) {
  const next = structuredClone(value);
  if (!next.billingVersion) {
    next.expenseCategories = [...new Set([...(next.expenseCategories || []), ...BILLING_CATEGORIES])];
    next.billingVersion = 1;
  }
  if (next.billingVersion < 2) {
    next.people = [...new Set([...(next.people || []), UTILITY_PAYER])];
    next.billingVersion = 2;
  }
  next.billingGroups ||= {};
  return next;
}

export function transactionSummary(items, mappings = {}) {
  const result = { daily: 0, house: 0, daughter: 0, son: 0, utilities: 0, monthlyTotal: 0, total: 0, income: 0, details: [], incomeDetails: [] };
  const keys = { 日常: 'daily', 房: 'house', 女兒: 'daughter', 兒子: 'son', 水電氣: 'utilities' };
  const details = new Map();
  const incomes = new Map();
  for (const it of items) {
    if (it.type === 'income') {
      result.income += it.amount;
      const detail = incomes.get(it.category) || { group: '收入', item: it.category, amount: 0, note: '' };
      detail.amount += it.amount; incomes.set(it.category, detail);
      continue;
    }
    if (it.type !== 'expense') continue;
    const group = GROUPS.includes(it.billingGroup) ? it.billingGroup : classify(it.category, mappings);
    result[keys[group]] += it.amount;
    const key = JSON.stringify([group, it.category]);
    const detail = details.get(key) || { group, item: it.category, amount: 0, note: '' };
    detail.amount += it.amount;
    details.set(key, detail);
  }
  result.monthlyTotal = result.daily + result.house + result.daughter + result.son;
  result.total = result.monthlyTotal + result.utilities;
  result.details = [...details.values()];
  result.incomeDetails = [...incomes.values()];
  return result;
}

export function validateHistory(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || !Object.keys(data).length) throw new Error('歷史資料沒有年度');
  for (const [year, rows] of Object.entries(data)) {
    if (!/^\d{4}$/.test(year) || !Array.isArray(rows)) throw new Error('歷史年度格式錯誤');
    for (const row of rows) {
      if (!row || typeof row.category !== 'string' || typeof row.item !== 'string' ||
        !Array.isArray(row.months) || row.months.length !== 12 || row.months.some((v) =>
          !['number', 'string'].includes(typeof v) || (typeof v === 'string' && !/^-?\d+(?:\.\d+)?$/.test(v.trim())) || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > Number.MAX_SAFE_INTEGER) ||
        (row.tooltips !== undefined && (!Array.isArray(row.tooltips) || row.tooltips.length !== 12 || row.tooltips.some((v) => typeof v !== 'string')))) {
        throw new Error(`${year} 年歷史明細格式錯誤`);
      }
    }
  }
  return data;
}

export function historySummary(rows, index) {
  const value = (r) => Number(r.months[index]);
  const sum = (predicate) => rows.filter(predicate).reduce((s, r) => s + value(r), 0);
  const house = sum((r) => r.category === '(房)');
  const daughter = sum((r) => r.category === '(女兒)');
  const son = sum((r) => r.category === '(兒子)');
  const utilities = sum((r) => r.category === '水電氣' && ['電費', '水費', '燃氣'].includes(r.item));
  const totalRows = rows.filter((r) => r.category === 'Shareroo' && r.item === '月消費總額');
  const monthlyTotal = totalRows.length ? totalRows.reduce((s, r) => s + value(r), 0) : null;
  const daily = monthlyTotal === null ? null : monthlyTotal - house - daughter - son;
  const utilityRows = ['收入', '電費', '水費', '燃氣'].map((item) => rows.find((r) => r.category === '水電氣' && r.item === item));
  let utilityBalance = null;
  if (utilityRows.every(Boolean)) {
    utilityBalance = 0;
    for (let i = 0; i <= index; i++) utilityBalance += Number(utilityRows[0].months[i]) - utilityRows.slice(1).reduce((s, r) => s + Number(r.months[i]), 0);
  }
  return {
    house, daughter, son, utilities, monthlyTotal, utilityBalance, daily,
    total: monthlyTotal === null ? null : monthlyTotal + utilities,
    income: null, // 水電帳入款、上繳家用不是家庭新增收入。
    details: [...rows.map((r, i) => ({ id: i, group: r.category, item: r.item, amount: value(r), note: r.tooltips?.[index] || '' }))
      .filter((r) => !['餘額', '土銀餘額', '扣除(列項)後的開銷'].includes(r.item)),
    { id: 'derived-balance', group: '水電氣', item: '餘額', amount: utilityBalance, note: '計算：收入 − 電費 − 水費 − 燃氣 + 上月餘額（沿用原表每年從零開始）' },
    { id: 'derived-daily', group: 'Shareroo', item: '扣除(列項)後的開銷', amount: daily, note: '計算：月消費總額 − 房 − 女兒 − 兒子' }],
  };
}

export function reportStats(months) {
  const totals = reportTotals(months);
  const stats = seriesStats(months.map((m) => m.total));
  const categories = STACK_GROUPS.map((g) => ({ ...g, amount: totals[g.key] })).filter((g) => Number.isFinite(g.amount)).sort((a, b) => b.amount - a.amount);
  return { totals, count: stats.count, averageCount: stats.averageCount, average: totals.total === null ? null : stats.average,
    highest: months[stats.highest[0]?.index] || null, lowest: months[stats.lowest[0]?.index] || null,
    largest: totals.total === null ? null : categories[0] || null };
}

export const itemKey = (group, item) => JSON.stringify([group, item]);
export function monthItems(month) {
  const entries = new Map();
  if (!['history', 'transactions'].includes(month.source)) return entries;
  for (const detail of [...(month.details || []), ...(month.incomeDetails || [])]) {
    const group = detail.group.replace(/[()]/g, '');
    const item = detail.item.startsWith(`${group}／`) ? detail.item.slice(group.length + 1) : detail.item;
    const key = itemKey(group, item);
    const entry = entries.get(key) || { key, group, item, amount: 0 };
    entry.amount = entry.amount === null || detail.amount === null ? null : entry.amount + detail.amount;
    entries.set(key, entry);
  }
  for (const [key, name] of [['total', '家庭總支出'], ['monthlyTotal', '月消費總額'], ['daily', '扣除列項後開銷'], ...STACK_GROUPS.filter((g) => g.key !== 'daily').map((g) => [g.key, g.name])]) {
    entries.set(itemKey('總覽', name), { key: itemKey('總覽', name), group: '總覽', item: name, amount: month[key] });
  }
  return entries;
}

export function itemValue(month, key, entries = monthItems(month)) {
  if (!['history', 'transactions'].includes(month.source)) return null;
  const found = entries.get(key);
  if (found) return found.amount;
  const [group, item] = JSON.parse(key);
  // 舊日常只有月合計；家用與土銀專用入款也沒有逐筆交易來源。
  if ((month.source === 'history' && ['日常', '收入'].includes(group)) ||
      (month.source === 'transactions' && ['家用', 'Shareroo'].includes(group)) ||
      (month.source === 'transactions' && group === '水電氣' && ['收入', '餘額'].includes(item))) return null;
  return 0;
}

export function percentChange(current, previous) {
  return current == null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}

export function annualReport(year, records, history, cutoff, mappings = {}, historyThrough = null) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    const historical = validMonth(cutoff) && month < cutoff;
    const rows = history?.[year];
    if (historical) {
      if (validMonth(historyThrough) && month > historyThrough) return { month, source: 'pending', testCount: records[month]?.length || 0 };
      if (!rows) return { month, source: 'missing', conflict: (records[month]?.length || 0) > 0 };
      return { ...historySummary(rows, index), month, source: 'history', conflict: (records[month]?.length || 0) > 0 };
    }
    return { ...transactionSummary(records[month] || [], mappings), month, source: 'transactions', conflict: false };
  });
}

export const BANK_ITEMS = ['電費', '水費', '燃氣', '其他'];
export const FUND_ITEMS = ['房', '女兒', '兒子', '日常'];
/** 原表家用列的公、婆，依序對應記帳人名單前兩位（土銀除外）。 */
export const FUND_SHARES = ['公', '婆'];

/** 帳本從歷史第一年 1 月逐月走到 through；歷史截止後（含待補月份）改用交易。 */
function* ledgerMonths({ history, cutoff, historyThrough, through }) {
  const first = Object.keys(history || {}).sort()[0];
  if (!first || !validMonth(through)) return;
  for (let month = `${first}-01`; month <= through; month = shiftMonth(month, 1)) {
    const fromHistory = validMonth(cutoff) && month < cutoff && !(validMonth(historyThrough) && month > historyThrough);
    yield { month, fromHistory, rows: fromHistory ? history[month.slice(0, 4)] : null, index: Number(month.slice(5)) - 1 };
  }
}

/**
 * 土銀帳逐月明細，從歷史第一年 1 月到 through。
 * 歷史月份取原表水電氣列；之後（含待補月份）取記在土銀名下的交易，水電氣以外的支出歸「其他」。
 * 原表每年把上年結餘記成收入，這裡當對帳點：diff 是原表結餘減前期推算，之後以原表數字為準。
 */
export function bankLedger({ history = {}, cutoff, historyThrough, records = {}, mappings = {}, through }) {
  const ledger = [];
  let balance = 0, started = false;
  for (const { month, fromHistory, rows, index } of ledgerMonths({ history, cutoff, historyThrough, through })) {
    const entry = { month, source: fromHistory ? 'history' : 'transactions', opening: null, incomes: [], expenses: Object.fromEntries(BANK_ITEMS.map((k) => [k, 0])), diff: null };
    if (fromHistory) {
      if (!rows) {
        ledger.push({ ...entry, source: 'missing', income: null, expense: null, balance: null });
        balance = null;
        continue;
      }
      for (const row of rows.filter((r) => r.category === '水電氣')) {
        const amount = Number(row.months[index]);
        if (!amount) continue;
        const note = row.tooltips?.[index] || '';
        if (row.item === '收入') {
          if (/結餘|餘額/.test(note)) entry.opening = { amount, note };
          else entry.incomes.push({ amount, note });
        } else if (BANK_ITEMS.includes(row.item)) entry.expenses[row.item] += amount;
      }
    } else {
      for (const it of records[month] || []) {
        if (it.by !== UTILITY_PAYER) continue;
        if (it.type === 'income') entry.incomes.push({ amount: it.amount, note: it.note || it.category });
        if (it.type !== 'expense') continue;
        const group = GROUPS.includes(it.billingGroup) ? it.billingGroup : classify(it.category, mappings);
        const item = group === '水電氣' ? it.category.split('／')[1] : null;
        entry.expenses[BANK_ITEMS.includes(item) ? item : '其他'] += it.amount;
      }
    }
    if (entry.opening) {
      if (started && balance !== null) entry.diff = entry.opening.amount - balance;
      balance = entry.opening.amount;
    }
    started ||= !!entry.opening;
    entry.income = entry.incomes.reduce((s, i) => s + i.amount, 0);
    entry.expense = BANK_ITEMS.reduce((s, k) => s + entry.expenses[k], 0);
    if (balance !== null) balance += entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/**
 * 公積金帳逐月明細：公婆每月額度與各自額外加入的收入，支付房、女兒、兒子與日常（即月消費總額）。
 * 歷史月份取原表家用列與月結；之後取交易：額度用 quotaFor(記帳人, 月份)，額外是記在該人名下的收入，
 * 支出是土銀以外的全部支出。原表年初的「結餘／上月超支」當對帳點；赤盈列另外核對
 * 「公赤盈＋婆赤盈＝額度合計－月消費總額」，gap 為兩者差額。
 */
export function fundLedger({ history = {}, cutoff, historyThrough, records = {}, mappings = {}, through, members = [], quotaFor = () => 0 }) {
  const ledger = [];
  let balance = 0;
  for (const { month, fromHistory, rows, index } of ledgerMonths({ history, cutoff, historyThrough, through })) {
    const shares = FUND_SHARES.map((name, i) => ({ name, member: members[i] || null, quota: 0, extras: [], carry: null }));
    const entry = { month, source: fromHistory ? 'history' : 'transactions', shares, expenses: null, settlement: null, diff: null };
    if (fromHistory && !rows) {
      ledger.push({ ...entry, source: 'missing', income: null, expense: null, balance: null });
      balance = null;
      continue;
    }
    if (fromHistory) {
      for (const share of shares) {
        rows.filter((r) => r.category === '家用' && r.item === share.name).forEach((row, n) => {
          const amount = Number(row.months[index]);
          const note = row.tooltips?.[index] || '';
          // 每人第一列是每月額度，其餘是額外加入；結餘與上月超支是上一期結轉。
          if (n === 0) share.quota = amount;
          else if (!amount) return;
          else if (/結餘|超支/.test(note)) share.carry = { amount: (share.carry?.amount || 0) + amount, note };
          else share.extras.push({ amount, note });
        });
      }
      const s = historySummary(rows, index);
      entry.expenses = s.monthlyTotal === null ? null : { 房: s.house, 女兒: s.daughter, 兒子: s.son, 日常: s.daily };
      const settled = FUND_SHARES.map((name) => rows.find((r) => r.category === '家用' && r.item === `${name}每月赤盈(年末結算)`));
      if (settled.every(Boolean) && s.monthlyTotal !== null) {
        const amounts = settled.map((r) => Number(r.months[index]));
        const expected = shares.reduce((sum, sh) => sum + sh.quota, 0) - s.monthlyTotal;
        entry.settlement = { amounts, expected, gap: amounts[0] + amounts[1] - expected };
      }
    } else {
      const items = (records[month] || []).filter((it) => it.by !== UTILITY_PAYER);
      for (const share of shares) {
        if (!share.member) continue;
        share.quota = quotaFor(share.member, month);
        share.extras = items.filter((it) => it.type === 'income' && it.by === share.member).map((it) => ({ amount: it.amount, note: it.note || it.category }));
      }
      const t = transactionSummary(items, mappings);
      // 自己付的水電氣不經土銀，跟日常一起由公積金支付。
      entry.expenses = { 房: t.house, 女兒: t.daughter, 兒子: t.son, 日常: t.daily + t.utilities };
    }
    const carries = shares.filter((sh) => sh.carry);
    if (carries.length) {
      const amount = carries.reduce((sum, sh) => sum + sh.carry.amount, 0);
      if (balance !== null) entry.diff = amount - balance;
      balance = amount;
    }
    entry.income = shares.reduce((sum, sh) => sum + sh.quota + sh.extras.reduce((s, e) => s + e.amount, 0), 0);
    entry.expense = entry.expenses && FUND_ITEMS.reduce((sum, k) => sum + entry.expenses[k], 0);
    balance = balance === null || entry.expense === null ? null : balance + entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/** 公積金某年的合計。 */
export function fundYear(ledger, year) {
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  const known = months.filter((m) => m.expense !== null);
  const sum = (pick) => known.reduce((s, m) => s + pick(m), 0);
  return { months, quota: sum((m) => m.shares.reduce((s, sh) => s + sh.quota, 0)),
    extra: sum((m) => m.shares.reduce((s, sh) => s + sh.extras.reduce((t, e) => t + e.amount, 0), 0)),
    expense: sum((m) => m.expense), balance: months.at(-1)?.balance ?? null, missing: months.length - known.length };
}

/** 土銀某年的合計；缺資料的月份另計，不當成零。 */
export function bankYear(ledger, year) {
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  const known = months.filter((m) => m.source !== 'missing');
  return { months, income: known.reduce((s, m) => s + m.income, 0), expense: known.reduce((s, m) => s + m.expense, 0),
    balance: months.at(-1)?.balance ?? null, missing: months.length - known.length };
}

export function reportTotals(months) {
  const keys = ['daily', 'house', 'daughter', 'son', 'utilities', 'monthlyTotal', 'total'];
  return Object.fromEntries(keys.map((key) => [key, months.some((m) => m.source === 'missing' || m.source === 'pending' || m[key] == null)
    ? null : months.reduce((sum, m) => sum + m[key], 0)]));
}

/** 分類的年度橫表；歷史日常只有合計，不虛構餐飲等細分類。 */
export function classificationMatrix(months) {
  const rows = new Map();
  const entries = months.map((m) => {
    if (m.source === 'missing' || m.source === 'pending') return [];
    if (m.source === 'transactions') return m.details.map((d) => ({ ...d,
      item: d.item.startsWith(`${d.group}／`) ? d.item.slice(d.group.length + 1) : d.item,
    }));
    return [...m.details.filter((d) => ['(房)', '(女兒)', '(兒子)'].includes(d.group) ||
      (d.group === '水電氣' && ['電費', '水費', '燃氣'].includes(d.item)))
      .map((d) => ({ ...d, group: d.group.replace(/[()]/g, '') })),
    { group: '日常', item: '歷史日常合計', amount: m.daily }];
  });
  entries.forEach((details) => details.forEach((d) => {
    const key = JSON.stringify([d.group, d.item]);
    if (!rows.has(key)) rows.set(key, { group: d.group, item: d.item, key });
  }));
  return [...rows.values()].map((r) => ({ ...r, months: months.map((m, i) => {
    if (m.source === 'missing' || m.source === 'pending' || (m.source === 'history' && r.group === '日常' && r.item !== '歷史日常合計') ||
      (m.source === 'transactions' && r.item === '歷史日常合計')) return null;
    const matching = entries[i].filter((d) => JSON.stringify([d.group, d.item]) === r.key);
    if (matching.some((d) => d.amount === null)) return null;
    return matching.reduce((sum, d) => sum + d.amount, 0);
  }) })).sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.item.localeCompare(b.item, 'zh-Hant'));
}

