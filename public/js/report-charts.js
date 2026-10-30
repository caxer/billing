import { STACK_GROUPS, itemKey, itemValue, monthItems, reportTotals } from './billing.js';
import { monthKey, money } from './calc.js';
import { stackedChart, lineChart } from './charts.js';
import { esc } from './html.js';
const colors = ['#38bdf8', '#4ade80', '#f472b6', '#a78bfa', '#fbbf24', '#f87171', '#2dd4bf'];
const sourceNote = (m) => ({ history: '歷史月結', transactions: '即時記帳', pending: '待補月結', missing: '缺少歷史' }[m.source]);

export class ReportCharts {
  constructor(root, context) {
    this.root = root; this.context = context; this.models = new Map(); this.selectedPoints = new Map();
    this.options = { monthly: { average: true, cumulative: true, extrema: true }, growth: { average: true, cumulative: false, extrema: true } };
    this.hidden = { monthly: new Set(), growth: new Set() };
    this.ranges = { growth: {} };
    this.growthMode = 'annual'; this.search = ''; this.selectedItems = new Set([itemKey('總覽', '家庭總支出')]);
    root.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-chart-option]');
      if (toggle) { const id = toggle.dataset.chartId; const key = toggle.dataset.chartOption; this.options[id][key] = !this.options[id][key]; this.context.draw(); }
      const group = e.target.closest('[data-chart-group]');
      if (group) {
        const hidden = this.hidden[group.dataset.chartId], key = group.dataset.chartGroup;
        hidden.has(key) ? hidden.delete(key) : hidden.add(key); this.context.draw();
      }
      const mode = e.target.closest('[data-growth-mode]');
      if (mode) { this.growthMode = mode.dataset.growthMode; this.ranges.growth = {}; this.selectedPoints.delete('growth'); this.context.draw(); }
      const action = e.target.closest('[data-items-action]');
      if (action) { this.selectedItems = new Set(action.dataset.itemsAction === 'all' ? this.itemOptions().map((o) => o.key) : []); this.context.draw(); }
      if (e.target.closest('[data-range-reset]')) { const id = e.target.closest('[data-range-reset]').dataset.rangeReset; this.ranges[id] = {}; this.context.draw(); }
      this.showPoint(e);
    });
    root.addEventListener('change', (e) => {
      const input = e.target;
      if (input.dataset.chartRange) {
        const id = input.dataset.chartId, edge = input.dataset.chartRange;
        this.ranges[id][edge] = input.value;
        const range = this.ranges[id];
        if (range.start && range.end && range.start > range.end) range[edge === 'start' ? 'end' : 'start'] = input.value;
        this.selectedPoints.delete(id); this.context.draw();
      }
      if (input.hasAttribute('data-chart-item')) { input.checked ? this.selectedItems.add(input.value) : this.selectedItems.delete(input.value); this.context.draw(); }
    });
    root.addEventListener('input', (e) => { if (e.target.id === 'growth-item-search') { this.search = e.target.value; this.context.draw(); } });
    // 圖寬照卡片量，轉向或縮放視窗後重畫；分頁隱藏時寬 0 不算。
    let width = 0;
    new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next && width && next !== width) this.context.draw();
      if (next) width = next;
    }).observe(root);
    root.addEventListener('pointerover', (e) => this.showPoint(e));
    root.addEventListener('focusin', (e) => this.showPoint(e));
    root.addEventListener('keydown', (e) => { if (e.target.closest('[data-chart-point]') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); this.showPoint(e); } });
  }

  showPoint(e) {
    const hit = e.target.closest('[data-chart-point]');
    if (!hit) return;
    const model = this.models.get(hit.dataset.chartId), index = Number(hit.dataset.chartPoint);
    // 單年走勢不放提示框，柱子只靠 title 顯示當月合計。
    if (!model?.points[index] || !this.root.querySelector(`#${hit.dataset.chartId}-tooltip`)) return;
    this.selectedPoints.set(hit.dataset.chartId, model.points[index].key);
    this.root.querySelector(`#${hit.dataset.chartId}-tooltip`).innerHTML = model.tooltip(index);
  }

  beginRender() { this.models.clear(); this.cachedItems = null; }
  afterRender() {
    for (const [id, key] of this.selectedPoints) {
      const model = this.models.get(id), index = model?.points.findIndex((p) => p.key === key);
      if (index >= 0) this.root.querySelector(`#${id}-tooltip`).innerHTML = model.tooltip(index);
    }
  }

  years() {
    return this.context.years().filter((y) => y <= monthKey().slice(0, 4) && (y === monthKey().slice(0, 4) || this.context.months(y).some((m) => m.source === 'history' || m.details?.length))).sort();
  }

  monthPoints(year) {
    return this.context.months(year).map((m, i) => ({ key: m.month, label: `${i + 1}月`, total: m.total, values: m,
      available: m.month <= monthKey() && ['history', 'transactions'].includes(m.source) && m.total !== null,
      note: m.month > monthKey() ? '未到月份' : sourceNote(m) }));
  }

  range(points, id, defaultStart = null) {
    const state = this.ranges[id];
    let start = points.findIndex((p) => p.key === (state.start ?? defaultStart));
    if (start < 0) start = 0;
    let end = points.findIndex((p) => p.key === state.end);
    if (end < 0) end = points.length - 1;
    if (start > end) { if (state.start) end = start; else start = end; }
    return { start, end, visible: points.slice(start, end + 1) };
  }

  controls(id, annual = false) {
    // 每條線怎麼算放在按鈕提示，不另寫說明。
    const tips = {
      average: annual ? '只算範圍內完整年度；沒有完整年度時採已入帳年度平均' : '只算有支出的已入帳月份',
      cumulative: '從顯示範圍起算，使用右軸',
      extrema: '標出最高與最低',
    };
    return `<div class="chart-tools">${[['average', annual ? '年均線' : '月均線'], ['cumulative', '累積線'], ['extrema', '極值']].map(([key, name]) =>
      `<button type="button" id="${id}-option-${key}" class="chip chart-toggle ${this.options[id][key] ? 'is-on' : ''}" data-chart-id="${id}" data-chart-option="${key}" aria-pressed="${this.options[id][key]}" title="${tips[key]}">${name}</button>`).join('')}</div>`;
  }

  legend(id) {
    return `<div class="chart-legend" role="group" aria-label="顯示分類" title="點分類隱藏或顯示，不影響報表合計">${STACK_GROUPS.map((g) => `<button type="button" id="${id}-group-${g.key}" class="chart-legend-button ${this.hidden[id].has(g.key) ? 'is-hidden' : ''}" data-chart-id="${id}" data-chart-group="${g.key}" aria-pressed="${!this.hidden[id].has(g.key)}"><i class="dot" style="background:${g.color}"></i>${g.name}</button>`).join('')}</div>`;
  }

  rangeControls(points, selected, id) {
    return `<div class="chart-range"><select id="${id}-range-start" aria-label="範圍起始" data-chart-id="${id}" data-chart-range="start">${points.map((p, i) => `<option value="${esc(p.key)}"${i === selected.start ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select><span aria-hidden="true">–</span>
      <select id="${id}-range-end" aria-label="範圍結束" data-chart-id="${id}" data-chart-range="end">${points.map((p, i) => `<option value="${esc(p.key)}"${i === selected.end ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select><button type="button" id="${id}-range-reset" class="btn-quiet" data-range-reset="${id}" aria-label="重設範圍" title="重設範圍">重設</button></div>`;
  }

  /** 卡片內寬：圖至少撐滿它，多的月份才左右捲動。分頁隱藏量不到時用 680。 */
  fitWidth() {
    const probe = this.root.querySelector('#billing-content').appendChild(document.createElement('div'));
    probe.className = 'card chart-card';
    const style = getComputedStyle(probe), width = probe.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    probe.remove();
    return width > 0 ? width : 680;
  }

  plot(id, points, annual, tooltip = true) {
    const groups = STACK_GROUPS.filter((g) => !this.hidden[id].has(g.key));
    const model = stackedChart(points, groups, { ...this.options[id], annual, id, fit: this.fitWidth() });
    this.models.set(id, { ...model, points });
    return `${this.legend(id)}${model.html}${tooltip ? `<div class="chart-tooltip" id="${id}-tooltip" role="status" title="點柱子看各分類金額">${annual ? '年均' : '月均'} ${model.stats.average === null ? '—' : money(model.stats.average)}</div>` : ''}`;
  }

  monthly(year) {
    // 一年只有 12 個月，不需要範圍選擇；各月分類金額看下面的年度明細。
    return `<div class="card chart-card"><div class="section-head"><h3 class="section-title">${year} 支出走勢</h3>${this.controls('monthly')}</div>
      ${this.plot('monthly', this.monthPoints(year), false, false)}</div>`;
  }

  itemOptions() {
    if (this.cachedItems) return this.cachedItems;
    const options = new Map();
    for (const year of this.years()) for (const month of this.context.months(year).filter((m) => m.month <= monthKey())) {
      for (const [key, item] of monthItems(month)) options.set(key, { key, group: item.group, item: item.item, name: `${item.group}／${item.item}` });
    }
    const order = ['總覽', '家用', '水電氣', '房', '女兒', '兒子', 'Shareroo', '日常', '收入'];
    this.cachedItems = [...options.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.item.localeCompare(b.item, 'zh-Hant'));
    return this.cachedItems;
  }

  growth() {
    const annual = this.growthMode === 'annual', years = this.years();
    const modeButtons = `<div class="seg chart-modes" role="group" aria-label="趨勢圖模式">${[['annual', '年度堆疊'], ['items', '月份細項對比']].map(([key, name]) => `<button type="button" id="growth-mode-${key}" class="seg-btn ${this.growthMode === key ? 'is-on' : ''}" aria-pressed="${this.growthMode === key}" data-growth-mode="${key}">${name}</button>`).join('')}</div>`;
    let drawing, points, selected, picker = '';
    if (annual) {
      points = years.map((y) => {
        const months = this.context.months(y).filter((m) => m.month <= monthKey() && m.source !== 'pending');
        const totals = reportTotals(months), count = months.filter((m) => m.source !== 'missing').length;
        return { key: y, label: y, values: totals, total: totals.total, available: count > 0 && totals.total !== null,
          complete: count === 12 && y < monthKey().slice(0, 4), note: `${count} 個月已入帳${count === 12 ? ' · 全年' : ' · 部分年度'}` };
      });
      selected = this.range(points, 'growth');
      drawing = this.plot('growth', selected.visible, true);
    } else {
      const months = years.flatMap((y) => this.context.months(y).filter((m) => m.month <= monthKey()));
      points = months.map((m) => ({ key: m.month, label: m.month, total: m.total, month: m, note: sourceNote(m) }));
      selected = this.range(points, 'growth', points.find((p) => p.key.startsWith(this.context.year()))?.key);
      const options = this.itemOptions();
      const chosen = options.filter((o) => this.selectedItems.has(o.key));
      const entries = selected.visible.map((p) => monthItems(p.month));
      const series = chosen.map((o, i) => ({ ...o, isBalance: o.item === '餘額', color: colors[i % colors.length], values: selected.visible.map((p, j) => itemValue(p.month, o.key, entries[j])) }));
      const model = lineChart(selected.visible, series, { ...this.options.growth, id: 'growth', fit: this.fitWidth() });
      this.models.set('growth', { ...model, points: selected.visible });
      const filtered = options.filter((o) => o.name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
      picker = `<details class="item-picker" id="growth-item-picker"><summary id="growth-item-summary">選擇細項（${chosen.length}）</summary><input id="growth-item-search" type="search" placeholder="搜尋細項" aria-label="搜尋趨勢細項" value="${esc(this.search)}"/><div class="chart-tools"><button type="button" id="growth-items-all" class="btn-quiet" data-items-action="all">全選</button><button type="button" id="growth-items-clear" class="btn-quiet" data-items-action="clear">清除</button></div><div class="item-choices">${filtered.map((o) => `<label><input type="checkbox" id="growth-item-${options.indexOf(o)}" data-chart-item value="${esc(o.key)}"${this.selectedItems.has(o.key) ? ' checked' : ''}/><span>${esc(o.name)}</span></label>`).join('')}</div></details>`;
      drawing = `<div class="chart-legend">${series.map((s) => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>${model.html}<div class="chart-tooltip" id="growth-tooltip" role="status" title="點月份看所選細項；缺細項或待補月份會斷線，餘額只顯示期末值"></div>`;
    }
    return `<div class="card chart-card"><div class="section-head"><h3 class="section-title">費用增長趨勢</h3>${this.controls('growth', annual)}</div>${modeButtons}${picker}${drawing}${this.rangeControls(points, selected, 'growth')}</div>`;
  }
}
