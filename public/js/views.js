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

function recordRow(it) {
  const cls = it.type === 'income' ? 'is-income' : 'is-expense';
  const sign = it.type === 'income' ? '+' : '−';
  return `
    <li><button type="button" class="row" data-id="${esc(it.id)}" aria-label="編輯 ${esc(it.date)} ${esc(it.note || it.category)} ${calc.money(it.amount)} 元">
      <span class="row-main">
        <span class="row-title">${esc(it.note || it.category || '未填內容')}</span>
        <span class="row-meta">${esc(it.date)} · ${esc(it.category)}${it.by ? ` · ${esc(it.by)}` : ''}</span>
      </span>
      <span class="row-amount ${cls}">${sign}${calc.money(it.amount)}</span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </button></li>`;
}

const recordList = (items, limit) => {
  const list = calc.byDateDesc(items).slice(0, limit ?? items.length);
  if (!list.length) return `<p class="empty">這個月還沒有紀錄</p>`;
  return `<ul class="list">${list.map(recordRow).join('')}</ul>`;
};

/* ---------- 看板 ---------- */

function billingCard(items) {
  const summary = transactionSummary(items, allSettings()?.billingGroups);
  return `<div class="card billing-month-card"><div class="section-head"><h2 class="section-title">本月月結</h2><button class="text-button" type="button" data-go="billing">年度 →</button></div>
    <div class="billing-mini-grid">${[['月消費總額', summary.monthlyTotal, '含房與子女'], ['扣除列項後開銷', summary.daily, '日常'], ['水電氣', summary.utilities, '另計'], ['家庭總支出', summary.total, '月消費總額＋水電氣']].map(([name, total, tip]) =>
      `<div title="${tip}"><span class="setting-hint">${name}</span><strong>${calc.money(total)}</strong></div>`).join('')}</div>
    <div class="billing-parts">${[['房', summary.house], ['女兒', summary.daughter], ['兒子', summary.son]].map(([name, total]) => `<span>${name} <b>${calc.money(total)}</b></span>`).join('')}</div></div>`;
}

export function dashboard(month, items, prevItems, people) {
  const { expense, income, net } = calc.summarize(items);
  const today = calc.todayKey();
  const todayExpense = calc.summarize(items.filter((it) => it.date === today && it.type === 'expense')).expense;
  const previous = calc.summarize(prevItems);

  return `
    <div class="stack dashboard-grid">
      <div class="tiles">
        ${tile('本月支出', calc.money(expense), 'is-expense', changeSub(expense, previous.expense))}
        ${tile('本月收入', calc.money(income), 'is-income', changeSub(income, previous.income))}
        ${tile('淨額', calc.signedMoney(net), net < 0 ? 'is-expense' : 'is-income')}
      </div>
      <div class="card today-card">
        <span class="setting-name">今日支出</span>
        <span class="row-amount is-expense">${calc.money(todayExpense)}</span>
        <button type="button" class="btn-primary" data-go="add">＋ 記一筆</button>
      </div>
      ${billingCard(items)}
      ${budgetCard(items, month, people)}
      <div class="records-section"><div class="section-head"><h2 class="section-title">最近紀錄</h2><button type="button" class="text-button" data-go="stats">全部 →</button></div>
      ${recordList(items, 5)}</div>
    </div>`;
}

/* ---------- 統計 ---------- */

/** 單一色塊：高度是整條柱子的百分比，所以要除以柱子的總高。 */
const stackSeg = (bucket, person, index, stackTotal) => {
  const amount = bucket.parts.get(person) || 0;
  if (!amount || !stackTotal) return '';
  return `<div class="bars-seg" style="height:${(amount / stackTotal) * 100}%;background-color:${personColor(index)}"></div>`;
};

export function stats(month, items, prevItems, categoryType, filters = {}, people = []) {
  // 舊紀錄保留原記帳人，即使名單刪除或改名也不能從圖表與篩選消失。
  const recordPeople = [...new Set([...people, ...items.map((it) => it.by || '')])];
  const filterPeople = [...new Set([...recordPeople.filter(Boolean), ...(filters.by ? [filters.by] : [])])];
  const { expense, income, net } = calc.summarize(items);
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
  const legend = recordPeople.map((p, i) => `<span class="legend-item"><i class="dot" style="background:${personColor(i)}" aria-hidden="true"></i>${esc(p || '未指定')}</span>`).join('');

  const cats = calc.byCategory(items, categoryType);
  const catTotal = cats.reduce((a, c) => a + c.total, 0);

  return `
    <div class="stack stats-grid">
      <div class="tiles">
        ${tile('支出', calc.money(expense), 'is-expense', changeSub(expense, calc.summarize(prevItems).expense))}
        ${tile('收入', calc.money(income), 'is-income')}
        ${tile('淨額', calc.signedMoney(net), net < 0 ? 'is-expense' : 'is-income')}
      </div>

      <div class="card">
        <div class="budget-head"><span class="budget-title">每日支出</span>
          <span class="budget-num">最高 ${calc.money(peak)}</span></div>
        <div class="chart-plot">
          <div class="bars" role="img" aria-label="${calc.monthLabel(month)}每日支出，最高 ${calc.money(peak)} 元">${bars}</div>
          <div class="chart-ticks" aria-hidden="true">
            <span>${calc.money(peak)}</span><span>${calc.money(Math.round(peak / 2))}</span><span>0</span>
          </div>
        </div>
        <div class="chart-axis"><span>1 日</span><span>${calc.dayCount(month)} 日</span></div>
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

      <div class="records-section">
        <div class="section-head"><h2 class="section-title">全部紀錄</h2><button type="button" id="record-clear" class="text-button">清除</button></div>
        <div class="record-filters">
          <input id="record-query" class="search-field" type="search" data-filter="query" aria-label="搜尋紀錄" placeholder="搜尋內容、分類、日期、金額" value="${esc(filters.query || '')}" autocomplete="off"/>
          <select data-filter="type" aria-label="收支"><option value="">全部收支</option><option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${filters.type === 'income' ? 'selected' : ''}>收入</option></select>
          <select data-filter="by" aria-label="記帳人"><option value="">所有人</option>${filterPeople.map((by) => `<option value="${esc(by)}" ${filters.by === by ? 'selected' : ''}>${esc(by)}</option>`).join('')}</select>
        </div>
        <div id="record-results">${records(items, filters)}</div>
      </div>
    </div>`;
}

export function records(items, filters) {
  const found = calc.filterItems(items, filters);
  const totals = calc.summarize(found);
  return `<p class="results-summary" role="status">${found.length} / ${items.length} 筆 · 支出 ${calc.money(totals.expense)} · 收入 ${calc.money(totals.income)}</p>${found.length ? recordList(found) : `<p class="empty">${items.length ? '沒有符合的紀錄' : '這個月還沒有紀錄'}</p>`}`;
}

/* ---------- 設定 ---------- */

export function settings(ctx) {
  const { people, members = people, expenseCats, incomeCats, month, me, theme, budgets = {}, isLocal } = ctx;
  const totalLimit = members.reduce((sum, person) => sum + budgetFor(person, month), 0);
  const catTags = (list, kind) => list
    .map((c) => `<span class="tag">${esc(c)}<button type="button" data-del-cat="${kind}" data-category="${esc(c)}" aria-label="刪除 ${esc(c)}">×</button></span>`)
    .join('');

  return `
    <div class="stack">
      <div class="card">
        <div class="setting-row">
          <div class="setting-name" title="記帳時預設選這個人">這支手機是</div>
          <select id="set-me" aria-label="這支手機的預設記帳人" style="max-width:150px">${members.map((p) => `<option ${p === me ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        </div>
        <div class="setting-row">
          <div class="setting-name">外觀</div>
          <select id="set-theme" aria-label="外觀" style="max-width:150px">
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
        <div class="tag-list" id="people-list">${people.map((p, i) => `
          <span class="tag">
            <button type="button" class="tag-edit" data-rename-person="${esc(p)}" aria-label="把 ${esc(p)} 改名" title="點名字改名，本月紀錄一起改">${esc(p)}</button>
            <button type="button" data-del-person="${esc(p)}" aria-label="刪除 ${esc(p)}">×</button>
          </span>`).join('')}</div>
      </div>

      <div class="card">
        <details id="cats-expense-card"><summary class="budget-title">支出分類 <span class="budget-num">${expenseCats.length}</span></summary>
        <div class="tag-list" id="cats-expense">${catTags(expenseCats, 'expense')}</div></details>
        <div class="add-cat-row">
          <input id="new-cat-expense" type="text" placeholder="新增支出分類" enterkeyhint="done"/>
          <select id="new-cat-group" aria-label="歸在哪個大項" title="房、女兒、兒子從月消費總額分列；日常歸在扣除列項後開銷；水電氣另計">${GROUPS.map((g) => `<option>${g}</option>`).join('')}</select>
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
        <button type="button" class="btn-quiet danger-button" id="set-clear" title="刪掉${calc.monthLabel(month)}全部紀錄，無法復原">清空本月</button>
        ${!isLocal ? `<button type="button" class="btn-quiet" id="set-lock" title="這台裝置下次需要重新點專屬連結">登出此裝置</button>` : ''}
      </div>
    </div>`;
}
