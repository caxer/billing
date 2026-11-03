// 月結的純計算與分類對應，全部由交易算出。
import { shiftMonth, isAdjustment, byCategory } from './calc.js';
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
/** 歷史轉入的房、女兒、兒子與日常由公積金支付，記在公積金名下。 */
export const FUND_PAYER = '公積金';
/** 記帳人名單裡不是人的名字：土銀、郵局是帳戶，公積金是兩人共用的皮包。 */
export const NON_MEMBERS = [...ACCOUNTS, FUND_PAYER];
export const isMember = (name) => !NON_MEMBERS.includes(name);
/**
 * 特殊紀錄明寫種類（kind），不靠備註或分類判斷：
 * transfer 公婆轉進土銀、郵局（帳戶名下的收入，from 是轉錢的人）、settlement 年末均攤、adjustment 結餘調整。一般收支沒有 kind。
 */
export const KINDS = ['transfer', 'settlement', 'adjustment'];
export const isTransfer = (it) => it.kind === 'transfer';
export const isSettlement = (it) => it.kind === 'settlement';
/**
 * 某人這個月自己付的錢：本人名下的支出，加上自己轉進帳戶的錢。
 * 公積金帳的每人支出與本月頁的額度條共用，額度就是上繳公積金的額度。
 */
export const memberSpend = (items, person) => items.reduce((sum, it) => sum + (isAdjustment(it) ? 0
  : it.type === 'expense' && it.by === person ? it.amount
    : isTransfer(it) && it.from === person ? it.amount : 0), 0);
/** 紀錄有沒有用到這位記帳人：自己記的（by），或從他轉進帳戶的錢（from）。 */
export const usesPerson = (it, person) => it.by === person || it.from === person;
/** 記帳人改名：by 與 from 都改（memberSpend、公積金帳的轉帳用 from 對名字），回傳改了幾筆。 */
export function renamePerson(items, from, to) {
  let count = 0;
  for (const it of items) {
    if (!usesPerson(it, from)) continue;
    if (it.by === from) it.by = to;
    if (it.from === from) it.from = to;
    count++;
  }
  return count;
}
/** 土銀某年的水電氣預算，存在 budgets.土銀.<年>；沒設定回傳 0。 */
export const utilityBudget = (settings, year) =>
  Number(settings?.budgets?.[UTILITY_PAYER]?.[year] ?? settings?.budgets?.[UTILITY_PAYER]?.default ?? 0);
/** 某人某月的支出額度，也是上繳公積金的額度；該月沒單獨設定就用 default。 */
export const monthlyBudget = (settings, person, month) =>
  Number(settings?.budgets?.[person]?.[month] ?? settings?.budgets?.[person]?.default ?? 0);
export const BILLING_CATEGORIES = Object.entries(ITEMS).flatMap(([group, items]) => items.map((item) => `${group}／${item}`));
export const validMonth = (value) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value || '');

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
  // 公積金帳：公、婆各對應哪位記帳人，以及開始逐人結算的月份與期初結轉。沒設定時先取名單前兩位，存檔時寫進設定。
  next.fund ||= { start: null, shares: (next.people || []).filter(isMember).slice(0, 2).map((member, i) => ({ name: ['公', '婆'][i], member, carry: 0 })) };
  if (!validFund(next.fund)) throw new Error('設定的公積金（fund）格式損毀');
  return next;
}

/** fund：start 是月份或 null，shares 每格有名稱、記帳人與整數的期初結轉。 */
const validFund = (fund) => (fund.start === null || validMonth(fund.start)) && Array.isArray(fund.shares) && fund.shares.length <= 2 &&
  fund.shares.every((sh) => typeof sh?.name === 'string' && sh.name.length <= 10 && typeof sh.member === 'string' && Number.isSafeInteger(sh.carry));

export function transactionSummary(items, mappings = {}) {
  const result = { daily: 0, house: 0, daughter: 0, son: 0, utilities: 0, monthlyTotal: 0, total: 0, income: 0, fundIncome: 0, details: [], incomeDetails: [] };
  const keys = { 日常: 'daily', 房: 'house', 女兒: 'daughter', 兒子: 'son', 水電氣: 'utilities' };
  const details = new Map();
  const incomes = new Map();
  for (const it of items) {
    // 公婆轉進帳戶是自己的錢搬家，年末均攤是公婆互貼公積金，都不是收入。
    if (isAdjustment(it) || isTransfer(it) || isSettlement(it)) continue;
    // 記在公積金名下的收入（儲值、發票中獎、與原表差額）沿用原表算法，抵扣當月日常。
    if (it.type === 'income' && it.by === FUND_PAYER) {
      result.daily -= it.amount;
      result.fundIncome += it.amount;
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

/** 公積金名下收入抵扣日常的那一行：分類列表裡另列成負數（offset），分類合計加這一行＝支出格。 */
export const FUND_OFFSET = '公積金抵扣';

/**
 * 本月頁的分類佔比，由大到小。收入和收入格同一套規則（transactionSummary 的 incomeDetails）：
 * 轉進帳戶、年末均攤、公積金名下收入都不算。支出是各分類的原始金額，最後另列公積金抵扣。
 */
export function categoryShare(items, type, mappings = {}) {
  const summary = transactionSummary(items, mappings);
  if (type === 'income') return summary.incomeDetails.map((d) => ({ name: d.item, total: d.amount })).sort((a, b) => b.total - a.total);
  const list = byCategory(items, 'expense');
  return summary.fundIncome ? [...list, { name: FUND_OFFSET, total: -summary.fundIncome, offset: true }] : list;
}

export const itemKey = (group, item) => JSON.stringify([group, item]);
export function monthItems(month) {
  const entries = new Map();
  for (const detail of [...(month.details || []), ...(month.incomeDetails || [])]) {
    const group = detail.group;
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

export const itemValue = (month, key, entries = monthItems(month)) => entries.get(key)?.amount ?? 0;

export function percentChange(current, previous) {
  return current == null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}

export function annualReport(year, records, mappings = {}) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    return { ...transactionSummary(records[month] || [], mappings), month };
  });
}

export const BANK_ITEMS = ['電費', '水費', '燃氣', '其他'];
export const FUND_ITEMS = ['房', '女兒', '兒子', '日常'];
/** 帳本從第一筆紀錄的月份逐月走到 through。 */
function* ledgerMonths(records, through) {
  const first = Object.keys(records).sort()[0];
  if (!first || !validMonth(through)) return;
  for (let month = first; month <= through; month = shiftMonth(month, 1)) yield month;
}

/** 結餘調整交易的帶號合計：收入加、支出減。 */
const addAdjust = (adjust, it) => ({ amount: (adjust?.amount || 0) + (it.type === 'income' ? it.amount : -it.amount),
  note: [adjust?.note, it.note].filter(Boolean).join('、') });

/**
 * 土銀帳逐月明細：記在土銀名下的交易，水電氣以外的支出歸「其他」。
 * 結餘調整第一個月是期初，之後的 diff 是調整的金額。
 */
export function bankLedger({ records = {}, mappings = {}, through }) {
  const ledger = [];
  let balance = 0;
  for (const month of ledgerMonths(records, through)) {
    const entry = { month, adjust: null, incomes: [], expenses: Object.fromEntries(BANK_ITEMS.map((k) => [k, 0])), diff: null };
    for (const it of records[month] || []) {
      if (it.by !== UTILITY_PAYER) continue;
      if (isAdjustment(it)) { entry.adjust = addAdjust(entry.adjust, it); continue; }
      if (it.type === 'income') entry.incomes.push({ amount: it.amount, note: it.note || it.category, date: it.date });
      if (it.type !== 'expense') continue;
      const group = expenseGroup(it, mappings);
      const item = group === '水電氣' ? it.category.split('／')[1] : null;
      entry.expenses[BANK_ITEMS.includes(item) ? item : '其他'] += it.amount;
    }
    if (entry.adjust) {
      if (ledger.length) entry.diff = entry.adjust.amount;
      balance += entry.adjust.amount;
    }
    entry.income = entry.incomes.reduce((s, i) => s + i.amount, 0);
    entry.expense = BANK_ITEMS.reduce((s, k) => s + entry.expenses[k], 0);
    balance += entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/**
 * 郵局帳逐月明細，從第一筆郵局紀錄的月份到 through：收入（理賠、紅包、利息，或公婆轉入）、
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
 * fund 是設定裡的公積金：shares 是公、婆各對應哪位記帳人與期初結轉，start 是開始逐人結算的月份（之前沒有餘額）。
 * 公積金名下（共同皮包）等不是公婆的收支不算，另列 shared。之後每年 1 月，上一年記過年末均攤就歸零
 * （opening.residual 是均攤後還剩的差），沒記就整筆轉入。
 */
export function fundLedger({ records = {}, mappings = {}, through, fund, quotaFor = () => 0 }) {
  const ledger = [];
  const config = fund?.shares || [], start = fund?.start || null;
  const names = config.map((sh) => sh.member);
  let balance = 0, settled = false;
  for (const month of ledgerMonths(records, through)) {
    const all = records[month] || [];
    const items = all.filter((it) => names.includes(it.by) && !isAdjustment(it));
    const shares = config.map((sh) => ({ name: sh.name, member: sh.member, quota: quotaFor(sh.member, month),
      extras: items.filter((it) => it.type === 'income' && it.by === sh.member)
        .map((it) => ({ amount: it.amount, note: it.note || it.category, date: it.date, ...(isSettlement(it) ? { settlement: true } : {}) })),
      spend: memberSpend(all, sh.member) }));
    const t = transactionSummary(items, mappings);
    // 自己付的水電氣不經土銀，跟日常一起由公積金支付。
    const entry = { month, shares, expenses: { 房: t.house, 女兒: t.daughter, 兒子: t.son, 日常: t.daily + t.utilities }, opening: null,
      transfer: all.filter((it) => isTransfer(it) && names.includes(it.from)).reduce((s, it) => s + it.amount, 0) };
    const o = transactionSummary(all.filter((it) => !names.includes(it.by) && !ACCOUNTS.includes(it.by) && !isAdjustment(it)), mappings);
    entry.shared = o.monthlyTotal + o.utilities;
    if (start && month < start) balance = null;
    else if (month === start) {
      balance = config.reduce((s, sh) => s + (sh.carry || 0), 0);
      entry.opening = { amount: balance, first: true };
    } else if (month.endsWith('-01') && balance !== null && ledger.length) {
      entry.opening = settled ? { amount: 0, residual: balance } : { amount: balance };
      if (settled) balance = 0;
    }
    if (month.endsWith('-01')) settled = false;
    settled ||= shares.some((sh) => sh.extras.some((e) => e.settlement));
    entry.income = shares.reduce((sum, sh) => sum + sh.quota + sh.extras.reduce((s, e) => s + e.amount, 0), 0);
    entry.expense = FUND_ITEMS.reduce((sum, k) => sum + entry.expenses[k], 0) + entry.transfer;
    balance = balance === null ? null : balance + entry.income - entry.expense;
    ledger.push({ ...entry, balance });
  }
  return ledger;
}

/** 拆成兩份，奇數的 1 元給第一位。 */
const halves = (n) => [n - Math.trunc(n / 2), Math.trunc(n / 2)];
/** 年末均攤的備註：「年末均攤,-6258-23378」是自己的赤盈，再加上替對方付（－）或對方替自己付（＋）的部分。 */
const settleNote = (balance, pay) => `年末均攤,${[balance, -pay - balance].map((n) => `${n < 0 ? '-' : '+'}${Math.abs(n)}`).join('')}`;

/**
 * 公積金某年的年末結算。
 * 每人赤盈＝年初結轉＋額度＋額外加入－自己記的支出（含轉進土銀的錢）；公積金名下的收支不算。
 * 合計超支時兩人均攤（互貼），各記一筆 12 月的年末均攤；有結餘時各自轉入下一年。
 * 年初結轉接前一年的結算；開始逐人結算那年取設定的期初結轉。開始以前的年份回傳 null。
 */
export function fundSettlement({ ledger, fund, year }) {
  if (!fund?.shares?.length || (fund.start && `${year}-12` < fund.start)) return null;
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  if (!months.length) return null;
  const previous = fundSettlement({ ledger, fund, year: String(Number(year) - 1) });
  const carry = previous ? previous.next : fund.start?.startsWith(`${year}-`) ? fund.shares.map((sh) => sh.carry || 0) : fund.shares.map(() => 0);
  const extra = (sh, settle) => sh.extras.reduce((s, e) => s + (!!e.settlement === settle ? e.amount : 0), 0);
  const shares = months[0].shares.map(({ name, member }, i) => {
    const sum = (pick) => months.reduce((s, m) => s + pick(m.shares[i]), 0);
    const monthly = months.map((m) => [m.month, m.shares[i].quota + extra(m.shares[i], false) - m.shares[i].spend]);
    const share = { name, member, carry: carry[i], quota: sum((sh) => sh.quota), extra: sum((sh) => extra(sh, false)),
      spend: sum((sh) => sh.spend), settled: sum((sh) => extra(sh, true)), monthly };
    return { ...share, balance: share.carry + share.quota + share.extra - share.spend };
  });
  const total = shares.reduce((s, sh) => s + sh.balance, 0);
  const pays = total < 0 ? halves(-total) : null;
  if (pays) shares.forEach((sh, i) => Object.assign(sh, { pay: pays[i], note: settleNote(sh.balance, pays[i]) }));
  const recorded = shares.some((sh) => sh.settled);
  // 記了年末均攤才歸零；還沒記（或忘了記）時和公積金帳一樣，各自的赤盈整筆轉入下一年。
  return { year, through: months.at(-1).month, shares, total, recorded,
    next: pays && recorded ? shares.map(() => 0) : shares.map((sh) => sh.balance) };
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
  const sum = (pick) => months.reduce((s, m) => s + pick(m), 0);
  return { months, quota: sum((m) => m.shares.reduce((s, sh) => s + sh.quota, 0)),
    extra: sum((m) => m.shares.reduce((s, sh) => s + sh.extras.reduce((t, e) => t + e.amount, 0), 0)),
    expense: sum((m) => m.expense), transfer: sum((m) => m.transfer), shared: sum((m) => m.shared),
    balance: months.at(-1)?.balance ?? null };
}

/** 土銀某年的合計。 */
export function bankYear(ledger, year) {
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  return { months, income: months.reduce((s, m) => s + m.income, 0), expense: months.reduce((s, m) => s + m.expense, 0),
    balance: months.at(-1)?.balance ?? null };
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
  // 大項的日常已扣公積金名下收入；分類維持原始金額，另列一行抵扣，合計才等於家庭總支出。
  if (summary.fundIncome) categoryList.push({ name: FUND_OFFSET, amount: -summary.fundIncome, offset: true });
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
  return Object.fromEntries(keys.map((key) => [key, months.reduce((sum, m) => sum + m[key], 0)]));
}

/** 分類的年度橫表：列是大項底下的項目，欄是月份。 */
export function classificationMatrix(months) {
  const rows = new Map();
  const entries = months.map((m) => m.details.map((d) => ({ ...d,
    item: d.item.startsWith(`${d.group}／`) ? d.item.slice(d.group.length + 1) : d.item,
  })));
  entries.forEach((details) => details.forEach((d) => {
    const key = JSON.stringify([d.group, d.item]);
    if (!rows.has(key)) rows.set(key, { group: d.group, item: d.item, key });
  }));
  return [...rows.values()].map((r) => ({ ...r, months: months.map((m, i) =>
    entries[i].filter((d) => JSON.stringify([d.group, d.item]) === r.key).reduce((sum, d) => sum + d.amount, 0)) }))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.item.localeCompare(b.item, 'zh-Hant'));
}

