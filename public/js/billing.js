// 月結的純計算與分類對應；歷史合計與新交易永遠擇一使用。
import { shiftMonth, isAdjustment } from './calc.js';
import { ruleCategory, childName, escapeRegExp } from './rules.js';
export const GROUPS = ['日常', '房', '女兒', '兒子', '水電氣'];
/** 日常的分類（食衣住行育樂），固定順序。 */
export const DAILY_ORDER = ['食', '衣', '住', '行', '育', '樂', '醫', '其他'];
export const STACK_GROUPS = [
  { key: 'utilities', name: '水電氣', color: '#38bdf8' },
  { key: 'house', name: '房', color: '#4ade80' },
  { key: 'daughter', name: '女兒', color: '#f472b6' },
  { key: 'son', name: '兒子', color: '#a78bfa' },
  { key: 'daily', name: '日常', color: '#fbbf24' },
];
const ITEMS = {
  房: ['還款', '房貸', '管理', '火險', '房屋', '地價', '網路', '其他'],
  女兒: ['美語', '安親班', '補習班', '註冊費', '保險(郵局)', '其他'],
  兒子: ['美語', '安親班', '補習班', '註冊費', '保險(郵局)', '課照', '其他'],
  水電氣: ['電費', '水費', '燃氣'],
};
/** 水電氣由土銀帳戶扣款，記在土銀名下；它不是手機使用者，也沒有額度。 */
export const UTILITY_PAYER = '土銀';
/** 小孩保險的郵局帳戶：保費自動扣款，公、婆轉進去補不足；跟土銀一樣是帳戶，不是記帳人。 */
export const POST_PAYER = '郵局';
/** 帳戶付的錢不經公積金。 */
export const ACCOUNTS = [UTILITY_PAYER, POST_PAYER];
/**
 * 某人這個月自己付的錢：本人名下的支出，加上自己轉進帳戶（帳戶名下的收入標 from）的錢。
 * 公積金帳的每人支出與本月頁的額度條共用，額度就是上繳公積金的額度。
 */
export const memberSpend = (items, person) => items.reduce((sum, it) => sum + (isAdjustment(it) ? 0
  : it.type === 'expense' && it.by === person ? it.amount
    : it.type === 'income' && it.from === person && ACCOUNTS.includes(it.by) ? it.amount : 0), 0);
/** 歷史轉入的房、女兒、兒子與日常由公積金支付，記在公積金名下。 */
export const FUND_PAYER = '公積金';
/** 原表 12 月記在公、婆名下的「年末均攤」：補平全年超支的額外加入，不算進當年赤盈，也不是家庭收入。 */
export const SETTLE_NOTE = /^年末均攤/;
/** 土銀某年的水電氣預算，存在 budgets.土銀.<年>；沒設定回傳 0。 */
export const utilityBudget = (settings, year) =>
  Number(settings?.budgets?.[UTILITY_PAYER]?.[year] ?? settings?.budgets?.[UTILITY_PAYER]?.default ?? 0);
/** 某人某月的支出額度，也是上繳公積金的額度；該月沒單獨設定就用 default。 */
export const monthlyBudget = (settings, person, month) =>
  Number(settings?.budgets?.[person]?.[month] ?? settings?.budgets?.[person]?.default ?? 0);
export const BILLING_CATEGORIES = Object.entries(ITEMS).flatMap(([group, items]) => items.map((item) => `${group}／${item}`));
export const validMonth = (value) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value || '');

/** 歷史已轉成交易後，月結全部改讀交易；否則截止月以前讀歷史月結。 */
export const reportCutoff = (archive) => validMonth(archive?.migratedThrough) ? null : archive?.cutoverMonth;

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

/**
 * 孩子的安親班、補習班要寫明是誰：女兒／妹妹、兒子／哥哥，或私人設定 children 裡的名字。
 * 依序是女兒安親、兒子安親、女兒補習、兒子補習。
 */
const kidRules = (children) => [['安親', '安親班'], ['補習', '補習班']].flatMap(([word, item]) =>
  [['女兒', '妹妹'], ['兒子', '哥哥']].map(([group, alias]) => {
    const who = [group, alias, childName(children, group)].filter(Boolean).map(escapeRegExp).join('|');
    return [new RegExp(`(${who}).*(${word})|${word}.*(${who})`), `${group}／${item}`];
  }));

/** 依內容判斷分類的關鍵字，依序比對，先中先用。子女的項目要寫明是誰，否則交給以前的紀錄或手動選。 */
const GUESS_RULES = {
  expense: (children) => [
    [/電費|台電/, '水電氣／電費'], [/水費|自來水/, '水電氣／水費'], [/燃氣|瓦斯費|天然氣費/, '水電氣／燃氣'],
    [/房貸|還款/, '房／還款'], [/管理費/, '房／管理'], [/火險|地震險/, '房／火險'], [/房屋稅/, '房／房屋'], [/地價稅/, '房／地價'],
    [/網路費|寬頻|中華電信|亞訊|wifi/i, '房／網路'],
    [/課照|課後照顧/, '兒子／課照'],
    ...kidRules(children),
    [/uber ?eats|uber 生鮮|foodpanda|熊貓/i, '食'],
    [/藥|診所|醫院|掛號|門診|眼科|牙醫|牙科|齒科|看病|健保|中醫|骨科|耳鼻喉|食鹽水|洗鼻|保健|維他命|葉黃素|鈣|益生菌|喉片|喉嚨|龍角散|快篩/, '醫'],
    [/加油|停車|parking|高鐵|台鐵|火車|捷運|公車|電車|uber|taxi|計程車|悠遊卡|etag|油錢|機票|機油|齒輪油|機車|燃料|強制險|輪胎|罰單|電瓶|雪鏈|安全帽|門號|台哥大|esim|電信/i, '行'],
    [/(?<!洗)衣(?!櫃|架)|褲|鞋|襪|帽|外套|制服|NET|nike|adidas|puma|skechers|思夢樂|lativ|uniqlo|名牌/i, '衣'],
    [/清潔|洗衣|洗碗|洗髮|洗面|洗臉|拖把|好神拖|殺蟑|蚊|燈泡|燈管|電池|收納|保鮮盒|真空袋|衛生紙|面紙|紙巾|牙刷|牙膏|肥皂|皂|抹布|垃圾袋|棉被|床墊|櫃|鐵架|濾網|濾芯|吸塵|五金|螺絲|手套|雨傘|碗|砧板|刨刀|古寶|寶雅|大創|小北|ikea|宜家|妙管家|化妝水|乳液|防曬|瓦斯|天然氣|手機殼|手機架|耳機|冰箱|電鍋|家電|衣架|日用/i, '住'],
    [/課|才藝|教材|參考書|評量|自修|文具|筆|書包|補習|學費|報名費|繡學號|學號/, '育'],
    [/電影|影城|門票|全票|遊樂|樂園|ktv|netflix|遊戲|桌遊|展覽|博物館|美術館|(?<!麵|飯|餐|咖啡|茶)館|農場|溫泉|露營|泳池|大魯閣|sega|旅費|營費|冬令營|夏令營|卡丁車|威力彩|彩券/i, '樂'],
    [/零用錢|生日金|禮金|紅包|奠|捐款|香油錢|金紙|普渡/, '其他'],
    [/全聯|家樂福|好市多|costco|大買家|美廉社|萊爾富|超市|市場|蔬果|蔬菜|青菜|水果|肉|魚|蝦|食材|雞蛋|鮮奶|水餃|米\d|^米$|零食|餅乾|糖果|餐|飯|麵|便當|早餐|午餐|晚餐|宵夜|飲料|手搖|咖啡|奶茶|麥當勞|肯德基|KFC|摩斯|必勝客|達美樂|五十嵐|星巴克|7-11|全家|小吃|火鍋|麻辣|餛飩|煎包|肉羹|碳烤|燒烤|壽司|拉麵|滷味|雞排|鹹酥雞|鹹水雞|炸|珍奶|紅茶|豆花|冰|甜甜圈|包子|饅頭|薯條|鐵板燒|蛋糕|泡芙|蔥抓餅|蛋餅|三明治|pizza|披薩|coco|燒臘|臭豆腐|鍋|烤|豆漿|雞塊|麥味登|夜市|羊博士|吐司|麵包/i, '食'],
  ],
  income: () => [
    [/年終/, '年終獎金'], [/獎金/, '獎金'], [/薪|薪水|薪資/, '薪資'], [/紅包/, '紅包'], [/退款|退費|刷退|退稅/, '退款'], [/發票|中獎/, '其他'],
  ],
};

/**
 * 依「內容」判斷分類：先沿用以前同樣內容最近一次的分類，再看使用者的關鍵字規則（設定 rules.keywords），
 * 最後看內建關鍵字；判斷不出來回傳 null。allowed 是目前可選的分類，判斷結果一定在裡面。
 * children 是設定裡的孩子名字，寫了名字的安親班、補習班才分到那個孩子。
 */
export function guessCategory(note, type, history = [], allowed = [], keywords = [], children = {}) {
  const text = String(note || '').trim().toLowerCase();
  if (!text) return null;
  const ok = (category) => allowed.includes(category);
  const past = history.filter((it) => it.type === type && String(it.note || '').trim().toLowerCase() === text && ok(it.category))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (past) return past.category;
  const ruled = type === 'expense' ? ruleCategory(text, keywords, allowed) : null;
  if (ruled) return ruled;
  for (const [pattern, category] of GUESS_RULES[type]?.(children) || []) if (pattern.test(text) && ok(category)) return category;
  return null;
}

/** 支出算進的大項：記帳時存下的歸屬優先，否則依分類判斷。 */
export const expenseGroup = (it, mappings = {}) => GROUPS.includes(it.billingGroup) ? it.billingGroup : classify(it.category, mappings);

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
  next.rules ||= { aliases: [], keywords: [] };
  return next;
}

export function transactionSummary(items, mappings = {}) {
  const result = { daily: 0, house: 0, daughter: 0, son: 0, utilities: 0, monthlyTotal: 0, total: 0, income: 0, details: [], incomeDetails: [] };
  const keys = { 日常: 'daily', 房: 'house', 女兒: 'daughter', 兒子: 'son', 水電氣: 'utilities' };
  const details = new Map();
  const incomes = new Map();
  for (const it of items) {
    // 公婆轉進帳戶（標 from）是自己的錢搬家，年末均攤是公婆互貼公積金，都不是收入。
    if (isAdjustment(it) || (it.type === 'income' && (it.from || SETTLE_NOTE.test(it.note || '')))) continue;
    // 記在公積金名下的收入（儲值、發票中獎、與原表差額）沿用原表算法，抵扣當月日常。
    if (it.type === 'income' && it.by === FUND_PAYER) {
      result.daily -= it.amount;
      const key = JSON.stringify(['日常', it.category]);
      const detail = details.get(key) || { group: '日常', item: it.category, amount: 0, note: '' };
      detail.amount -= it.amount;
      details.set(key, detail);
      continue;
    }
    if (it.type === 'income') {
      result.income += it.amount;
      const detail = incomes.get(it.category) || { group: '收入', item: it.category, amount: 0, note: '' };
      detail.amount += it.amount; incomes.set(it.category, detail);
      continue;
    }
    if (it.type !== 'expense') continue;
    const group = expenseGroup(it, mappings);
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
  for (const [key, name] of [['total', '家庭總支出'], ['monthlyTotal', '月消費總額（不含水電氣）'], ['daily', '扣除列項後開銷'], ...STACK_GROUPS.filter((g) => g.key !== 'daily').map((g) => [g.key, g.name])]) {
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
/** 原表額外加入裡拿來還房貸的錢，算成當月額度（記帳改設定的額度，不記收入）。 */
export const QUOTA_EXTRA = /結清房貸|提前還款/;

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
/** 結餘調整交易的帶號合計：收入加、支出減。 */
const addAdjust = (adjust, it) => ({ amount: (adjust?.amount || 0) + (it.type === 'income' ? it.amount : -it.amount),
  note: [adjust?.note, it.note].filter(Boolean).join('、') });

export function bankLedger({ history = {}, cutoff, historyThrough, records = {}, mappings = {}, through }) {
  const ledger = [];
  let balance = 0, started = false;
  for (const { month, fromHistory, rows, index } of ledgerMonths({ history, cutoff, historyThrough, through })) {
    const entry = { month, source: fromHistory ? 'history' : 'transactions', opening: null, adjust: null, incomes: [], expenses: Object.fromEntries(BANK_ITEMS.map((k) => [k, 0])), diff: null };
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
        if (isAdjustment(it)) { entry.adjust = addAdjust(entry.adjust, it); continue; }
        if (it.type === 'income') entry.incomes.push({ amount: it.amount, note: it.note || it.category, date: it.date });
        if (it.type !== 'expense') continue;
        const group = expenseGroup(it, mappings);
        const item = group === '水電氣' ? it.category.split('／')[1] : null;
        entry.expenses[BANK_ITEMS.includes(item) ? item : '其他'] += it.amount;
      }
    }
    if (entry.opening) {
      if (started && balance !== null) entry.diff = entry.opening.amount - balance;
      balance = entry.opening.amount;
    }
    started ||= !!entry.opening;
    if (entry.adjust) {
      if (ledger.length) entry.diff = entry.adjust.amount;
      if (balance !== null) balance += entry.adjust.amount;
    }
    entry.income = entry.incomes.reduce((s, i) => s + i.amount, 0);
    entry.expense = BANK_ITEMS.reduce((s, k) => s + entry.expenses[k], 0);
    if (balance !== null) balance += entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/**
 * 郵局帳逐月明細，從第一筆郵局紀錄的月份到 through：收入（理賠、紅包、利息，或標 from 的公婆轉入）、
 * 保費（郵局名下的支出）與餘額。公婆轉進去補保費的錢記在本人名下的保險支出，不經郵局帳，
 * 所以這裡的保費只是餘額付的部分；結餘調整是存摺的期初結餘。
 */
export function postLedger({ records = {}, through }) {
  const first = Object.keys(records).filter((m) => (records[m] || []).some((it) => it.by === POST_PAYER)).sort()[0];
  const ledger = [];
  if (!first || !validMonth(through)) return ledger;
  let balance = 0;
  for (let month = first; month <= through; month = shiftMonth(month, 1)) {
    const items = (records[month] || []).filter((it) => it.by === POST_PAYER);
    const entry = { month, adjust: null, incomes: [], premiums: [] };
    for (const it of items) {
      if (isAdjustment(it)) entry.adjust = addAdjust(entry.adjust, it);
      else (it.type === 'income' ? entry.incomes : entry.premiums).push({ amount: it.amount, note: it.note || it.category, date: it.date, category: it.category });
    }
    entry.income = entry.incomes.reduce((s, i) => s + i.amount, 0);
    entry.expense = entry.premiums.reduce((s, i) => s + i.amount, 0);
    balance += (entry.adjust?.amount || 0) + entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/**
 * 公積金帳逐月明細：公婆每月額度與額外加入，減去兩人為家裡付的錢（房、女兒、兒子、日常，以及轉進土銀、郵局的錢）。
 * 歷史月份取原表家用列與月結，原表年初的「結餘／上月超支」當對帳點，赤盈列另外核對
 * 「公赤盈＋婆赤盈＝額度合計－月消費總額」，gap 為兩者差額。
 * 交易月份照年末結算的規則：公積金名下（共同皮包）等不是公婆的收支同原表不算，另列 shared；
 * 原表開始逐人結算那年（有赤盈列的第一年）1 月以原表結轉為期初，之前沒有餘額；
 * 之後每年 1 月，上一年記過年末均攤就歸零（opening.residual 是均攤後還剩的差），沒記就整筆轉入。
 * legacy 是轉換與整理工具核對用的舊算法：帳戶以外的收支全算、結餘調整照記、餘額連續累計，跟原表的月結逐月相同。
 */
export function fundLedger({ history = {}, cutoff, historyThrough, records = {}, mappings = {}, through, members = [], quotaFor = () => 0, legacy = false }) {
  const ledger = [];
  const start = Object.keys(history).sort().find((y) => history[y]?.some((r) => r.category === '家用' && r.item === `${FUND_SHARES[0]}每月赤盈(年末結算)`));
  let balance = 0, settled = false;
  for (const { month, fromHistory, rows, index } of ledgerMonths({ history, cutoff, historyThrough, through })) {
    const shares = FUND_SHARES.map((name, i) => ({ name, member: members[i] || null, quota: 0, extras: [], carry: null, spend: fromHistory ? null : 0 }));
    const entry = { month, source: fromHistory ? 'history' : 'transactions', shares, expenses: null, transfer: 0, shared: 0, settlement: null, opening: null, adjust: null, diff: null };
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
          else if (QUOTA_EXTRA.test(note)) share.quota += amount;
          else if (/結餘|超支/.test(note)) share.carry = { amount: (share.carry?.amount || 0) + amount, note };
          else share.extras.push({ amount, note });
        });
      }
      const s = historySummary(rows, index);
      entry.expenses = s.monthlyTotal === null ? null : { 房: s.house, 女兒: s.daughter, 兒子: s.son, 日常: s.daily };
      const settledRows = FUND_SHARES.map((name) => rows.find((r) => r.category === '家用' && r.item === `${name}每月赤盈(年末結算)`));
      if (settledRows.every(Boolean) && s.monthlyTotal !== null) {
        const amounts = settledRows.map((r) => Number(r.months[index]));
        const expected = shares.reduce((sum, sh) => sum + sh.quota, 0) - s.monthlyTotal;
        entry.settlement = { amounts, expected, gap: amounts[0] + amounts[1] - expected };
      }
      const carries = shares.filter((sh) => sh.carry);
      if (carries.length) {
        const amount = carries.reduce((sum, sh) => sum + sh.carry.amount, 0);
        if (balance !== null) entry.diff = amount - balance;
        balance = amount;
      }
    } else {
      const all = records[month] || [];
      const names = shares.map((sh) => sh.member).filter(Boolean);
      const items = all.filter((it) => (legacy ? !ACCOUNTS.includes(it.by) : names.includes(it.by)) && !isAdjustment(it));
      if (legacy) for (const it of all.filter((x) => !ACCOUNTS.includes(x.by) && isAdjustment(x))) entry.adjust = addAdjust(entry.adjust, it);
      for (const share of shares) {
        if (!share.member) continue;
        share.quota = quotaFor(share.member, month);
        share.extras = items.filter((it) => it.type === 'income' && it.by === share.member).map((it) => ({ amount: it.amount, note: it.note || it.category, date: it.date }));
        share.spend = memberSpend(all, share.member);
      }
      const t = transactionSummary(items, mappings);
      // 自己付的水電氣不經土銀，跟日常一起由公積金支付。
      entry.expenses = { 房: t.house, 女兒: t.daughter, 兒子: t.son, 日常: t.daily + t.utilities };
      if (legacy) {
        if (entry.adjust) {
          if (ledger.length) entry.diff = entry.adjust.amount;
          if (balance !== null) balance += entry.adjust.amount;
        }
      } else {
        entry.transfer = all.filter((it) => ACCOUNTS.includes(it.by) && it.type === 'income' && names.includes(it.from)).reduce((s, it) => s + it.amount, 0);
        const o = transactionSummary(all.filter((it) => !names.includes(it.by) && !ACCOUNTS.includes(it.by) && !isAdjustment(it)), mappings);
        entry.shared = o.monthlyTotal + o.utilities;
        const year = month.slice(0, 4);
        if (start && year < start) balance = null;
        else if (start && month === `${start}-01`) {
          balance = historyCarry(history[start]).reduce((s, n) => s + n, 0);
          entry.opening = { amount: balance, first: true };
        } else if (month.endsWith('-01') && balance !== null && ledger.length) {
          entry.opening = settled ? { amount: 0, residual: balance } : { amount: balance };
          if (settled) balance = 0;
        }
        if (month.endsWith('-01')) settled = false;
        settled ||= shares.some((sh) => sh.extras.some((e) => SETTLE_NOTE.test(e.note || '')));
      }
    }
    entry.income = shares.reduce((sum, sh) => sum + sh.quota + sh.extras.reduce((s, e) => s + e.amount, 0), 0);
    entry.expense = entry.expenses && FUND_ITEMS.reduce((sum, k) => sum + entry.expenses[k], 0) + entry.transfer;
    balance = balance === null || entry.expense === null ? null : balance + entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/** 拆成兩份，奇數的 1 元給第一位。 */
const halves = (n) => [n - Math.trunc(n / 2), Math.trunc(n / 2)];
/** 原表 1 月家用列的結餘／上月超支：上一年轉入的赤盈。 */
const historyCarry = (rows) => FUND_SHARES.map((name) => rows.filter((r) => r.category === '家用' && r.item === name).slice(1)
  .reduce((s, r) => s + (/結餘|超支/.test(r.tooltips?.[0] || '') ? Number(r.months[0]) || 0 : 0), 0));
/** 年末均攤的備註，同原表：「年末均攤,-6258-23378」是自己的赤盈，再加上替對方付（－）或對方替自己付（＋）的部分。 */
const settleNote = (balance, pay) => `年末均攤,${[balance, -pay - balance].map((n) => `${n < 0 ? '-' : '+'}${Math.abs(n)}`).join('')}`;

/**
 * 公積金某年的年末結算（原表 2022 年起的「公／婆每月赤盈(年末結算)」）。
 * 每人赤盈＝年初結轉＋額度＋額外加入－自己記的支出（含轉進土銀的錢）；公積金名下的收支同原表不算。
 * 合計超支時兩人均攤（互貼），各記一筆 12 月的年末均攤；有結餘時各自轉入下一年。
 * 年初結轉接前一年的結算；開始逐人結算那年（原表有赤盈列的第一年）取原表 1 月的結餘／上月超支。
 * 原表沒有赤盈列的年份（2021 以前）、或還有歷史月份時回傳 null。
 */
export function fundSettlement({ ledger, history = {}, year }) {
  const rows = history[year];
  if (rows && !rows.some((r) => r.category === '家用' && r.item === `${FUND_SHARES[0]}每月赤盈(年末結算)`)) return null;
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  if (!months.length || months.some((m) => m.source !== 'transactions')) return null;
  // 年初結轉接前一年算出來的結果（同公積金帳的規則）；開始逐人結算那年沒有前一年，取原表 1 月的結餘／上月超支。
  const previous = fundSettlement({ ledger, history, year: String(Number(year) - 1) });
  const carry = previous ? previous.next : rows ? historyCarry(rows) : [0, 0];
  const extra = (sh, settle) => sh.extras.reduce((s, e) => s + (SETTLE_NOTE.test(e.note || '') === settle ? e.amount : 0), 0);
  const shares = FUND_SHARES.map((name, i) => {
    const sum = (pick) => months.reduce((s, m) => s + pick(m.shares[i]), 0);
    const monthly = months.map((m) => [m.month, m.shares[i].quota + extra(m.shares[i], false) - m.shares[i].spend]);
    const share = { name, member: months[0].shares[i].member, carry: carry[i], quota: sum((sh) => sh.quota), extra: sum((sh) => extra(sh, false)),
      spend: sum((sh) => sh.spend), settled: sum((sh) => extra(sh, true)), monthly };
    return { ...share, balance: share.carry + share.quota + share.extra - share.spend };
  });
  const total = shares[0].balance + shares[1].balance;
  const pays = total < 0 ? halves(-total) : null;
  if (pays) shares.forEach((sh, i) => Object.assign(sh, { pay: pays[i], note: settleNote(sh.balance, pays[i]) }));
  return { year, through: months.at(-1).month, shares, total, recorded: shares.some((sh) => sh.settled),
    next: pays ? [0, 0] : shares.map((sh) => sh.balance) };
}

/**
 * 房貸逐期明細（本息平均攤還）：每期月繳＝餘額 × r／(1−(1+r)^−剩餘期數)，提前還本或利率調整後銀行重算月繳。
 * loan.json 存撥款條件、存摺上的每筆扣款，以及銀行往來明細上的未還本金（balances：[日期, 扣款, 扣款後未還本金]）。
 * 利率由月繳變動反推（二分搜尋），利息先按 餘額 × 年利率／12 估；遇到 balances 的對帳點，就把上一個對帳點以來的利息
 * 校正成「這段扣款合計－本金減少」，按估算比例分給各期，所以有明細的月份就是銀行的數字，沒有明細的期間合計也準。
 * 最後一期（餘額不到一期月繳）利息＝扣款－剩餘本金。
 */
const annuity = (balance, rate, n) => { const r = rate / 1200; return balance * r / (1 - (1 + r) ** -n); };
export function loanSchedule(loan) {
  let balance = loan.principal, n = loan.months, rate = loan.firstRate, regular = null;
  const checkpoints = new Map((loan.balances || []).map(([date, amount, after]) => [`${date}|${amount}`, after]));
  const rows = [];
  let segment = 0, segmentStart = loan.principal;
  for (const [date, kind, amount] of loan.payments) {
    if (kind === '提前還本') {
      balance -= amount;
      rows.push({ date, kind, amount, interest: 0, principal: amount, balance, rate });
    } else if (balance <= amount) {
      rows.push({ date, kind, amount, interest: amount - balance, principal: balance, balance: 0, rate });
      balance = 0;
    } else {
      if (regular !== null && amount !== regular) {
        let lo = 0.01, hi = 20;
        for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; annuity(balance, mid, n) > amount ? hi = mid : lo = mid; }
        rate = (lo + hi) / 2;
      }
      regular = amount;
      const interest = balance * rate / 1200;
      balance -= amount - interest;
      n--;
      rows.push({ date, kind, amount, interest, principal: amount - interest, balance, rate });
    }
    const checked = checkpoints.get(`${date}|${amount}`);
    if (checked === undefined) continue;
    // 對帳點：這一段的利息＝扣款合計－本金減少，按估算的利息比例分配，餘額照銀行。
    const part = rows.slice(segment);
    const exact = part.reduce((t, r) => t + r.amount, 0) - (segmentStart - checked);
    const estimate = part.reduce((t, r) => t + r.interest, 0);
    const regulars = part.filter((r) => r.kind !== '提前還本');
    let running = segmentStart;
    for (const r of part) {
      if (r.kind !== '提前還本') r.interest = estimate ? r.interest * exact / estimate : exact / regulars.length;
      r.principal = r.amount - r.interest;
      running -= r.principal;
      r.balance = running;
      // 這段只有一期月繳時，利息就是銀行明細的數字；多期的是按估算比例分配。
      r.exact = regulars.length <= 1;
    }
    part.at(-1).balance = checked;
    balance = segmentStart = checked;
    segment = rows.length;
  }
  const years = new Map();
  for (const r of rows) {
    const y = years.get(r.date.slice(0, 4)) || { year: r.date.slice(0, 4), regular: 0, prepaid: 0, interest: 0, balance: 0 };
    y[r.kind === '提前還本' ? 'prepaid' : 'regular'] += r.amount;
    y.interest += r.interest;
    y.balance = r.balance;
    years.set(y.year, y);
  }
  const paid = rows.reduce((s, r) => s + r.amount, 0);
  return { rows, years: [...years.values()], paid, interest: paid - loan.principal + Math.round(balance), balance: Math.round(balance) };
}

/** 公積金某年的合計。 */
export function fundYear(ledger, year) {
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  const known = months.filter((m) => m.expense !== null);
  const sum = (pick) => known.reduce((s, m) => s + pick(m), 0);
  return { months, quota: sum((m) => m.shares.reduce((s, sh) => s + sh.quota, 0)),
    extra: sum((m) => m.shares.reduce((s, sh) => s + sh.extras.reduce((t, e) => t + e.amount, 0), 0)),
    expense: sum((m) => m.expense), transfer: sum((m) => m.transfer), shared: sum((m) => m.shared),
    balance: months.at(-1)?.balance ?? null, missing: months.length - known.length };
}

/** 土銀某年的合計；缺資料的月份另計，不當成零。 */
export function bankYear(ledger, year) {
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  const known = months.filter((m) => m.source !== 'missing');
  return { months, income: known.reduce((s, m) => s + m.income, 0), expense: known.reduce((s, m) => s + m.expense, 0),
    balance: months.at(-1)?.balance ?? null, missing: months.length - known.length };
}

/**
 * 一段期間的占比：大項（月結口徑，公積金收入抵扣日常）、支出分類、日常內容排行。
 * 內容排行依備註空格前的第一個詞（店名）合計，例如「7-11」「7-11 早餐」都算 7-11，
 * 空格後的品項列在 parts；沒寫備註的不列。pick 是要排行的大項（日常、房…）或單一分類（食、衣…）；
 * picks 是期間內有支出的選項：日常、日常底下的分類、其他大項。
 */
export function shareSummary(items, mappings = {}, top = 10, by = 'amount', pick = '日常') {
  const summary = transactionSummary(items, mappings);
  const groups = STACK_GROUPS.map((g) => ({ name: g.name, color: g.color, amount: summary[g.key] }))
    .filter((g) => g.amount).sort((a, b) => b.amount - a.amount);
  const categories = new Map(), notes = new Map(), groupOf = new Map(), groupTotals = new Map();
  let topTotal = 0;
  for (const it of items) {
    if (it.type !== 'expense' || isAdjustment(it)) continue;
    categories.set(it.category, (categories.get(it.category) || 0) + it.amount);
    const group = expenseGroup(it, mappings);
    groupOf.set(it.category, group);
    groupTotals.set(group, (groupTotals.get(group) || 0) + it.amount);
    if (GROUPS.includes(pick) ? group !== pick : it.category !== pick) continue;
    topTotal += it.amount;
    // 沒寫內容的（例如電費、水費）用分類的項目名稱排行。
    const note = String(it.note || '').trim() || it.category.split('／').pop();
    const [store, ...rest] = note.split(/\s+/);
    const entry = notes.get(store) || { name: store, amount: 0, count: 0, parts: new Map() };
    entry.amount += it.amount;
    entry.count++;
    const part = rest.join(' ');
    const sub = entry.parts.get(part) || { name: part, amount: 0, count: 0 };
    sub.amount += it.amount;
    sub.count++;
    entry.parts.set(part, sub);
    notes.set(store, entry);
  }
  const categoryList = [...categories].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  // 日常依食衣住行育樂醫其他的固定順序，再接其他大項。
  const picks = [...DAILY_ORDER.filter((c) => categories.get(c) && groupOf.get(c) === '日常'), ...GROUPS.filter((g) => g !== '日常' && groupTotals.get(g))];
  return {
    total: summary.total, groups, picks, topTotal,
    categories: categoryList,
    top: [...notes.values()].sort((a, b) => (by === 'count' ? b.count - a.count : 0) || b.amount - a.amount).slice(0, top)
      .map((t) => ({ ...t, parts: [...t.parts.values()].sort((a, b) => (by === 'count' ? b.count - a.count : 0) || b.amount - a.amount) })),
  };
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

