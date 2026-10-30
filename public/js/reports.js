import * as store from './store.js';
import * as billing from './billing.js';
import { monthKey, money, isAdjustment } from './calc.js';
import { ReportCharts } from './report-charts.js';
import { esc } from './html.js';
import { expenseTile } from './views.js';
const amount = (n) => n === null || n === undefined ? '—' : money(n);
let root, context, year = monthKey().slice(0, 4), mode = 'year', detailMonth = null, shareScope = 'year', shareTop = 'amount', sharePick = '食';
let archive = null, archiveSha = null, changedData = false, shownError = '';
/** 房貸是已結清的歷史紀錄，載入一次；undefined 表示還沒讀。 */
let loan;
let records = {}, versions = new Map(), active = false, initialized = false, running = null, error = '', lastSync = null;
/** 目錄有、還沒讀過的月份；畫面要的月份讀到就先畫，其餘在背景讀。 */
let missing = new Set(), waiting = false;
let revision = 0;
let charts;
/** 年度明細展開的大項，重畫時保留。 */
const openGroups = new Set();
const monthCache = new Map();
const entryCache = new Map();

export function init(element, getters) {
  root = element;
  context = getters;
  root.innerHTML = `
    <div class="stack billing-layout">
      <div class="card report-controls">
        <div class="seg" role="group" aria-label="月結檢視"><button class="seg-btn is-on" type="button" data-report-mode="year" aria-pressed="true" title="所選年度：逐月走勢與明細">單年</button><button class="seg-btn" type="button" data-report-mode="compare" aria-pressed="false" title="各年同期：趨勢與分類細項 YOY">跨年</button><button class="seg-btn" type="button" data-report-mode="share" aria-pressed="false" title="分類占比與日常內容排行">占比</button><button class="seg-btn" type="button" data-report-mode="bank" aria-pressed="false" title="土銀帳：水電氣">${billing.UTILITY_PAYER}</button><button class="seg-btn" type="button" data-report-mode="fund" aria-pressed="false" title="公積金帳：公婆額度與額外收入，支付房、女兒、兒子與日常">公積金</button><button class="seg-btn" type="button" data-report-mode="post" aria-pressed="false" title="郵局帳：小孩保險扣款，理賠、紅包、利息與餘額">${billing.POST_PAYER}</button><button class="seg-btn" type="button" data-report-mode="loan" aria-pressed="false" title="房貸：已結清的歷史紀錄，每年繳款與利息">房貸</button></div>
        <div class="year-nav"><button type="button" class="btn-quiet" data-report-year="-1" aria-label="前一年">‹</button><label class="field"><select id="billing-year" aria-label="月結年度"></select></label><button type="button" class="btn-quiet" data-report-year="1" aria-label="後一年">›</button></div>
      </div>
      <p id="billing-status" class="report-status" role="status"></p>
      <div id="billing-content" class="stack"></div>
    </div>`;

  root.querySelector('#billing-year').addEventListener('change', (e) => { year = e.target.value; detailMonth = null; draw(); });
  charts = new ReportCharts(root, { year: () => year, years: allYears, months: monthsFor, draw });
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-report-mode]');
    if (button) { mode = button.dataset.reportMode; detailMonth = null; draw(); }
    const step = e.target.closest('[data-report-year]');
    if (step) {
      // 年度選單由新到舊排列：前一年是下一個選項。
      const years = allYears(), i = years.indexOf(year) - Number(step.dataset.reportYear);
      if (years[i]) { year = years[i]; detailMonth = null; draw(); }
      return;
    }
    const scope = e.target.closest('[data-share-scope]');
    if (scope) { shareScope = scope.dataset.shareScope; draw(); }
    const settle = e.target.closest('[data-settle]');
    if (settle) { recordSettlement(settle); return; }
    const link = e.target.closest('[data-search]');
    if (link) { context.search?.(link.dataset.search, link.dataset.searchCat); return; }
    const topBy = e.target.closest('[data-share-top]');
    if (topBy) { shareTop = topBy.dataset.shareTop; draw(); }
    const pick = e.target.closest('[data-share-pick]');
    if (pick) { sharePick = pick.dataset.sharePick; draw(); }
    const toggle = e.target.closest('[data-year-group]');
    if (toggle) { const name = toggle.dataset.yearGroup; if (!openGroups.delete(name)) openGroups.add(name); draw(); return; }
    const monthButton = e.target.closest('[data-billing-month]');
    // 即時記帳的月份到本月分頁看，和那裡的分類佔比、明細同一份；歷史與待補月份才在這裡列。
    const opened = monthButton && monthsFor(year).find((m) => m.month === monthButton.dataset.billingMonth);
    if (opened?.source === 'transactions' && opened.month <= monthKey()) { context.openMonth?.(opened.month); return; }
    if (monthButton) { detailMonth = monthButton.dataset.billingMonth; draw(); root.querySelector('#billing-detail')?.scrollIntoView({ block: 'nearest' }); }
  });
  root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-search]')) { e.preventDefault(); e.target.click(); } });
  // 年度頁可見時追蹤整個月份目錄，支援他人修改其他月份與歷史檔。
  setInterval(() => { if (active && document.visibilityState !== 'hidden') refresh(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (active && document.visibilityState === 'visible') refresh(); });
}

export function setActive(value) {
  active = value;
  if (value) { draw(); refresh(); }
}

export function updateMonth(month, items) {
  revision++;
  records[month] = structuredClone(items);
  missing.delete(month);
  // 下次目錄同步仍須確認寫入後的版本。
  versions.delete(month);
  if (active) draw();
}

export async function refresh() {
  if (running) return running;
  context.sync?.('busy', '同步中');
  running = (async () => {
    try {
      const readingRevision = revision;
      const [files, found, loaded] = await Promise.all([store.listMonths(), store.loadHistory(), loan === undefined ? store.loadLoan() : loan]);
      if (revision !== readingRevision) throw new Error('同步期間有新變更，請稍後重試');
      loan = loaded;
      const present = new Set(files.map((f) => f.month));
      // 月檔、歷史月結或月份目錄都沒變，就不用重畫（重畫會收起展開的明細）。
      if (!initialized || found.sha !== archiveSha || files.length !== versions.size) changedData = true;
      archiveSha = found.sha;
      archive = found.archive;
      for (const key of Object.keys(records)) if (!present.has(key)) delete records[key];
      for (const key of versions.keys()) if (!present.has(key)) versions.delete(key);
      const queue = files.filter((f) => versions.get(f.month) !== f.sha);
      missing = new Set(queue.map((f) => f.month).filter((m) => !(m in records)));
      initialized = true;
      if (active && waiting && ready()) draw();
      while (queue.length) {
        // 一次讀 4 個，畫面要的年份排前面；切換年份後下一批就跟著換。
        const years = neededYears();
        if (years) queue.sort((a, b) => years.has(b.month.slice(0, 4)) - years.has(a.month.slice(0, 4)));
        const batch = queue.splice(0, 4), batchRevision = revision;
        const data = await Promise.all(batch.map((f) => store.loadMonth(f.month)));
        if (revision !== batchRevision) throw new Error('同步期間有新變更，請稍後重試');
        for (const d of data) { records[d.month] = d.items; versions.set(d.month, d.sha); missing.delete(d.month); }
        changedData = true;
        if (active && waiting && ready()) draw();
      }
      error = ''; lastSync = new Date();
      return true;
    } catch (err) { error = err.message || '年度資料同步失敗'; return false; }
    finally {
      running = null; context.sync?.(error ? 'error' : 'ok', error ? '同步失敗' : '已同步');
      if (changedData || error !== shownError) draw(); else syncTitle();
    }
  })();
  return running;
}

/** 單年與占比的單一年度只需要所選年度與前一年（同期比較）；其他檢視要全部月份，回傳 null。 */
function neededYears() {
  return mode === 'year' || (mode === 'share' && shareScope === 'year') ? new Set([year, String(Number(year) - 1)]) : null;
}

function ready() {
  if (!initialized) return false;
  const years = neededYears();
  return years ? ![...missing].some((m) => years.has(m.slice(0, 4))) : !missing.size;
}

function allYears() {
  const today = Number(monthKey().slice(0, 4));
  return [...new Set([String(today), String(today - 1), String(today + 1), year, ...(archive?.years || []), ...Object.keys(records).map((m) => m.slice(0, 4)), ...[...missing].map((m) => m.slice(0, 4))])].sort((a, b) => Number(b) - Number(a));
}

function monthsFor(target) {
  if (!monthCache.has(target)) monthCache.set(target,
    billing.annualReport(target, records, archive?.data, billing.reportCutoff(archive), context.settings()?.billingGroups, billing.historyEnd(archive)));
  return monthCache.get(target);
}

function elapsed(target) {
  const now = monthKey();
  return target < now.slice(0, 4) ? 12 : target > now.slice(0, 4) ? 0 : Number(now.slice(-2));
}

/** 年度選單的提示：最後同步時間與歷史月結範圍；同步沒有新資料時只更新這裡。 */
function syncTitle() {
  root.querySelector('#billing-year').title = [lastSync && `同步於 ${lastSync.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`,
    archive && (archive.migratedThrough ? `歷史月結已轉入記帳（${archive.years[0]}-01～${archive.migratedThrough}）` : `歷史月結至 ${billing.historyEnd(archive)} · 正式記帳 ${archive.cutoverMonth} 起`)].filter(Boolean).join(' · ');
}

function draw() {
  if (!root) return;
  // 一次呈現共用年度計算結果；下一次呈現再讀取最新設定與交易。
  monthCache.clear();
  entryCache.clear();
  changedData = false;
  waiting = !ready();
  const select = root.querySelector('#billing-year');
  const years = allYears();
  if (JSON.stringify([...select.options].map((o) => o.value)) !== JSON.stringify(years)) {
    select.replaceChildren(...years.map((y) => new Option(`${y} 年`, y, false, y === year)));
  } else select.value = year;
  const yearIndex = years.indexOf(year);
  // 房貸跨好幾年，不用選年度。
  root.querySelector('.year-nav').hidden = mode === 'loan';
  root.querySelector('[data-report-year="-1"]').disabled = yearIndex >= years.length - 1;
  root.querySelector('[data-report-year="1"]').disabled = yearIndex <= 0;
  for (const button of root.querySelectorAll('[data-report-mode]')) {
    button.classList.toggle('is-on', mode === button.dataset.reportMode);
    button.setAttribute('aria-pressed', String(mode === button.dataset.reportMode));
  }
  const status = root.querySelector('#billing-status');
  status.classList.toggle('is-expense', !!error);
  status.textContent = error ? `${error}，按右上角同步重試` : waiting ? '讀取中…' : '';
  status.hidden = !status.textContent;
  syncTitle();
  shownError = error;
  const content = root.querySelector('#billing-content');
  if (waiting) { content.innerHTML = '<div class="card"><p class="empty">尚未載入</p></div>'; return; }
  const expanded = new Set([...content.querySelectorAll('details[open]')].map((el) => el.id));
  const focused = document.activeElement;
  const focusId = content.contains(focused) ? focused.id : '';
  const caret = focused?.id === 'growth-item-search' ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrollSelector = '.report-table-wrap, .chart-scroll, .item-choices';
  const scrollKey = (el) => el.getAttribute('aria-label') || el.className;
  const scrolls = new Map([...content.querySelectorAll(scrollSelector)].map((el) => [scrollKey(el), [el.scrollLeft, el.scrollTop]]));
  charts.beginRender();
  content.innerHTML = mode === 'year' ? yearView() : mode === 'compare' ? compareView() : mode === 'bank' ? bankView() : mode === 'fund' ? fundView() : mode === 'post' ? postView() : mode === 'loan' ? loanView() : shareView();
  for (const id of expanded) { const el = root.querySelector(`#${id}`); if (el) el.open = true; }
  for (const el of content.querySelectorAll(scrollSelector)) {
    const [left, top] = scrolls.get(scrollKey(el)) || [0, 0];
    el.scrollLeft = left; el.scrollTop = top;
  }
  charts.afterRender();
  if (focusId) { const el = document.getElementById(focusId); el?.focus({ preventScroll: true }); if (caret && el) el.setSelectionRange(...caret); }
}

function summaryTiles(totals, label, previous) {
  const pct = billing.percentChange(totals.total, previous?.total);
  // 和本月的支出格同一個減法，年度只是把月份加總。
  return `<div class="tiles billing-tiles billing-summary">${expenseTile('家庭總支出', amount(totals.total), { text: `${label}${previous && pct !== null ? `\n較去年同期${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}` }, totals, amount)}</div>`;
}

const signed = (n) => `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`;
/** 轉入記帳後的結餘調整：第一個月是期初結餘，之後是原表結餘與推算的差。 */
const adjustBadge = (m) => m.adjust ? `<small${m.diff ? ' class="is-expense"' : ''} title="${esc(m.adjust.note || '結餘調整')}">${m.diff ? '差' : '期初'} ${signed(m.adjust.amount)}</small>` : '';

function utilityBudgetView({ expense: spent, missing }) {
  const limit = billing.utilityBudget(context.settings(), year);
  if (!limit) return '';
  const left = limit - spent, used = Math.round((spent / limit) * 100), over = left < 0;
  return `<div class="card utility-budget" title="在設定頁調整">
    <div class="budget-head"><span class="budget-title">扣款／年度預算</span><span class="budget-num">${money(spent)} / ${money(limit)}</span></div>
    <div class="bar" role="progressbar" aria-label="${billing.UTILITY_PAYER}年度預算使用進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, used)}" aria-valuetext="已用 ${used}%"><div class="bar-fill ${over ? 'is-over' : used >= 80 ? 'is-warn' : ''}" style="width:${Math.min(100, used)}%"></div></div>
    <p class="budget-note ${over ? 'is-over' : ''}">${over ? `已超出 ${money(-left)} 元` : `還可用 ${money(left)} 元`} · 已用 ${used}%${missing ? ` · 缺 ${missing} 個月` : ''}</p>
  </div>`;
}

const ledgerSource = () => ({ history: archive?.data, cutoff: billing.reportCutoff(archive), historyThrough: billing.historyEnd(archive),
  records, mappings: context.settings()?.billingGroups, through: monthKey() });
/* ---------- 加總格的提示：月份格逐筆列日期、內容、金額；跨月的合計格列各月金額 ---------- */
const TIP_MAX = 40;
const fmt = (n) => `${n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const tipAttr = (tip) => tip ? ` title="${esc(tip)}"` : '';
const day = (date) => String(date || '').slice(5).replace('-', '/');

/** 某月算進月結的交易（同 transactionSummary）：標上大項、項目與帶號金額，公積金名下的收入抵扣日常。 */
function monthEntries(month) {
  if (!entryCache.has(month)) {
    const mappings = context.settings()?.billingGroups;
    entryCache.set(month, (records[month] || []).flatMap((it) => {
      const income = it.type === 'income';
      if (isAdjustment(it) || (income ? it.by !== billing.FUND_PAYER : it.type !== 'expense')) return [];
      const group = income ? '日常' : billing.expenseGroup(it, mappings);
      const item = it.category.startsWith(`${group}／`) ? it.category.slice(group.length + 1) : it.category;
      return [{ date: it.date, by: it.by, note: it.note, group, item, amount: income ? -it.amount : it.amount }];
    }));
  }
  return entryCache.get(month);
}

/** 逐筆依日期列出；列本身已是單一項目時 withItem 為 false，不重複寫項目。 */
function entriesTip(list, withItem = true) {
  const sorted = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const lines = sorted.slice(0, TIP_MAX).map((e) => [day(e.date), withItem && e.item, e.note, fmt(e.amount)].filter(Boolean).join(' '));
  if (sorted.length > TIP_MAX) lines.push(`…另 ${sorted.length - TIP_MAX} 筆`);
  return lines.join('\n');
}

/** 跨月合計格：[月份, 金額] 逐月列出，0 與缺資料略過。 */
const monthsTip = (pairs) => pairs.filter(([, v]) => v).map(([month, v]) => `${Number(month.slice(5))}月 ${fmt(v)}`).join('\n');

const sourceTitle = (m) => m.source === 'history' ? '歷史月結' : m.source === 'missing' ? '缺少歷史' : '即時記帳';

/** 占比：所選年度或全部年度的大項、分類占比，以及日常內容 Top 10（例如全聯）。 */
function shareView() {
  const now = monthKey();
  const months = Object.keys(records).filter((m) => m <= now && (shareScope === 'all' || m.startsWith(`${year}-`))).sort();
  const items = months.flatMap((m) => records[m] || []);
  let s = billing.shareSummary(items, context.settings()?.billingGroups, 10, shareTop, sharePick);
  // 切到沒有支出的期間時回到日常。
  if (!s.picks.includes(sharePick) && s.picks.length) { sharePick = s.picks[0]; s = billing.shareSummary(items, context.settings()?.billingGroups, 10, shareTop, sharePick); }
  const scopeButtons = [['year', year], ['all', '全部']].map(([key, label]) =>
    `<button type="button" class="seg-btn ${shareScope === key ? 'is-on' : ''}" data-share-scope="${key}" aria-pressed="${shareScope === key}">${label}</button>`).join('');
  const range = months.length ? `${months[0]}～${months.at(-1)} · ${months.length} 個月` : '沒有資料';
  const bar = (name, value, total, extra = '', color = '', scale = total, search = null) => `<div class="cat${search ? ' cat-link' : ''}"${search ? ` data-search="${esc(search[0])}" data-search-cat="${esc(search[1] || '')}" role="button" tabindex="0" title="到明細看全部紀錄"` : ''}><span class="cat-name">${esc(name)}${extra}</span><span class="cat-pct">${total ? (value / total * 100).toFixed(1) : 0}%</span><span class="cat-amount">${money(value)}</span><span class="cat-bar"><span style="width:${scale ? Math.max(0, value / scale * 100) : 0}%${color ? `;background:${color}` : ''}"></span></span></div>`;
  const catTotal = s.categories.reduce((sum, c) => sum + c.amount, 0);
  const topTotal = s.topTotal;
  const top = s.top.map((t, i) => bar(`${i + 1}. ${t.name}`, t.amount, topTotal, `<small class="share-count">${t.count} 筆 · 平均 ${money(Math.round(t.amount / t.count))}${t.parts.length > 1 ? ` · ${t.parts.slice(0, 3).map((p) => `${esc(p.name || '未寫品項')} ${p.count}`).join('、')}` : ''}</small>`, '', s.top[0].amount, [t.name, billing.GROUPS.includes(sharePick) ? '' : sharePick])).join('');
  return `<div class="card"><div class="section-head"><h3 class="section-title">大項占比</h3><span class="seg share-scope" role="group" aria-label="占比範圍">${scopeButtons}</span></div><p class="setting-hint">${range} · 家庭總支出 ${amount(s.total)}</p>${s.groups.length ? s.groups.map((g) => bar(g.name, g.amount, s.total, '', g.color)).join('') : '<p class="empty">沒有支出</p>'}</div>
    <div class="card"><div class="section-head"><h3 class="section-title" title="占所選類別支出的比例；依備註空格前的店名合計，例如 7-11、7-11 早餐都算 7-11">${esc(sharePick)} Top 10</h3><span class="seg share-top" role="group" aria-label="排行依據">${[['amount', '金額'], ['count', '次數']].map(([key, label]) => `<button type="button" class="seg-btn ${shareTop === key ? 'is-on' : ''}" data-share-top="${key}" aria-pressed="${shareTop === key}">${label}</button>`).join('')}</span></div><div class="share-picks" role="group" aria-label="排行的類別">${s.picks.map((p) => `<button type="button" class="chip${p === sharePick ? ' is-on' : ''}" data-share-pick="${esc(p)}" aria-pressed="${p === sharePick}">${esc(p)}</button>`).join('')}</div>${top || `<p class="empty">${esc(sharePick)}沒有寫內容的紀錄</p>`}</div>
    <div class="card"><h3 class="section-title">分類占比</h3>${s.categories.map((c) => bar(c.name, c.amount, catTotal, '', '', catTotal, ['', c.name])).join('') || '<p class="empty">沒有支出</p>'}</div>`;
}

/** 存摺／網銀明細最後核對到哪天（設定 reconciled），之後的交易還沒對帳，下次從隔天補。 */
const reconciledHint = (payer) => {
  const date = context.settings()?.reconciled?.[payer];
  return date ? `<span class="setting-hint" title="存摺／網銀明細核對到這天，之後的交易還沒對帳">已對帳至 ${esc(String(date).replaceAll('-', '/'))}</span>` : '';
};

/** 這一年的年末均攤還沒記、而且已到 12 月，原表也沒有接著的下一年時，可以記下兩筆。 */
const settleOpen = (s) => s && !s.recorded && s.total < 0 && monthKey() >= `${s.year}-12` && !archive?.data?.[String(Number(s.year) + 1)];

/**
 * 公積金年末結算（一張表）：每月分幾行，固定（每月額度）－支出（自己付的）＝赤盈（原表的每月赤盈），
 * 額外另列：上一年的結轉算在 1 月，比平常多的額度（如 2026/03 多 80,000）也拆成額外。
 * 年底赤盈＝赤盈加總＋額外加總（同原表年底的算法）。合計超支兩人均攤（原表 12 月的「年末均攤」），
 * 有結餘各自轉入下一年。年末均攤本身不算額外，列在均攤那列。
 */
function settlementTable(s, months) {
  const anchor = archive?.data?.[String(Number(year) + 1)] && billing.fundSettlement({ ledger: billing.fundLedger({ ...ledgerSource(), members: fundMembers(), quotaFor: fundQuota }), history: archive.data, year: String(Number(year) + 1) });
  const signedCell = (n) => `<span class="${n < 0 ? 'is-expense' : n > 0 ? 'is-income' : ''}">${n ? signed(n) : '0'}</span>`;
  const isSettle = (e) => billing.SETTLE_NOTE.test(e.note || '');
  // 平常的額度＝這一年最常見的額度；多出來的當成額外。
  const usual = s.shares.map((_, i) => {
    const count = new Map();
    for (const m of months) count.set(m.shares[i].quota, (count.get(m.shares[i].quota) || 0) + 1);
    return [...count].sort((x, y) => y[1] - x[1])[0]?.[0] || 0;
  });
  const sums = s.shares.map(() => ({ quota: 0, spend: 0, extra: 0 }));
  const line = (head, label, cells, cls = '', tip = '') => `<tr${cls ? ` class="${cls}"` : ''}>${head}<th scope="row"${tip ? ` title="${tip}"` : ''}>${label}</th>${cells.join('')}</tr>`;
  const rows = months.map((m, k) => {
    const parts = m.shares.map((sh, i) => {
      const quota = Math.min(sh.quota, usual[i]);
      const extras = [
        ...(k === 0 && s.shares[i].carry ? [{ note: `${Number(year) - 1} 年結轉`, amount: s.shares[i].carry }] : []),
        ...(sh.quota > quota ? [{ note: `額度另加（這個月額度 ${money(sh.quota)}）`, amount: sh.quota - quota }] : []),
        ...sh.extras.filter((e) => !isSettle(e)),
      ];
      const extra = extras.reduce((t, e) => t + e.amount, 0);
      sums[i].quota += quota; sums[i].spend += sh.spend; sums[i].extra += extra;
      return { quota, spend: sh.spend, extra, extras };
    });
    const hasExtra = parts.some((x) => x.extra);
    const head = `<th scope="rowgroup" rowspan="${hasExtra ? 4 : 3}">${Number(m.month.slice(5))} 月</th>`;
    return [
      line(head, '固定', parts.map((x) => `<td>${money(x.quota)}</td>`), 'settle-sub'),
      line('', '支出', parts.map((x) => `<td>${money(x.spend)}</td>`), 'settle-sub'),
      line('', '赤盈', parts.map((x) => `<td>${signedCell(x.quota - x.spend)}</td>`), hasExtra ? 'settle-sub' : '', '固定－支出'),
      hasExtra ? line('', '額外', parts.map((x) => `<td${x.extra ? tipAttr(x.extras.map((e) => [e.date && day(e.date), e.note, signed(e.amount)].filter(Boolean).join(' ')).join('\n')) : ''}>${x.extra ? signedCell(x.extra) : ''}</td>`)) : '',
    ].join('');
  }).join('');
  // 下一年原表 1 月的結餘是上一年轉入的金額，不同時標出。
  const yearEnd = (sh, i) => `${signedCell(sh.balance)}${anchor && anchor.shares[i].carry !== s.next[i] ? `<small class="is-expense" title="原表轉入 ${Number(year) + 1} 年 ${money(anchor.shares[i].carry)}">原表 ${signed(anchor.shares[i].carry)}</small>` : ''}`;
  const settleCell = (sh) => {
    if (!s.recorded) return `<span title="${esc(sh.note)}">${money(sh.pay)}</span>`;
    const diff = sh.settled - sh.pay;
    return `<span title="${esc(`已記 ${money(sh.settled)}\n${sh.note}`)}">${money(sh.settled)}</span>${diff ? `<small class="is-expense" title="照目前的帳應為 ${money(sh.pay)}">差 ${signed(diff)}</small>` : ''}`;
  };
  const both = (pick) => s.shares.map((sh, i) => `<td>${pick(sh, i)}</td>`);
  const [a, b] = s.shares, gap = s.total < 0 ? a.pay + a.balance : 0;
  const settled = s.shares.reduce((t, sh) => t + sh.settled, 0);
  const partial = s.through < `${year}-12`;
  const totalLine = [`合計 ${signed(s.total)}`, s.total < 0 && gap ? `${gap > 0 ? `${a.name}貼${b.name}` : `${b.name}貼${a.name}`} ${money(Math.abs(gap))}` : '',
    s.total < 0 && s.recorded ? `均攤後還剩 ${signed(s.total + settled)}，不轉入下一年` : '', s.total >= 0 ? `轉入 ${Number(year) + 1}` : ''].filter(Boolean).join(' · ');
  const yearHead = `<th scope="rowgroup" rowspan="6">全年</th>`;
  return `<div class="card fund-settle"><div class="section-head"><h3 class="section-title" title="每月固定（額度）－自己付的支出（含轉進土銀、郵局的錢）＝赤盈，額外另列（上一年的結轉算在 1 月）；公積金名下的收支同原表不算；年底赤盈＝赤盈加總＋額外加總；合計超支兩人各付一半（記成 12 月的年末均攤），有結餘各自轉入下一年">${year} 公積金</h3>${partial ? `<span class="setting-hint">到 ${Number(s.through.slice(5))} 月</span>` : ''}</div>
    <div class="report-table-wrap" tabindex="0" aria-label="可捲動公積金"><table class="report-table settle-table"><thead>
      <tr><th scope="col">月份</th><th scope="col" aria-label="項目"></th>${s.shares.map((sh) => `<th scope="col"${tipAttr(sh.member)}>${sh.name}</th>`).join('')}</tr>
    </thead><tbody>
      ${rows}
      ${line(yearHead, '固定', sums.map((x) => `<td>${money(x.quota)}</td>`), 'report-total settle-sub')}
      ${line('', '支出', sums.map((x) => `<td>${money(x.spend)}</td>`), 'report-total settle-sub')}
      ${line('', '赤盈', sums.map((x) => `<td>${signedCell(x.quota - x.spend)}</td>`), 'report-total settle-sub', '固定－支出')}
      ${line('', '額外', sums.map((x) => `<td>${x.extra ? signedCell(x.extra) : ''}</td>`), 'report-total settle-sub')}
      ${line('', '年底', both(yearEnd), 'report-total settle-sub', '赤盈＋額外')}
      ${s.total < 0 ? line('', '均攤', both(settleCell), '', '合計超支兩人各付一半') : line('', `轉入 ${Number(year) + 1}`, both((sh, i) => signedCell(s.next[i])))}
    </tbody></table></div>
    <p class="setting-hint settle-balance">${totalLine}</p>
    ${settleOpen(s) ? `<button type="button" class="btn-quiet" data-settle title="${esc(s.shares.map((sh) => `${sh.member}：${sh.note}`).join('\n'))}">記下年末均攤</button>` : ''}
  </div>`;
}

async function recordSettlement(button) {
  const s = billing.fundSettlement({ ledger: billing.fundLedger({ ...ledgerSource(), members: fundMembers(), quotaFor: fundQuota }), history: archive?.data, year });
  if (!settleOpen(s) || !confirm(`在 ${year}/12/31 記下年末均攤：${s.shares.map((sh) => `${sh.member} ${money(sh.pay)}`).join('、')}？`)) return;
  button.disabled = true;
  const entries = s.shares.map((sh) => ({ type: 'income', date: `${year}-12-31`, amount: sh.pay, category: '其他', by: sh.member, note: sh.note }));
  try {
    // 另一支手機已經記過就不重複寫。
    const done = await context.addMany(entries, (list) => list.some((it) => it.type === 'income' && billing.SETTLE_NOTE.test(it.note || '')));
    context.toast?.(done === false ? '這一年已經記過年末均攤' : '已記下年末均攤');
  } catch (err) {
    context.toast?.(err.message || '寫入失敗');
  }
  await refresh();
}

const fundMembers = () => (context.settings()?.people || []).filter((p) => !billing.ACCOUNTS.includes(p));
const fundQuota = (person, month) => billing.monthlyBudget(context.settings(), person, month);

/** 公積金帳：公婆額度與額外收入，支付房、女兒、兒子與日常；餘額跨年連續，原表結餘當對帳點。 */
function fundView() {
  const members = fundMembers();
  const ledger = billing.fundLedger({ ...ledgerSource(), members, quotaFor: fundQuota });
  const summary = billing.fundYear(ledger, year);
  if (!summary.months.length) return '<div class="card"><p class="empty">這一年沒有公積金紀錄</p></div>';
  const settlement = billing.fundSettlement({ ledger, history: archive?.data, year });
  const diffs = ledger.filter((m) => m.diff);
  const gaps = summary.months.filter((m) => m.settlement?.gap);
  const shareCell = (m, sh) => {
    if (m.source === 'missing') return '<td>—</td>';
    const extra = sh.extras.reduce((s, e) => s + e.amount, 0);
    const tip = [sh.member && sh.member !== sh.name ? sh.member : '', `額度 ${money(sh.quota)}`, sh.carry && `${sh.carry.note} ${money(sh.carry.amount)}`,
      ...sh.extras.map((e) => [day(e.date), e.note || '額外', money(e.amount)].filter(Boolean).join(' '))].filter(Boolean).join('\n');
    return `<td title="${esc(tip)}">${sh.quota ? money(sh.quota) : ''}${extra ? `<small>+${money(extra)}</small>` : ''}${sh.carry ? `<small>結餘 ${money(sh.carry.amount)}</small>` : ''}</td>`;
  };
  // 支出格逐筆：公婆付的支出，自己付的水電氣併入日常（同 fundLedger）。
  const fundTip = (m, k) => m.source !== 'transactions' ? '' : entriesTip(monthEntries(m.month).filter((e) => members.includes(e.by) && (k === '日常' ? ['日常', '水電氣'].includes(e.group) : e.group === k)));
  // 1 月的期初：原表開始逐人結算那年、上一年結餘轉入，或記過年末均攤後歸零。
  const openingBadge = (o) => !o ? '' : o.first ? `<small title="原表這一年開始逐人結算，以 1 月的結餘／上月超支為期初">期初 ${signed(o.amount)}</small>`
    : 'residual' in o ? (o.residual ? `<small class="is-expense" title="上一年記過年末均攤，依規則歸零；均攤後還剩 ${signed(o.residual)}，即年末結算的「差」">均攤差 ${signed(o.residual)}</small>` : '<small title="上一年記過年末均攤，依規則歸零">歸零</small>')
    : o.amount ? `<small title="上一年的結餘轉入">轉入 ${signed(o.amount)}</small>` : '';
  const items = summary.transfer ? [...billing.FUND_ITEMS, '轉帳'] : billing.FUND_ITEMS;
  const value = (m, k) => k === '轉帳' ? m.transfer : m.expenses?.[k];
  const shareTotal = (m, i) => m.shares[i].quota + m.shares[i].extras.reduce((t, e) => t + e.amount, 0);
  return `<div class="tiles billing-tiles">${[['額度', summary.quota], ['額外', summary.extra], ['支出', summary.expense], [year === monthKey().slice(0, 4) ? '目前餘額' : '年底餘額', summary.balance]].map(([name, value]) =>
      `<div class="tile"><div class="tile-label">${name}</div><div class="tile-value">${amount(value)}</div></div>`).join('')}</div>
    ${diffs.length ? `<p class="report-notice fund-diffs" title="原表年初結餘或上月超支與前期推算的餘額不同，之後餘額以原表為準">結餘不符：${diffs.map((m) => `${m.month} ${signed(m.diff)}`).join('、')}</p>` : ''}
    ${gaps.length ? `<p class="report-notice fund-gaps" title="公赤盈＋婆赤盈應等於額度合計－月消費總額">赤盈不符：${gaps.map((m) => `${Number(m.month.slice(5))} 月 ${signed(m.settlement.gap)}`).join('、')}</p>` : ''}
    ${settlement ? settlementTable(settlement, summary.months) : `<div class="card"><h3 class="section-title" title="原表 2022 年起才逐人結算">${year} 公積金帳</h3>
      <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動公積金帳"><table class="report-table fund-table"><thead><tr><th scope="col">月份</th>${billing.FUND_SHARES.map((name, i) => `<th scope="col" title="${esc(members[i] || name)}：額度，小字為額外加入或結餘">${name}</th>`).join('')}${items.map((k) => `<th scope="col"${k === '轉帳' ? ' title="轉進土銀、郵局的錢"' : ''}>${k}</th>`).join('')}<th scope="col">餘額</th></tr></thead><tbody>
        ${summary.months.map((m) => `<tr><th scope="row" title="${sourceTitle(m)}">${Number(m.month.slice(5))} 月</th>${m.shares.map((sh) => shareCell(m, sh)).join('')}${items.map((k) => `<td${value(m, k) && k !== '轉帳' ? tipAttr(fundTip(m, k)) : ''}>${m.expenses ? (value(m, k) ? money(value(m, k)) : '') : '—'}</td>`).join('')}<td>${amount(m.balance)}${m.opening ? openingBadge(m.opening) : m.diff ? `<small class="is-expense" title="原表結餘 ${money(m.balance - m.income + m.expense)}，前期推算 ${money(m.balance - m.income + m.expense - m.diff)}">差 ${signed(m.diff)}</small>` : ''}${m.settlement?.gap ? `<small class="is-expense" title="公赤盈＋婆赤盈 ${money(m.settlement.amounts[0] + m.settlement.amounts[1])}，額度－月消費總額 ${money(m.settlement.expected)}">赤盈 ${signed(m.settlement.gap)}</small>` : ''}</td></tr>`).join('')}
        <tr class="report-total"><th scope="row">合計</th>${billing.FUND_SHARES.map((_, i) => `<td${tipAttr(monthsTip(summary.months.map((m) => [m.month, shareTotal(m, i)])))}>${money(summary.months.reduce((s, m) => s + shareTotal(m, i), 0))}</td>`).join('')}${items.map((k) => `<td${tipAttr(monthsTip(summary.months.map((m) => [m.month, value(m, k)])))}>${money(summary.months.reduce((s, m) => s + (value(m, k) || 0), 0))}</td>`).join('')}<td>${amount(summary.balance)}</td></tr>
      </tbody></table></div></div>`}
    ${summary.shared ? `<p class="setting-hint" title="公積金名下（Shareroo 共同皮包）的收支，同原表不算進公婆的公積金">共同皮包另付 ${money(summary.shared)}</p>` : ''}`;
}

/** 房貸：已結清的歷史紀錄。存摺上的每筆扣款，利息由月繳變動反推（billing.loanSchedule）。 */
function loanView() {
  if (!loan) return `<div class="card"><p class="empty">${loan === null ? '沒有房貸紀錄' : '讀取中…'}</p></div>`;
  const s = billing.loanSchedule(loan);
  const ym = (d) => d.slice(0, 7).replace('-', '/');
  const rates = (y) => { const list = s.rows.filter((r) => r.date.startsWith(y.year)).map((r) => r.rate); return [Math.min(...list), Math.max(...list)].map((n) => n.toFixed(2)); };
  const prepaidTip = (y) => s.rows.filter((r) => r.kind === '提前還本' && r.date.startsWith(y.year)).map((r) => `${day(r.date)} ${money(r.amount)}`).join('\n');
  const fire = loan.fire || [];
  const sum = (k) => s.years.reduce((t, y) => t + y[k], 0);
  return `<div class="tiles billing-tiles">${[['本金', money(loan.principal)], ['利息', `${money(s.interest)}<small> ${(s.interest / s.paid * 100).toFixed(1)}%</small>`], ['總繳', money(s.paid)], ['期間', `${esc(loan.start.slice(0, 4))}～${esc(loan.payments.at(-1)[0].slice(0, 4))}`, `${loan.start.replace('-', '/')} 撥款、${ym(loan.payments.at(-1)[0])} 結清`]].map(([name, value, title]) =>
      `<div class="tile"${tipAttr(title)}><div class="tile-label">${name}</div><div class="tile-value">${value}</div></div>`).join('')}</div>
    <div class="card"><h3 class="section-title" title="${esc(`${money(loan.principal)}、${loan.months / 12} 年，利率＝土銀指標利率＋${loan.margin}%，由存摺月繳變動反推；有銀行往來明細的月份照明細，其他依前後未還本金校正；合計＝總繳－本金`)}">${esc(loan.name)}</h3>
      <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動房貸"><table class="report-table loan-table"><thead><tr><th scope="col">年</th><th scope="col">月繳</th><th scope="col" title="提前還本">還本</th><th scope="col">利息</th><th scope="col" title="年底餘額">餘額</th></tr></thead><tbody>
        ${s.years.map((y) => `<tr><th scope="row" title="年利率 ${rates(y).join('～')}%">${esc(y.year)}</th><td>${money(y.regular)}</td><td${tipAttr(prepaidTip(y))}>${y.prepaid ? money(y.prepaid) : ''}</td><td>${money(Math.round(y.interest))}</td><td>${money(Math.round(y.balance))}</td></tr>`).join('')}
        <tr class="report-total"><th scope="row">合計</th><td>${money(sum('regular'))}</td><td>${money(sum('prepaid'))}</td><td>${money(s.interest)}</td><td>${money(s.balance)}</td></tr>
      </tbody></table></div>
      ${fire.length ? `<p class="setting-hint"${tipAttr(fire.map(([d, n]) => `${d.replaceAll('-', '/')} ${money(n)}`).join('\n'))}>火地震險另付 ${money(fire.reduce((t, [, n]) => t + n, 0))}（${fire.length} 次）</p>` : ''}
      <details class="loan-detail" id="loan-detail"><summary title="底色是提前還本">逐筆 ${s.rows.length} 筆</summary>
        <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動逐筆房貸"><table class="report-table"><thead><tr><th scope="col">日期</th><th scope="col">扣款</th><th scope="col">利息</th><th scope="col">餘額</th></tr></thead><tbody>
          ${s.rows.map((r) => `<tr${r.kind === '提前還本' ? ' class="loan-prepay"' : ''}><th scope="row" title="${esc(`${r.kind}，年利率 ${r.rate.toFixed(2)}%`)}">${esc(r.date.slice(2).replaceAll('-', '/'))}</th><td>${money(r.amount)}${r.kind === '提前還本' ? '<small>還本</small>' : ''}</td><td${r.interest ? ` title="${r.exact ? '銀行往來明細' : '依前後未還本金分配的估算'}"` : ''}>${r.interest ? `${money(Math.round(r.interest))}${r.exact ? '' : '<small>估</small>'}` : ''}</td><td>${money(Math.round(r.balance))}</td></tr>`).join('')}
        </tbody></table></div></details>
    </div>`;
}

/** 郵局帳：小孩保險由郵局扣款，公婆補不足的部分記在本人名下；這裡列理賠、紅包、利息等收入與餘額付的保費。 */
function postView() {
  const ledger = billing.postLedger({ records, through: monthKey() });
  const months = ledger.filter((m) => m.month.startsWith(`${year}-`));
  if (!months.length) return '<div class="card"><p class="empty">這一年沒有郵局紀錄</p></div>';
  const sum = (pick) => months.reduce((s, m) => s + pick(m), 0);
  const lines = (list) => list.map((i) => [day(i.date), i.note, money(i.amount)].filter(Boolean).join(' ')).join('\n');
  const cell = (list, value) => value ? `<span${tipAttr(lines(list))}>${money(value)}</span>` : '';
  return `<div class="tiles billing-tiles">${[['收入', sum((m) => m.income)], ['餘額付保費', sum((m) => m.expense)], [year === monthKey().slice(0, 4) ? '目前餘額' : '年底餘額', months.at(-1).balance]].map(([name, value]) =>
      `<div class="tile"><div class="tile-label">${name}</div><div class="tile-value">${amount(value)}</div></div>`).join('')}</div>
    <div class="card"><div class="section-head"><h3 class="section-title" title="保費從郵局自動扣款，不足的部分公婆轉進去補，記在本人名下的保險支出">${year} 郵局帳</h3>${reconciledHint(billing.POST_PAYER)}</div>
      <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動郵局帳"><table class="report-table post-table"><thead><tr><th scope="col">月份</th><th scope="col" title="理賠、紅包、利息">收入</th><th scope="col" title="餘額付的保費">保費</th><th scope="col">餘額</th></tr></thead><tbody>
        ${months.map((m) => `<tr><th scope="row">${Number(m.month.slice(5))} 月</th><td>${cell(m.incomes, m.income)}</td><td>${cell(m.premiums, m.expense)}</td><td>${amount(m.balance)}${m.adjust ? adjustBadge({ ...m, diff: 0 }) : ''}</td></tr>`).join('')}
        <tr class="report-total"><th scope="row">合計</th><td>${money(sum((m) => m.income))}</td><td>${money(sum((m) => m.expense))}</td><td>${amount(months.at(-1).balance)}</td></tr>
      </tbody></table></div></div>`;
}

/** 土銀帳：歷年水電氣入款與扣款，餘額跨年連續；原表結餘當對帳點。 */
function bankView() {
  const ledger = billing.bankLedger(ledgerSource());
  const summary = billing.bankYear(ledger, year);
  if (!summary.months.length) return '<div class="card"><p class="empty">這一年沒有土銀紀錄</p></div>';
  const diffs = ledger.filter((m) => m.diff);
  const items = billing.BANK_ITEMS.filter((k) => k !== '其他' || summary.months.some((m) => m.expenses.其他));
  const incomeTip = (m) => [m.opening && `${m.opening.note} ${money(m.opening.amount)}`, ...m.incomes.map((i) => [day(i.date), i.note || '入款', money(i.amount)].filter(Boolean).join(' '))].filter(Boolean).join('\n');
  // 扣款格逐筆：記在土銀名下的支出，水電氣以外歸「其他」（同 bankLedger）。
  const bankTip = (m, k) => m.source !== 'transactions' ? '' : entriesTip(monthEntries(m.month).filter((e) => e.by === billing.UTILITY_PAYER && e.amount > 0 &&
    (e.group === '水電氣' && billing.BANK_ITEMS.includes(e.item) ? e.item : '其他') === k), false);
  const cell = (m, value) => m.source === 'missing' ? '—' : value ? money(value) : '';
  // 有年度預算時，扣款就是預算條上的已用金額，不另放一格。
  const budget = utilityBudgetView(summary);
  return `<div class="tiles billing-tiles">${[['入款', summary.income], !budget && ['扣款', summary.expense], [year === monthKey().slice(0, 4) ? '目前餘額' : '年底餘額', summary.balance]].filter(Boolean).map(([name, value]) =>
      `<div class="tile"><div class="tile-label">${name}</div><div class="tile-value">${amount(value)}</div></div>`).join('')}</div>
    ${budget}
    ${diffs.length ? `<p class="report-notice bank-diffs" title="原表年初結餘與前期推算的餘額不同，之後餘額以原表為準">結餘不符：${diffs.map((m) => `${m.month} ${signed(m.diff)}`).join('、')}</p>` : ''}
    <div class="card"><div class="section-head"><h3 class="section-title">${year} 土銀帳</h3>${reconciledHint(billing.UTILITY_PAYER)}</div>
      <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動土銀帳"><table class="report-table bank-table"><thead><tr><th scope="col">月份</th><th scope="col" title="結餘是對帳點，不算入款；含公婆轉入">入款</th>${items.map((k) => `<th scope="col"${k === '其他' ? ' title="水電以外的扣款，例如 2021 年以前的房貸"' : ''}>${k}</th>`).join('')}<th scope="col">餘額</th></tr></thead><tbody>
        ${summary.months.map((m) => `<tr><th scope="row" title="${sourceTitle(m)}">${Number(m.month.slice(5))} 月</th><td${incomeTip(m) ? ` title="${esc(incomeTip(m))}"` : ''}>${cell(m, m.income)}${m.opening ? `<small>結餘 ${money(m.opening.amount)}</small>` : ''}</td>${items.map((k) => `<td${m.expenses[k] ? tipAttr(bankTip(m, k)) : ''}>${cell(m, m.expenses[k])}</td>`).join('')}<td>${amount(m.balance)}${m.adjust ? adjustBadge(m) : m.diff ? `<small class="is-expense" title="原表結餘 ${money(m.opening.amount)}，前期推算 ${money(m.opening.amount - m.diff)}">差 ${signed(m.diff)}</small>` : ''}</td></tr>`).join('')}
        <tr class="report-total"><th scope="row">合計</th><td${tipAttr(monthsTip(summary.months.map((m) => [m.month, m.income])))}>${money(summary.income)}</td>${items.map((k) => `<td${tipAttr(monthsTip(summary.months.map((m) => [m.month, m.expenses[k]])))}>${money(summary.months.reduce((s, m) => s + (m.expenses[k] || 0), 0))}</td>`).join('')}<td>${amount(summary.balance)}</td></tr>
      </tbody></table></div></div>`;
}

function yearView() {
  const n = elapsed(year), months = monthsFor(year), current = months.slice(0, n).filter((m) => m.source !== 'pending');
  const totals = billing.reportTotals(current);
  const previous = billing.reportTotals(monthsFor(String(Number(year) - 1)).filter((m, i) => i < n && months[i].source !== 'pending'));
  const hasPending = months.slice(0, n).some((m) => m.source === 'pending');
  const label = n === 0 ? '未到年度' : `${periodLabel(months, n)}${year === monthKey().slice(0, 4) && months[n - 1]?.source === 'transactions' ? '（含本月）' : ''}`;
  const conflicts = current.filter((m) => m.conflict);
  const missing = current.some((m) => m.source === 'missing');
  return `${summaryTiles(totals, label, n ? previous : null)}
    ${missing ? '<p class="report-notice">部分月份缺資料，合計顯示「—」</p>' : ''}
    ${hasPending ? '<p class="report-notice">待補月結月份不計入合計</p>' : ''}
    ${conflicts.length ? `<p class="report-notice">${conflicts.map((m) => m.month).join('、')} 只採歷史月結</p>` : ''}
    ${current.some((m) => m.daily < 0) ? '<p class="report-notice">歷史扣除列項後開銷有負值，請核對</p>' : ''}
    ${charts.monthly(year)}
    ${yearTable(months, n, totals)}${detailMonth ? detailView(months.find((m) => m.month === detailMonth)) : ''}`;
}

const sourceLabel = (source) => ({ history: '歷史月結', transactions: '即時記帳', pending: '待補月結', missing: '缺少歷史' }[source] || '—');

function periodLabel(months, n) {
  const included = months.slice(0, n).map((m, i) => m.source === 'pending' ? null : i + 1).filter(Boolean);
  if (!included.length) return '尚無已入帳月份';
  const ranges = [];
  for (const month of included) {
    const last = ranges.at(-1);
    if (last && month === last[1] + 1) last[1] = month;
    else ranges.push([month, month]);
  }
  return ranges.map(([a, b]) => a === b ? String(a) : `${a}–${b}`).join('、') + ' 月';
}

/** 年度明細：列是大項（點開看項目），欄是月份；月消費總額與家庭總支出接在算進它們的大項後面。 */
const YEAR_GROUPS = [['房', 'house'], ['女兒', 'daughter'], ['兒子', 'son'], ['日常', 'daily', '扣除列項後開銷']];
const itemRank = (group, item) => {
  const i = group === '日常' ? billing.DAILY_ORDER.indexOf(item) : billing.BILLING_CATEGORIES.indexOf(`${group}／${item}`);
  return i < 0 ? 999 : i;
};

function yearTable(months, n, totals) {
  const items = billing.classificationMatrix(months);
  const counted = (i) => i < n && !['pending', 'missing'].includes(months[i].source);
  // 大項與項目的 0 留空比較好讀；總額列照常顯示。
  // tip(m) 回傳某月那一格的明細；即時記帳的月份才有逐筆交易。
  const cells = (pick, blankZero = true, tip = () => '') => months.map((m, i) => {
    const v = i >= n ? '' : pick(m, i);
    const blank = v === '' || (blankZero && v === 0);
    return `<td data-month="${m.month}"${i >= n ? ' class="is-future"' : ''}${blank || v === null ? '' : tipAttr(tip(m, i))}>${blank ? '' : amount(v)}</td>`;
  }).join('');
  const entries = (m, keep, withItem) => m.source === 'transactions' ? entriesTip(monthEntries(m.month).filter(keep), withItem) : '';
  const sumTip = (value) => tipAttr(monthsTip(months.map((m, i) => [m.month, counted(i) ? value(m, i) : null])));
  const group = ([name, key, tip]) => {
    const open = openGroups.has(name);
    const rows = items.filter((r) => r.group === name).sort((a, b) => itemRank(name, a.item) - itemRank(name, b.item) || a.item.localeCompare(b.item, 'zh-Hant'));
    const head = `<tr class="group-row" data-group="${name}"><th scope="row"><button type="button" class="group-toggle" data-year-group="${name}" aria-expanded="${open}"${tip ? ` title="${tip}"` : ''}><span aria-hidden="true">${open ? '▾' : '▸'}</span>${name}</button></th>${cells((m) => m[key], true, (m) => entries(m, (e) => e.group === name))}<td class="year-sum"${sumTip((m) => m[key])}>${amount(totals[key])}</td></tr>`;
    const body = open ? rows.map((r) => {
      const known = r.months.filter((v, i) => counted(i) && v !== null);
      return `<tr class="item-row"><th scope="row">${esc(r.item)}</th>${cells((m, i) => r.months[i], true, (m) => entries(m, (e) => e.group === r.group && e.item === r.item, false))}<td class="year-sum"${sumTip((m, i) => r.months[i])}>${known.length ? amount(known.reduce((s, v) => s + v, 0)) : '—'}</td></tr>`;
    }).join('') : '';
    return `<tbody>${head}${body}</tbody>`;
  };
  // 總額列的明細是組成它的大項。
  const parts = { monthlyTotal: [['房', 'house'], ['女兒', 'daughter'], ['兒子', 'son'], ['日常', 'daily']], total: [['月消費總額', 'monthlyTotal'], ['水電氣', 'utilities']] };
  const partsTip = (key) => (m) => parts[key].map(([name, k]) => `${name} ${amount(m[k])}`).join('\n');
  const total = (key, label, tip) => `<tbody><tr class="report-total" data-total="${key}"><th scope="row" title="${tip}">${label}</th>${cells((m) => m[key], false, partsTip(key))}<td class="year-sum"${sumTip((m) => m[key])}>${amount(totals[key])}</td></tr></tbody>`;
  const head = months.map((m, i) => `<th scope="col"${i >= n ? ' class="is-future"' : ''} title="${i >= n ? '未到月份' : m.source === 'transactions' ? '到本月看這個月' : `${sourceLabel(m.source)}，點開看當月明細`}"><button type="button" class="text-button" data-billing-month="${m.month}">${i + 1}月</button>${i < n && ['pending', 'missing'].includes(m.source) ? `<small>${sourceLabel(m.source)}</small>` : ''}</th>`).join('');
  return `<div class="card"><h3 class="section-title" title="點大項看底下的項目，點月份看那個月">年度明細</h3>
    <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動年度明細"><table class="report-table group-table year-table"><thead><tr><th scope="col">項目</th>${head}<th scope="col">合計</th></tr></thead>
      ${YEAR_GROUPS.map(group).join('')}
      ${total('monthlyTotal', '月消費總額<small>不含水電氣</small>', '房、女兒、兒子與日常')}
      ${group(['水電氣', 'utilities'])}
      ${total('total', '家庭總支出', '月消費總額＋水電氣')}
    </table></div></div>`;
}

function detailView(m) {
  if (!m) return '';
  if (m.month > monthKey()) return `<div class="card" id="billing-detail"><h3>${m.month}</h3><p class="empty">未到月份</p></div>`;
  if (m.source === 'missing') return `<div class="card" id="billing-detail"><h3>${m.month}</h3><p class="empty">沒有歷史月結資料</p></div>`;
  if (m.source === 'pending') return `<div class="card" id="billing-detail"><h3>${m.month} 待補月結</h3><p class="setting-hint">不計入年度合計${m.testCount ? ` · ${m.testCount} 筆測試交易` : ''}</p>${m.testCount ? '<button class="btn-quiet" type="button" id="billing-show-records">查看測試交易</button>' : ''}</div>`;
  const lines = (m.details || []).filter((d) => d.amount || d.note);
  return `<div class="card" id="billing-detail"><h3 class="section-title" title="保留原始列與備註，各列不再相加">${m.month} 原月結明細</h3>
    ${lines.length ? lines.map((d) => `<div class="setting-row"><div><div class="setting-name">${esc(d.item)}</div><p class="setting-hint">${esc(d.group)}${d.note ? ` · ${esc(d.note)}` : ''}</p></div><strong>${amount(d.amount)}</strong></div>`).join('') : '<p class="empty">這個月沒有費用紀錄</p>'}
  </div>`;
}

/** 跨年：費用趨勢圖，加上各年同期的分類細項 YOY。列照年度明細排：總覽列點開看底下的項目，月消費總額與家庭總支出接在算進它們的大項後面。 */
const COMPARE_ROWS = [['房', '房'], ['女兒', '女兒'], ['兒子', '兒子'], ['日常', '扣除列項後開銷'], ['', '月消費總額（不含水電氣）'], ['水電氣', '水電氣'], ['', '家庭總支出'], ['家用'], ['Shareroo'], ['收入']];

function compareView() {
  const years = charts.years().sort((a, b) => b - a), n = elapsed(year), reference = monthsFor(year);
  const selected = (y) => monthsFor(y).filter((m, i) => i < n && reference[i].source !== 'pending');
  const options = charts.itemOptions();
  const itemMonths = new Map();
  for (const y of new Set(years.flatMap((y) => [y, String(Number(y) - 1)]))) {
    itemMonths.set(y, selected(y).map((month) => ({ month, entries: billing.monthItems(month) })));
  }
  const sum = (y, key) => {
    const values = itemMonths.get(y).map(({ month, entries }) => billing.itemValue(month, key, entries));
    if (JSON.parse(key)[1] === '餘額') return values.at(-1) ?? null;
    return !values.length || values.some((v) => v === null) ? null : values.reduce((s, v) => s + v, 0);
  };
  const cells = (key, item = '') => years.map((y) => {
    const current = sum(y, key), prev = sum(String(Number(y) - 1), key);
    const tip = monthsTip(itemMonths.get(y).map(({ month, entries }) => [month.month, billing.itemValue(month, key, entries)]));
    return `<td${current === null ? '' : tipAttr(tip)}>${amount(current)}${deltaBadge(current, prev, ['收入', '餘額'].includes(item))}</td>`;
  }).join('');
  const row = ([group, overview]) => {
    if (!group) return `<tbody><tr class="report-total">${overview === '家庭總支出' ? '<th scope="row" title="月消費總額＋水電氣">家庭總支出</th>' : '<th scope="row" title="房、女兒、兒子與日常">月消費總額<small>不含水電氣</small></th>'}${cells(billing.itemKey('總覽', overview))}</tr></tbody>`;
    const items = options.filter((o) => o.group === group);
    if (!items.length) return '';
    // 和年度明細的展開狀態分開記。
    const id = `跨年／${group}`, open = openGroups.has(id);
    const head = `<tr class="group-row"><th scope="row"><button type="button" class="group-toggle" data-year-group="${id}" aria-expanded="${open}"${overview && overview !== group ? ` title="${overview}"` : ''}><span aria-hidden="true">${open ? '▾' : '▸'}</span>${group}</button></th>${overview ? cells(billing.itemKey('總覽', overview)) : years.map(() => '<td></td>').join('')}</tr>`;
    const body = open ? items.map((o) => `<tr class="item-row"><th scope="row">${esc(o.item)}</th>${cells(o.key, o.item)}</tr>`).join('') : '';
    return `<tbody>${head}${body}</tbody>`;
  };
  return `${charts.growth()}<div class="card"><h3 class="section-title" title="增減以去年同期為基準；待補月份不加入比較，去年為零或資料不足不計百分比">各年 ${n ? periodLabel(reference, n) : '同期'}</h3>
    <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動跨年比較"><table class="report-table group-table"><thead><tr><th scope="col">項目</th>${years.map((y) => `<th scope="col">${y}</th>`).join('')}</tr></thead>
      ${COMPARE_ROWS.map(row).join('')}
    </table></div></div>`;
}

function deltaBadge(current, previous, goodWhenUp = false) {
  const pct = billing.percentChange(current, previous);
  if (pct === null) return '';
  const cls = Math.abs(pct) < .05 ? '' : (pct > 0) === goodWhenUp ? 'is-income' : 'is-expense';
  return `<small class="yoy-delta ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</small>`;
}

export const selectedDetailMonth = () => detailMonth;

/** 全部月份的紀錄：同步一次月份目錄，只重讀有變更的月份。 */
export async function loadAll() {
  await refresh();
  return allLoaded();
}
export const allRecords = () => records;
export const allLoaded = () => initialized && !missing.size;
