import * as store from './store.js';
import * as billing from './billing.js';
import { monthKey, money } from './calc.js';
import { ReportCharts } from './report-charts.js';
import { esc } from './html.js';
const amount = (n) => n === null || n === undefined ? '—' : money(n);
const METRICS = [['house', '房'], ['daughter', '女兒'], ['son', '兒子'], ['daily', '扣除列項後開銷'], ['utilities', '水電氣'], ['monthlyTotal', '月消費總額'], ['total', '家庭總支出']];
// 欄位怎麼算放在表頭提示，不佔版面。
const METRIC_TIPS = { daily: '日常開銷', monthlyTotal: '房、女兒、兒子與日常', total: '月消費總額＋水電氣' };
const metricHead = ([key, label]) => `<th scope="col"${METRIC_TIPS[key] ? ` title="${METRIC_TIPS[key]}"` : ''}>${label}</th>`;
let root, context, year = monthKey().slice(0, 4), mode = 'year', detailMonth = null;
let archive = null;
let records = {}, versions = new Map(), active = false, initialized = false, running = null, error = '', lastSync = null;
let revision = 0;
let charts;
const monthCache = new Map();

export function init(element, getters) {
  root = element;
  context = getters;
  root.innerHTML = `
    <div class="stack billing-layout">
      <div class="card report-controls">
        <div class="seg" role="group" aria-label="月結檢視"><button class="seg-btn is-on" type="button" data-report-mode="year" aria-pressed="true">年度月表</button><button class="seg-btn" type="button" data-report-mode="compare" aria-pressed="false">跨年比較</button><button class="seg-btn" type="button" data-report-mode="yoy" aria-pressed="false">分類 YOY</button></div>
        <label class="field"><select id="billing-year" aria-label="月結年度"></select></label>
      </div>
      <p id="billing-status" class="report-status" role="status"></p>
      <div id="billing-content" class="stack"></div>
    </div>`;

  root.querySelector('#billing-year').addEventListener('change', (e) => { year = e.target.value; detailMonth = null; draw(); });
  charts = new ReportCharts(root, { year: () => year, years: allYears, months: monthsFor, draw });
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-report-mode]');
    if (button) { mode = button.dataset.reportMode; detailMonth = null; draw(); }
    const monthButton = e.target.closest('[data-billing-month]');
    if (monthButton) { detailMonth = monthButton.dataset.billingMonth; draw(); root.querySelector('#billing-detail')?.scrollIntoView({ block: 'nearest' }); }
  });
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
      const [files, found] = await Promise.all([store.listMonths(), store.loadHistory()]);
      const changed = files.filter((f) => versions.get(f.month) !== f.sha);
      const updated = {};
      // 限制並行數量，避免一次打出所有年度請求。
      for (let i = 0; i < changed.length; i += 4) {
        const loaded = await Promise.all(changed.slice(i, i + 4).map((f) => store.loadMonth(f.month)));
        for (const data of loaded) updated[data.month] = data;
      }
      if (revision !== readingRevision) throw new Error('同步期間有新變更，請稍後重試');
      archive = found.archive;
      const present = new Set(files.map((f) => f.month));
      for (const key of Object.keys(records)) if (!present.has(key)) delete records[key];
      for (const data of Object.values(updated)) records[data.month] = data.items;
      versions = new Map(files.map((f) => [f.month, updated[f.month]?.sha ?? f.sha]));
      error = ''; initialized = true; lastSync = new Date();
      return true;
    } catch (err) { error = err.message || '年度資料同步失敗'; return false; }
    finally { running = null; context.sync?.(error ? 'error' : 'ok', error ? '同步失敗' : '已同步'); draw(); }
  })();
  return running;
}

function allYears() {
  const today = Number(monthKey().slice(0, 4));
  return [...new Set([String(today), String(today - 1), String(today + 1), year, ...(archive?.years || []), ...Object.keys(records).map((m) => m.slice(0, 4))])].sort((a, b) => Number(b) - Number(a));
}

function monthsFor(target) {
  if (!monthCache.has(target)) monthCache.set(target,
    billing.annualReport(target, records, archive?.data, archive?.cutoverMonth, context.settings()?.billingGroups, billing.historyEnd(archive)));
  return monthCache.get(target);
}

function elapsed(target) {
  const now = monthKey();
  return target < now.slice(0, 4) ? 12 : target > now.slice(0, 4) ? 0 : Number(now.slice(-2));
}

function draw() {
  if (!root) return;
  // 一次呈現共用年度計算結果；下一次呈現再讀取最新設定與交易。
  monthCache.clear();
  const select = root.querySelector('#billing-year');
  const years = allYears();
  if (JSON.stringify([...select.options].map((o) => o.value)) !== JSON.stringify(years)) {
    select.replaceChildren(...years.map((y) => new Option(`${y} 年`, y, false, y === year)));
  } else select.value = year;
  for (const button of root.querySelectorAll('[data-report-mode]')) {
    button.classList.toggle('is-on', mode === button.dataset.reportMode);
    button.setAttribute('aria-pressed', String(mode === button.dataset.reportMode));
  }
  const status = root.querySelector('#billing-status');
  status.classList.toggle('is-expense', !!error);
  status.textContent = error ? `${error}，按右上角同步重試` : !initialized ? '讀取中…' : '';
  status.hidden = !status.textContent;
  root.querySelector('#billing-year').title = [lastSync && `同步於 ${lastSync.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`,
    archive && `歷史月結至 ${billing.historyEnd(archive)} · 正式記帳 ${archive.cutoverMonth} 起`].filter(Boolean).join(' · ');
  const content = root.querySelector('#billing-content');
  if (!initialized) { content.innerHTML = '<div class="card"><p class="empty">尚未載入</p></div>'; return; }
  const expanded = new Set([...content.querySelectorAll('details[open]')].map((el) => el.id));
  const focused = document.activeElement;
  const focusId = content.contains(focused) ? focused.id : '';
  const caret = focused?.id === 'growth-item-search' ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrollSelector = '.report-table-wrap, .chart-scroll, .item-choices';
  const scrollKey = (el) => el.getAttribute('aria-label') || el.className;
  const scrolls = new Map([...content.querySelectorAll(scrollSelector)].map((el) => [scrollKey(el), [el.scrollLeft, el.scrollTop]]));
  charts.beginRender();
  content.innerHTML = mode === 'year' ? yearView() : mode === 'compare' ? compareView() : yoyView();
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
  return `<div class="tiles billing-tiles">
    ${[['家庭總支出', totals.total], ['月消費總額', totals.monthlyTotal], ['扣除列項後開銷', totals.daily], ['水電氣', totals.utilities]].map(([name, value]) =>
      `<div class="tile"><div class="tile-label">${name}</div><div class="tile-value">${amount(value)}</div></div>`).join('')}
    <p class="tile-period">${esc(label)}${previous && pct !== null ? ` · 去年同期 ${amount(previous.total)}` : ''}</p></div>`;
}

function yearView() {
  const n = elapsed(year), months = monthsFor(year), current = months.slice(0, n).filter((m) => m.source !== 'pending');
  const totals = billing.reportTotals(current);
  const previous = billing.reportTotals(monthsFor(String(Number(year) - 1)).filter((m, i) => i < n && months[i].source !== 'pending'));
  const hasPending = months.slice(0, n).some((m) => m.source === 'pending');
  const label = n === 0 ? '未到年度' : `${periodLabel(months, n)}${year === monthKey().slice(0, 4) && months[n - 1]?.source === 'transactions' ? '（含本月）' : ''}`;
  const conflicts = current.filter((m) => m.conflict);
  const missing = current.some((m) => m.source === 'missing');
  const stats = billing.reportStats(current);
  return `${summaryTiles(totals, label, n ? previous : null)}
    ${missing ? '<p class="report-notice">部分月份缺資料，合計顯示「—」</p>' : ''}
    ${hasPending ? '<p class="report-notice">待補月結月份不計入合計</p>' : ''}
    ${conflicts.length ? `<p class="report-notice">${conflicts.map((m) => m.month).join('、')} 只採歷史月結</p>` : ''}
    ${current.some((m) => m.daily < 0) ? '<p class="report-notice">歷史扣除列項後開銷有負值，請核對</p>' : ''}
    ${kpiView(stats, previous)}${charts.monthly(year)}
    <div class="card"><h3 class="section-title">年度月結明細</h3>
      <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動年度月結明細"><table class="report-table"><thead><tr><th scope="col">月份</th>${METRICS.map(metricHead).join('')}</tr></thead><tbody>
        ${months.map((m, i) => `<tr${i >= n ? ' class="future-month"' : ''}><th scope="row" title="${i >= n ? '未到月份' : sourceLabel(m.source)}"><button type="button" class="text-button" data-billing-month="${m.month}">${i + 1} 月</button>${i < n && ['pending', 'missing'].includes(m.source) ? `<small>${sourceLabel(m.source)}</small>` : ''}</th>${METRICS.map(([key]) => `<td>${i >= n ? '—' : amount(m[key])}</td>`).join('')}</tr>`).join('')}
        <tr class="report-total"><th scope="row">期間合計</th>${METRICS.map(([key]) => `<td>${amount(totals[key])}</td>`).join('')}</tr>
      </tbody></table></div>
    </div>${classificationView(months, n)}${detailMonth ? detailView(months.find((m) => m.month === detailMonth)) : ''}`;
}

function kpiView(stats, previous) {
  const top = stats.largest, percentage = billing.percentChange(stats.totals.total, previous.total);
  const pctText = percentage === null ? '—' : `${percentage > 0 ? '+' : ''}${percentage.toFixed(1)}%`;
  const peak = stats.highest, low = stats.lowest;
  const values = [
    ['月平均', amount(stats.average), '', `${stats.averageCount} 個有支出月份`],
    ['較去年同期', pctText, stats.totals.total === null || previous.total === null ? '缺少可比資料' : `${stats.totals.total >= previous.total ? '多花' : '少花'} ${amount(Math.abs(stats.totals.total - previous.total))}`],
    ['最大支出類別', top?.name || '—', top ? `${amount(top.amount)} · ${stats.totals.total ? (top.amount / stats.totals.total * 100).toFixed(1) : 0}%` : '—'],
    ['最高月份', peak ? `${Number(peak.month.slice(-2))}月` : '—', peak ? amount(peak.total) : '—'],
    ['最低月份', low ? `${Number(low.month.slice(-2))}月` : '—', low ? amount(low.total) : '—'],
  ];
  return `<div class="report-kpis" aria-label="期間重點指標">${values.map(([name, value, sub, tip = '']) => `<div class="card"${tip ? ` title="${esc(tip)}"` : ''}><span class="setting-hint">${name}</span><strong>${esc(value)}</strong>${sub ? `<span class="setting-hint">${esc(sub)}</span>` : ''}</div>`).join('')}</div>`;
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

function classificationView(months, n) {
  const rows = billing.classificationMatrix(months);
  return `<details class="card" id="billing-classifications"><summary title="歷史日常只有月合計；「—」表示沒有該粒度資料或未到月份">分類年度明細</summary>
    ${rows.length ? `<div class="report-table-wrap" tabindex="0" aria-label="可左右捲動分類年度明細"><table class="report-table"><thead><tr><th scope="col">分類／項目</th>${months.map((m, i) => `<th scope="col">${i + 1} 月</th>`).join('')}<th scope="col">期間已知合計</th></tr></thead><tbody>${rows.map((r) => {
      const known = r.months.slice(0, n).filter((v) => v !== null);
      return `<tr><th scope="row">${esc(r.item)}<small>${esc(r.group)}</small></th>${r.months.map((v, i) => `<td>${i >= n ? '—' : amount(v)}</td>`).join('')}<td>${known.length ? amount(known.reduce((sum, v) => sum + v, 0)) : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty">尚無分類明細</p>'}</details>`;
}

function detailView(m) {
  if (!m) return '';
  if (m.month > monthKey()) return `<div class="card" id="billing-detail"><h3>${m.month}</h3><p class="empty">未到月份</p></div>`;
  if (m.source === 'missing') return `<div class="card" id="billing-detail"><h3>${m.month}</h3><p class="empty">沒有歷史月結資料</p></div>`;
  if (m.source === 'pending') return `<div class="card" id="billing-detail"><h3>${m.month} 待補月結</h3><p class="setting-hint">不計入年度合計${m.testCount ? ` · ${m.testCount} 筆測試交易` : ''}</p>${m.testCount ? '<button class="btn-quiet" type="button" id="billing-show-records">查看測試交易</button>' : ''}</div>`;
  const lines = (m.details || []).filter((d) => d.amount || d.note);
  return `<div class="card" id="billing-detail"><h3 class="section-title"${m.source === 'history' ? ' title="保留原始列與備註，各列不再相加"' : ''}>${m.month} ${m.source === 'history' ? '原月結明細' : '分類明細'}</h3>
    ${lines.length ? lines.map((d) => `<div class="setting-row"><div><div class="setting-name">${esc(d.item)}</div><p class="setting-hint">${esc(d.group)}${d.note ? ` · ${esc(d.note)}` : ''}</p></div><strong>${amount(d.amount)}</strong></div>`).join('') : '<p class="empty">這個月沒有費用紀錄</p>'}
    ${m.source === 'transactions' ? '<button class="btn-quiet" type="button" id="billing-show-records">查看當月交易</button>' : ''}
  </div>`;
}

function compareView() {
  const years = allYears().filter((y) => y <= monthKey().slice(0, 4)).sort();
  const n = elapsed(year);
  const reference = monthsFor(year);
  const selectMonths = (target) => monthsFor(target).filter((m, i) => i < n && reference[i].source !== 'pending');
  return `${charts.growth()}<div class="card"><h3 class="section-title">各年度同期間比較</h3><p class="setting-hint" title="待補月份不加入比較；缺少的歷史顯示「—」">${n ? `各年 ${periodLabel(reference, n)}` : '請選已開始的年度'}</p>
    <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動跨年比較"><table class="report-table"><thead><tr><th scope="col">年度</th>${METRICS.map(metricHead).join('')}<th scope="col">較去年同期</th></tr></thead><tbody>
    ${years.map((y) => {
      const totals = billing.reportTotals(selectMonths(y));
      const prev = billing.reportTotals(selectMonths(String(Number(y) - 1)));
      return `<tr><th scope="row">${y}</th>${METRICS.map(([key]) => `<td>${n ? amount(totals[key]) : '—'}${n ? deltaBadge(totals[key], prev[key]) : ''}</td>`).join('')}<td>${n ? deltaBadge(totals.total, prev.total, false, true) : '—'}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}

function deltaBadge(current, previous, goodWhenUp = false, showMissing = false) {
  const pct = billing.percentChange(current, previous);
  if (pct === null) return showMissing ? '—' : '';
  const cls = Math.abs(pct) < .05 ? '' : (pct > 0) === goodWhenUp ? 'is-income' : 'is-expense';
  return `<small class="yoy-delta ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</small>`;
}

function yoyView() {
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
  return `<div class="card"><h3 class="section-title">分類與細項 YOY</h3><p class="setting-hint" title="增減以去年同期為基準；去年為零或資料不足不計百分比">各年 ${periodLabel(reference, n)}</p>
    <div class="report-table-wrap" tabindex="0" aria-label="可左右捲動分類細項 YOY"><table class="report-table"><thead><tr><th scope="col">分類／項目</th>${years.map((y) => `<th scope="col">${y}</th>`).join('')}</tr></thead><tbody>${options.map((o) => `<tr><th scope="row">${esc(o.item)}<small>${esc(o.group)}</small></th>${years.map((y) => {
      const current = sum(y, o.key), prev = sum(String(Number(y) - 1), o.key);
      return `<td>${amount(current)}${deltaBadge(current, prev, ['收入', '餘額'].includes(o.item))}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}

export const selectedDetailMonth = () => detailMonth;

export function lock() {
  archive = null;
  records = {};
  versions.clear();
  initialized = false;
  draw();
}
