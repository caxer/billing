// 看板、統計與設定的畫面組裝。全部輸出 HTML 字串，事件在 app.js 綁。

import * as calc from './calc.js';
import { budgetFor, all as allSettings } from './settings.js';
import { transactionSummary, memberSpend, UTILITY_PAYER, utilityBudget, DAILY_ORDER, BILLING_CATEGORIES } from './billing.js';
import { esc } from './html.js';

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
    spent: memberSpend(items, person),
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

/* ---------- 月結減法：本月支出與年度月表共用 ---------- */

const LEDGER = [['', '月消費總額', 'monthlyTotal', '房、女兒、兒子與日常，不含水電氣'], ['−', '房', 'house'], ['−', '女兒', 'daughter'], ['−', '兒子', 'son'],
  ['=', '日常', 'daily', '扣除列項後開銷'], ['', '水電氣', 'utilities', '土銀扣款，另計']];

/** 月消費總額減房、女兒、兒子等於日常，水電氣另列；format 讓年度的缺資料顯示「—」。 */
export const ledger = (summary, format = calc.money) => `<div class="ledger">${LEDGER.map(([op, name, key, tip]) =>
  `<div class="ledger-row${op === '=' ? ' is-result' : ''}${key === 'utilities' ? ' is-apart' : ''}"${tip ? ` title="${tip}"` : ''}><span class="ledger-op">${op}</span><span>${name}</span><b>${format(summary[key])}</b></div>`).join('')}</div>`;

/** 支出格：左邊總額（本月在下面接收入），右邊月結減法。 */
export const expenseTile = (label, value, sub, summary, format, below = '') => `
  <div class="tile tile-ledger">
    <div class="tile-main">
      <div class="tile-label">${esc(label)}</div>
      <div class="tile-value is-expense">${esc(value)}</div>
      ${sub ? `<div class="tile-sub ${sub.cls || ''}">${esc(sub.text)}</div>` : ''}${below}
    </div>${ledger(summary, format)}
  </div>`;

const incomeLine = (income, sub) => `<div class="tile-income"><span class="tile-label">收入</span><b class="is-income">${calc.money(income)}</b>${sub ? `<span class="tile-sub ${sub.cls || ''}">${esc(sub.text)}</span>` : ''}</div>`;

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
  // 支出、收入與年度頁同一套規則（transactionSummary）：轉帳不算收入，公積金名下收入抵扣日常。
  const mappings = allSettings()?.billingGroups;
  const summary = transactionSummary(items, mappings);
  const { total: expense, income } = summary;
  const previous = transactionSummary(prevItems, mappings);
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
      <div class="tiles stats-tiles">
        ${expenseTile('支出', calc.money(expense), changeSub(expense, previous.total), summary, calc.money, incomeLine(income, changeSub(income, previous.income)))}
      </div>
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

const SORTS = [['date', '日期', '新到舊', '舊到新'], ['amount', '金額', '大到小', '小到大'], ['name', '名稱', '依名稱排列', '名稱反向'], ['category', '分類', '依食衣住行育樂醫其他、房、女兒、兒子、水電氣', '分類反向']];
/** 分類排序：日常依食衣住行育樂醫其他，再接房、女兒、兒子、水電氣的項目。 */
const CATEGORY_ORDER = [...DAILY_ORDER, ...BILLING_CATEGORIES];

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
        <select data-filter="by" data-choices="auto" aria-label="記帳人"><option value="">所有人</option>${filterPeople.map((by) => `<option value="${esc(by)}" ${filters.by === by ? 'selected' : ''}>${esc(by)}</option>`).join('')}</select>
      </div>
      ${filters.category ? `<p class="filter-chip">分類：${esc(filters.category)} <button type="button" class="text-button" id="record-clear-category" aria-label="取消分類篩選">✕</button></p>` : ''}
      <div class="record-sort"><div class="seg" role="group" aria-label="排序">${sortButtons}</div></div>
      <div id="record-results">${records(items, filters, people, scope)}</div>
    </div>`;
}

/** 記帳頁下方：這個月最近新增的幾筆，點一下編輯。顏色與明細相同。 */
export function recentView(items, people = [], limit = 4) {
  // 新紀錄接在月檔最後；同一時間建立的，後面的較新。
  const recent = [...items].reverse().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  if (!recent.length) return '';
  const colors = new Map(colorPeople(items, people).map((p, i) => [p, personColor(i)]));
  return `<h2 class="section-title" title="這個月最後記的 ${limit} 筆，點一下修改">最近新增</h2>${recordList(recent, colors)}`;
}

/* ---------- 行事曆：記事 ---------- */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 重複的記事傳進來的 date 是那一次的日期，meta 標出每週／每月。 */
function noteRow(it, today, count = 1) {
  const diff = calc.daysBetween(today, it.date);
  const repeat = calc.REPEATS[it.repeat];
  return `
    <li><button type="button" class="row" data-note-id="${esc(it.id)}" aria-label="編輯記事 ${esc(it.date)} ${esc(it.note)}">
      <span class="row-main">
        <span class="row-title">${esc(it.note)}</span>
        <span class="row-meta">${esc(it.date)}${repeat ? ` · ${repeat}` : ''}${it.by ? ` · ${esc(it.by)}` : ''}${count > 1 ? ` · 共 ${count} 次` : ''}</span>
      </span>
      <span class="note-days${diff > 0 ? ' is-future' : diff === 0 ? ' is-today' : ''}">${calc.daysLabel(it.date, today)}</span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </button></li>`;
}

/**
 * 月曆標出有記事的日子（重複的記事每一次都標）；下面列即將到來（還剩幾天）與已過（距今幾天，同名只列最近一次）。
 * 重複的記事只在即將到來列下一次。點日子只看那天。
 */
export function calendar(month, notes, selected = '') {
  const today = calc.todayKey();
  const byDate = new Map();
  for (const it of notes) {
    for (const date of calc.noteDates(it, `${month}-01`, `${month}-${String(calc.dayCount(month)).padStart(2, '0')}`)) byDate.set(date, [...(byDate.get(date) || []), { ...it, date }]);
  }
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
    const upcoming = notes.map((it) => ({ ...it, date: calc.nextNoteDate(it, today) })).filter((it) => it.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = new Map();
    for (const it of calc.byDateDesc(notes.filter((it) => it.date < today && !calc.REPEATS[it.repeat]))) {
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
  const found = calc.sortItems(calc.filterItems(items, filters), { ...filters, categoryOrder: CATEGORY_ORDER });
  const totals = transactionSummary(found, allSettings()?.billingGroups);
  return `<p class="results-summary" role="status">${scope ? `${esc(scope)} · ` : ''}${found.length} / ${items.length} 筆 · 支出 ${calc.money(totals.total)} · 收入 ${calc.money(totals.income)}</p>${found.length ? recordList(found, colors) : `<p class="empty">${items.length ? '沒有符合的紀錄' : '這個月還沒有紀錄'}</p>`}`;
}

/* ---------- 設定 ---------- */

export function settings(ctx) {
  const { people, members = people, month, me, theme, budgets = {} } = ctx;
  const totalLimit = members.reduce((sum, person) => sum + budgetFor(person, month), 0);
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
            <span class="budget-who">${yearly ? `<span title="水電氣扣款帳戶，不能改名">${personLabel(person, index)}</span> <small>${period}</small>`
              : `<button type="button" class="tag-edit" data-rename-person="${esc(person)}" aria-label="把 ${esc(person)} 改名" title="點名字改名，所有月份的紀錄一起改">${personLabel(person, index)} <span aria-hidden="true">✎</span></button>`}</span>
            <input id="set-budget-${index}" type="number" inputmode="numeric" placeholder="${limit ? calc.money(limit) : '未設定'}" title="${yearly ? `${period} 年水電氣預算，填 0 取消` : '填 0 取消上限；沒設定的月份沿用預設'}"
                   value="${esc(budgets[person]?.[period] ?? '')}" aria-label="${esc(person)}${yearly ? `${period} 年度預算` : '本月支出額度'}" min="0" step="1"/>
            <button type="button" class="btn-quiet" data-budget-person="${esc(person)}" data-budget-index="${index}" data-budget-period="${period}">套用</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}
