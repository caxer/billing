// 看板、統計與設定的畫面組裝。全部輸出 HTML 字串，事件在 app.js 綁。

import * as calc from './calc.js';
import { budgetFor, all as allSettings } from './settings.js';
import { transactionSummary, GROUPS, UTILITY_PAYER, utilityBudget } from './billing.js';
import { esc } from './html.js';

const tile = (label, value, mod, sub) => `
  <div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value ${mod}">${esc(value)}</div>
    ${sub ? `<div class="tile-sub ${sub.cls || ''}">${esc(sub.text)}</div>` : ''}
  </div>`;

const changeSub = (cur, prev) => {
  if (prev === 0) return null;
  const pct = calc.changePercent(cur, prev);
  return { text: `較上月 ${pct > 0 ? '+' : ''}${pct}%`, cls: pct > 0 ? 'is-up' : 'is-down' };
};

/** 人的配色依設定順序循環，讓額度條與堆疊圖用同一組顏色。 */
const personColor = (index) => `var(--person-${(index % 4) + 1})`;

const personLabel = (person, index) =>
  `<i class="dot" style="background:${personColor(index)}" aria-hidden="true"></i>${esc(person)}`;

function budgetRow({ person, index, spent, limit }) {
  const label = personLabel(person, index);
  if (!limit) {
    return `<div class="budget-row">
      <div class="budget-head"><span class="budget-title">${label}</span>
        <span class="budget-num">已花 ${calc.money(spent)} 元</span></div>
    </div>`;
  }
  const used = Math.round((spent / limit) * 100);
  const pct = Math.min(100, used);
  const over = spent > limit;
  const near = !over && pct >= 80;
  const left = limit - spent;
  return `
    <div class="budget-row">
      <div class="budget-head">
        <span class="budget-title">${label}</span>
        <span class="budget-num">${calc.money(spent)} / ${calc.money(limit)}</span>
      </div>
      <div class="bar" role="progressbar" aria-label="${esc(person)}支出額度使用進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="已用 ${used}%"><div class="bar-fill ${over ? 'is-over' : near ? 'is-warn' : ''}" style="width:${pct}%"></div></div>
      <p class="budget-note ${over ? 'is-over' : ''}">
        ${over ? `已超出 ${calc.money(-left)} 元` : `還可花 ${calc.money(left)} 元`} · 已用 ${used}%
      </p>
    </div>`;
}

function budgetCard(items, month, people) {
  const rows = people.map((person, index) => ({
    person,
    index,
    spent: calc.summarize(items.filter((it) => it.by === person)).expense,
    limit: budgetFor(person, month),
  })).filter((row) => row.person !== UTILITY_PAYER);
  if (!rows.some((row) => row.limit)) return '';
  return `<div class="card">
    <div class="budget-head"><span class="budget-title">本月額度</span></div>
    ${rows.map(budgetRow).join('')}
  </div>`;
}

/** 明細的記帳人顏色與每日支出圖相同：名單順序在前，名單外的舊記帳人接在後面。 */
const colorPeople = (items, people) => [...new Set([...people, ...items.map((it) => it.by || '')])];

function recordRow(it, color) {
  const cls = it.type === 'income' ? 'is-income' : 'is-expense';
  const sign = it.type === 'income' ? '+' : '−';
  return `
    <li><button type="button" class="row${color ? ' has-who' : ''}"${color ? ` style="--who:${color}"` : ''} data-id="${esc(it.id)}" aria-label="編輯 ${esc(it.date)} ${esc(it.note || it.category)} ${calc.money(it.amount)} 元">
      <span class="row-main">
        <span class="row-title">${esc(it.note || it.category || '未填內容')}</span>
        <span class="row-meta">${esc(it.date)} · ${esc(it.category)}${it.by ? ` · ${esc(it.by)}` : ''}</span>
      </span>
      <span class="row-amount ${cls}">${sign}${calc.money(it.amount)}</span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </button></li>`;
}

const recordList = (items, colors) => `<ul class="list">${items.map((it) => recordRow(it, colors.get(it.by || ''))).join('')}</ul>`;

/* ---------- 統計：本月月結與額度 ---------- */

function billingCard(items) {
  const summary = transactionSummary(items, allSettings()?.billingGroups);
  return `<div class="card billing-month-card"><div class="budget-head"><span class="budget-title">本月月結</span></div>
    <div class="billing-mini-grid">${[['月消費總額（不含水電氣）', summary.monthlyTotal, '含房與子女'], ['扣除列項後開銷', summary.daily, '日常'], ['水電氣', summary.utilities, '另計'], ['家庭總支出', summary.total, '月消費總額＋水電氣']].map(([name, total, tip]) =>
      `<div title="${tip}"><span class="setting-hint">${name}</span><strong>${calc.money(total)}</strong></div>`).join('')}</div>
    <div class="billing-parts">${[['房', summary.house], ['女兒', summary.daughter], ['兒子', summary.son]].map(([name, total]) => `<span>${name} <b>${calc.money(total)}</b></span>`).join('')}</div></div>`;
}

/* ---------- 統計 ---------- */

/** 單一色塊：高度是整條柱子的百分比，所以要除以柱子的總高。 */
const stackSeg = (bucket, person, index, stackTotal) => {
  const amount = bucket.parts.get(person) || 0;
  if (!amount || !stackTotal) return '';
  return `<div class="bars-seg" style="height:${(amount / stackTotal) * 100}%;background-color:${personColor(index)}"></div>`;
};

export function stats(month, items, prevItems, categoryType, people = []) {
  // 舊紀錄保留原記帳人，即使名單刪除或改名也不能從圖表消失。
  const recordPeople = colorPeople(items, people);
  const { expense, income, net } = calc.summarize(items);
  const previous = calc.summarize(prevItems);
  const spent = calc.byDay(items, month, 'expense');
  // 只畫支出；收入資料照常記錄，但不在這張圖上呈現。
  const peak = Math.max(0, ...spent.map((d) => d.total));
  const maxDay = Math.max(1, peak);
  const todayDay = Number(calc.todayKey().slice(-2));
  const isThisMonth = month === calc.monthKey();
  const bars = spent
    .map((d) => {
      const segs = recordPeople
        .map((person, index) => stackSeg(d, person, index, d.total))
        .join('');
      const tip = recordPeople.map((p) => `${esc(p || '未指定')} ${calc.money(d.parts.get(p) || 0)}`).join(' · ');
      const isToday = d.day === todayDay && isThisMonth;
      return `<div class="bars-col ${isToday ? 'is-today' : ''}" title="${isToday ? '今天 ' : ''}${d.date}：${tip || '0 元'}"><div class="bars-stack" style="height:${Math.round((d.total / maxDay) * 100)}%">${segs}</div></div>`;
    })
    .join('');
  // 本月的今天在 X 軸標日期；靠近月初月底時省略被擋到的端點。
  const days = calc.dayCount(month);
  const near = (day) => isThisMonth && Math.abs(todayDay - day) < 4;
  const axis = `<div class="chart-axis">${near(1) ? '<span></span>' : '<span>1 日</span>'}${isThisMonth ? `<span class="chart-today" style="left:${((todayDay - 0.5) / days) * 100}%">${todayDay} 日</span>` : ''}${near(days) ? '<span></span>' : `<span>${days} 日</span>`}</div>`;
  const legend = recordPeople.map((p, i) => `<span class="legend-item"><i class="dot" style="background:${personColor(i)}" aria-hidden="true"></i>${esc(p || '未指定')}</span>`).join('');

  const cats = calc.byCategory(items, categoryType);
  const catTotal = cats.reduce((a, c) => a + c.total, 0);

  return `
    <div class="stack stats-grid">
      <div class="tiles">
        ${tile('支出', calc.money(expense), 'is-expense', changeSub(expense, previous.expense))}
        ${tile('收入', calc.money(income), 'is-income', changeSub(income, previous.income))}
        ${tile('淨額', calc.signedMoney(net), net < 0 ? 'is-expense' : 'is-income')}
      </div>
      ${billingCard(items)}
      ${budgetCard(items, month, people)}

      <div class="card">
        <div class="budget-head"><span class="budget-title">每日支出</span>
          <span class="budget-num">最高 ${calc.money(peak)}</span></div>
        <div class="chart-plot">
          <div class="bars" role="img" aria-label="${calc.monthLabel(month)}每日支出，最高 ${calc.money(peak)} 元">${bars}</div>
          <div class="chart-ticks" aria-hidden="true">
            <span>${calc.money(peak)}</span><span>${calc.money(Math.round(peak / 2))}</span><span>0</span>
          </div>
          ${axis}
        </div>
        <div class="chart-legend">${legend}</div>
      </div>

      <div class="card">
        <div class="budget-head">
          <span class="budget-title">分類佔比</span>
          <span class="seg" style="display:inline-grid;grid-template-columns:1fr 1fr;gap:4px;margin:0">
            <button type="button" class="seg-btn ${categoryType === 'expense' ? 'is-on' : ''}" aria-pressed="${categoryType === 'expense'}" data-type="expense" data-cat-switch>支出</button>
            <button type="button" class="seg-btn ${categoryType === 'income' ? 'is-on' : ''}" aria-pressed="${categoryType === 'income'}" data-type="income" data-cat-switch>收入</button>
          </span>
        </div>
        ${cats.length ? cats.map((c) => `
          <div class="cat">
            <span class="cat-name">${esc(c.name)}</span>
            <span class="cat-pct">${Math.round((c.total / catTotal) * 100)}%</span>
            <span class="cat-amount">${calc.money(c.total)}</span>
            <span class="cat-bar"><span style="width:${Math.round((c.total / catTotal) * 100)}%"></span></span>
          </div>`).join('') : `<p class="empty">這個月還沒有紀錄</p>`}
      </div>

    </div>`;
}

/* ---------- 明細 ---------- */

const SORTS = [['date', '日期', '新到舊', '舊到新'], ['amount', '金額', '大到小', '小到大']];

export function recordsView(items, filters, people = [], scope = '') {
  // 舊紀錄保留原記帳人，即使名單刪除或改名也不能從篩選消失。
  const filterPeople = [...new Set([...people, ...items.map((it) => it.by || ''), filters.by || ''].filter(Boolean))];
  const sortButtons = SORTS.map(([key, label, desc, asc]) => {
    const on = (filters.sort || 'date') === key, up = filters.dir === 'asc';
    return `<button type="button" class="seg-btn ${on ? 'is-on' : ''}" data-sort="${key}" aria-pressed="${on}" title="${on ? `${up ? asc : desc}，再按一次反轉` : desc}">${label}${on ? (up ? ' ↑' : ' ↓') : ''}</button>`;
  }).join('');
  return `
    <div class="stack records-section">
      <div class="record-filters">
        <input id="record-query" class="search-field" type="search" data-filter="query" aria-label="搜尋紀錄" placeholder="搜尋全部時段：內容、分類、日期、金額" value="${esc(filters.query || '')}" autocomplete="off"/>
        <select data-filter="type" data-choices="auto" aria-label="收支"><option value="">全部</option><option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${filters.type === 'income' ? 'selected' : ''}>收入</option></select>
        <select data-filter="by" data-choices="auto" aria-label="記帳人"><option value="">所有人</option>${filterPeople.map((by) => `<option value="${esc(by)}" ${filters.by === by ? 'selected' : ''}>${esc(by)}</option>`).join('')}</select>
      </div>
      ${filters.category ? `<p class="filter-chip">分類：${esc(filters.category)} <button type="button" class="text-button" id="record-clear-category" aria-label="取消分類篩選">✕</button></p>` : ''}
      <div class="record-sort"><div class="seg" role="group" aria-label="排序">${sortButtons}</div><button type="button" id="record-clear" class="text-button" title="清除搜尋與篩選">清除</button></div>
      <div id="record-results">${records(items, filters, people, scope)}</div>
    </div>`;
}

/* ---------- 行事曆：記事 ---------- */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function noteRow(it, today, count = 1) {
  const diff = calc.daysBetween(today, it.date);
  return `
    <li><button type="button" class="row" data-note-id="${esc(it.id)}" aria-label="編輯記事 ${esc(it.date)} ${esc(it.note)}">
      <span class="row-main">
        <span class="row-title">${esc(it.note)}</span>
        <span class="row-meta">${esc(it.date)}${it.by ? ` · ${esc(it.by)}` : ''}${count > 1 ? ` · 共 ${count} 次` : ''}</span>
      </span>
      <span class="note-days${diff > 0 ? ' is-future' : diff === 0 ? ' is-today' : ''}">${calc.daysLabel(it.date, today)}</span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </button></li>`;
}

/** 月曆標出有記事的日子；下面列即將到來（還剩幾天）與已過（距今幾天，同名只列最近一次）。點日子只看那天。 */
export function calendar(month, notes, selected = '') {
  const today = calc.todayKey();
  const byDate = new Map();
  for (const it of notes) byDate.set(it.date, [...(byDate.get(it.date) || []), it]);
  const [y, m] = month.split('-').map(Number);
  const cells = Array.from({ length: new Date(y, m - 1, 1).getDay() }, () => '<span></span>');
  for (let d = 1; d <= calc.dayCount(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const list = byDate.get(date) || [];
    const cls = `${date === today ? ' is-today' : ''}${date === selected ? ' is-on' : ''}${list.length ? ' has-note' : ''}`;
    cells.push(`<button type="button" class="cal-day${cls}" data-date="${date}" aria-pressed="${date === selected}" aria-label="${m} 月 ${d} 日${list.length ? `，${list.length} 則記事` : ''}"${list.length ? ` title="${esc(list.map((it) => it.note).join('、'))}"` : ''}>${d}</button>`);
  }

  const section = (title, rows) => rows.length ? `<p class="section-title">${title}</p><ul class="list">${rows.join('')}</ul>` : '';
  let body;
  if (selected) {
    const list = calc.byDateDesc(byDate.get(selected) || []);
    body = list.length ? `<ul class="list">${list.map((it) => noteRow(it, today)).join('')}</ul>` : '<p class="empty">這天沒有記事</p>';
  } else {
    const upcoming = notes.filter((it) => it.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const latest = new Map();
    for (const it of calc.byDateDesc(notes.filter((it) => it.date < today))) {
      const key = it.note.trim();
      const seen = latest.get(key);
      if (seen) seen.count++;
      else latest.set(key, { it, count: 1 });
    }
    body = section('即將到來', upcoming.map((it) => noteRow(it, today))) +
      section('已過', [...latest.values()].map(({ it, count }) => noteRow(it, today, count))) ||
      '<p class="empty">還沒有記事</p>';
  }

  return `
    <div class="stack">
      <div class="card">
        <div class="cal-grid cal-week" aria-hidden="true">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="cal-grid" role="group" aria-label="${calc.monthLabel(month)}">${cells.join('')}</div>
      </div>
      <div class="cal-head">
        ${selected ? `<p class="filter-chip">${calc.dateLabel(selected)} <button type="button" class="text-button" id="cal-clear" aria-label="看全部記事">✕</button></p>` : '<span></span>'}
        <button type="button" class="btn-quiet" id="cal-add" title="${selected ? '在這天記一則' : '記一則，例如換濾心'}">＋ 記事</button>
      </div>
      ${body}
    </div>`;
}

/** scope 有值時（例如「全部時段」）表示搜尋範圍不是本月，摘要前面標出來。 */
export function records(items, filters, people = [], scope = '') {
  const colors = new Map(colorPeople(items, people).map((p, i) => [p, personColor(i)]));
  const found = calc.sortItems(calc.filterItems(items, filters), filters);
  const totals = calc.summarize(found);
  return `<p class="results-summary" role="status">${scope ? `${esc(scope)} · ` : ''}${found.length} / ${items.length} 筆 · 支出 ${calc.money(totals.expense)} · 收入 ${calc.money(totals.income)}</p>${found.length ? recordList(found, colors) : `<p class="empty">${items.length ? '沒有符合的紀錄' : '這個月還沒有紀錄'}</p>`}`;
}

/* ---------- 設定 ---------- */

export function settings(ctx) {
  const { people, members = people, expenseCats, incomeCats, month, me, theme, budgets = {} } = ctx;
  const totalLimit = members.reduce((sum, person) => sum + budgetFor(person, month), 0);
  const catTags = (list, kind) => list
    .map((c) => `<span class="tag">${esc(c)}<button type="button" data-del-cat="${kind}" data-category="${esc(c)}" aria-label="刪除 ${esc(c)}">×</button></span>`)
    .join('');

  return `
    <div class="stack">
      <div class="card">
        <div class="setting-row">
          <div class="setting-name" title="記帳時預設選這個人">這支手機是</div>
          <select id="set-me" data-choices="auto" aria-label="這支手機的預設記帳人" style="max-width:150px">${members.map((p) => `<option ${p === me ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        </div>
        <div class="setting-row">
          <div class="setting-name">外觀</div>
          <select id="set-theme" data-choices="auto" aria-label="外觀" style="max-width:150px">
            <option value="auto" ${theme === 'auto' ? 'selected' : ''}>跟隨系統</option>
            <option value="light" ${theme === 'light' ? 'selected' : ''}>亮色</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="budget-head"><span class="budget-title">${calc.monthLabel(month)}支出額度</span>
          <span class="budget-num">${totalLimit ? `合計 ${calc.money(totalLimit)} 元` : '未設定'}</span></div>
        ${people.map((person, index) => {
          // 土銀是水電氣的年度預算，其他人是每月額度。
          const yearly = person === UTILITY_PAYER;
          const period = yearly ? month.slice(0, 4) : month;
          const limit = yearly ? utilityBudget({ budgets }, period) : budgetFor(person, month);
          return `
          <div class="budget-input">
            <span class="budget-who">${personLabel(person, index)}${yearly ? ` <small>${period}</small>` : ''}</span>
            <input id="set-budget-${index}" type="number" inputmode="numeric" placeholder="${limit ? calc.money(limit) : '未設定'}" title="${yearly ? `${period} 年水電氣預算，填 0 取消` : '填 0 取消上限；沒設定的月份沿用預設'}"
                   value="${esc(budgets[person]?.[period] ?? '')}" aria-label="${esc(person)}${yearly ? `${period} 年度預算` : '本月支出額度'}" min="0" step="1"/>
            <button type="button" class="btn-quiet" data-budget-person="${esc(person)}" data-budget-index="${index}" data-budget-period="${period}">套用</button>
          </div>`;
        }).join('')}
      </div>

      <div class="card">
        <div class="budget-title">記帳人</div>
        <div class="tag-list" id="people-list">${people.map((p) => p === UTILITY_PAYER
          ? `<span class="tag tag-fixed" title="水電氣扣款帳戶，不能改名">${esc(p)}</span>`
          : `<span class="tag"><button type="button" class="tag-edit" data-rename-person="${esc(p)}" aria-label="把 ${esc(p)} 改名" title="點名字改名，所有月份的紀錄一起改">${esc(p)} <span aria-hidden="true">✎</span></button></span>`).join('')}</div>
      </div>

      <div class="card">
        <details id="cats-expense-card"><summary class="budget-title">支出分類 <span class="budget-num">${expenseCats.length}</span></summary>
        <div class="tag-list" id="cats-expense">${catTags(expenseCats, 'expense')}</div></details>
        <div class="add-cat-row">
          <input id="new-cat-expense" type="text" placeholder="新增支出分類" enterkeyhint="done"/>
          <select id="new-cat-group" data-choices="auto" aria-label="歸在哪個大項" title="房、女兒、兒子從月消費總額分列；日常歸在扣除列項後開銷；水電氣另計">${GROUPS.map((g) => `<option>${g}</option>`).join('')}</select>
          <button type="button" class="btn-quiet" data-add-cat="expense">新增</button>
        </div>
      </div>

      <div class="card">
        <details id="cats-income-card"><summary class="budget-title">收入分類 <span class="budget-num">${incomeCats.length}</span></summary>
        <div class="tag-list" id="cats-income">${catTags(incomeCats, 'income')}</div></details>
        <div class="date-row" style="margin-top:8px">
          <input id="new-cat-income" type="text" placeholder="新增收入分類" enterkeyhint="done"/>
          <button type="button" class="btn-quiet" data-add-cat="income">新增</button>
        </div>
      </div>

      <div class="setting-actions">
        <button type="button" class="btn-quiet" id="set-export" title="匯出${calc.monthLabel(month)}全部紀錄，可用 Excel 開啟">匯出 CSV</button>
      </div>
    </div>`;
}
