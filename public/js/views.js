// 看板、統計與設定的畫面組裝。全部輸出 HTML 字串，事件在 app.js 綁。

import * as calc from './calc.js';
import { budgetFor, all as allSettings } from './settings.js';
import { transactionSummary, GROUPS } from './billing.js';
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
      <p class="budget-note">還沒設定這個人的額度</p>
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
  }));
  if (!rows.some((row) => row.limit)) {
    return `<div class="card"><div class="budget-title">本月額度</div>
      <p class="budget-note">還沒設定每月支出上限，去「設定」填一個就能看進度。</p></div>`;
  }
  return `<div class="card">
    <div class="budget-head"><span class="budget-title">本月支出額度</span></div>
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
  return `<div class="card billing-month-card"><div class="section-head"><h2 class="section-title">本月自動月結</h2><button class="text-button" type="button" data-go="billing">年度月表 →</button></div>
    <div class="billing-mini-grid">${[['月消費總額', summary.monthlyTotal], ['扣除列項後開銷', summary.daily], ['水電氣', summary.utilities], ['家庭總支出', summary.total]].map(([name, total]) =>
      `<div><span class="setting-hint">${name}</span><strong>${calc.money(total)}</strong></div>`).join('')}</div>
    <div class="billing-parts">${[['房', summary.house], ['女兒', summary.daughter], ['兒子', summary.son]].map(([name, total]) => `<span>${name} <b>${calc.money(total)}</b></span>`).join('')}</div>
    <p class="setting-hint">依本月記帳交易計算。月消費含房與子女；水電氣另計。歷史月結請看年度月表。</p></div>`;
}

export function dashboard(month, items, prevItems, people) {
  const { expense, income, net } = calc.summarize(items);
  const today = calc.todayKey();
  const todayExpense = calc.summarize(items.filter((it) => it.date === today && it.type === 'expense')).expense;
  const previous = calc.summarize(prevItems);

  return `
    <div class="stack dashboard-grid">
      <div class="welcome"><div><p class="eyebrow">帳本紀錄</p><h2>一起掌握每一筆日常</h2><p class="setting-hint">${calc.monthLabel(month)} · ${items.length} 筆紀錄</p></div><button type="button" class="btn-primary" data-go="add">＋ 記一筆</button></div>
      <div class="tiles">
        ${tile('本月支出', calc.money(expense), 'is-expense', changeSub(expense, previous.expense))}
        ${tile('本月收入', calc.money(income), 'is-income', changeSub(income, previous.income))}
        ${tile('淨額', calc.signedMoney(net), net < 0 ? 'is-expense' : 'is-income')}
      </div>
      ${billingCard(items)}
      ${budgetCard(items, month, people)}
      <div class="card">
        <div class="setting-row">
          <span class="setting-name">今日支出</span>
          <span class="row-amount is-expense">${calc.money(todayExpense)}</span>
        </div>
      </div>
      <div class="records-section"><div class="section-head"><h2 class="section-title">最近紀錄</h2><button type="button" class="text-button" data-go="stats">查看全部 →</button></div>
      ${recordList(items, 5)}
      ${!items.length ? '<button type="button" class="btn-quiet btn-block" data-go="add">記下第一筆</button>' : ''}</div>
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
      return `<div class="bars-col ${d.day === todayDay && isThisMonth ? 'is-today' : ''}" title="${d.date}：${tip || '0 元'}"><div class="bars-stack" style="height:${Math.round((d.total / maxDay) * 100)}%">${segs}</div></div>`;
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

      ${billingCard(items)}

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
        <div class="section-head"><h2 class="section-title">全部紀錄</h2><button type="button" id="record-clear" class="text-button">清除篩選</button></div>
        <div class="record-filters card">
          <label class="field search-field"><span class="field-label">搜尋紀錄</span><input id="record-query" type="search" data-filter="query" placeholder="內容、分類、日期或金額" value="${esc(filters.query || '')}" autocomplete="off"/></label>
          <label class="field"><span class="field-label">收支</span><select data-filter="type"><option value="">全部收支</option><option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${filters.type === 'income' ? 'selected' : ''}>收入</option></select></label>
          <label class="field"><span class="field-label">記帳人</span><select data-filter="by"><option value="">所有人</option>${filterPeople.map((by) => `<option value="${esc(by)}" ${filters.by === by ? 'selected' : ''}>${esc(by)}</option>`).join('')}</select></label>
        </div>
        <div id="record-results">${records(items, filters)}</div>
      </div>
    </div>`;
}

export function records(items, filters) {
  const found = calc.filterItems(items, filters);
  const totals = calc.summarize(found);
  return `<p class="results-summary" role="status">找到 ${found.length} / ${items.length} 筆 · 支出 ${calc.money(totals.expense)} · 收入 ${calc.money(totals.income)}</p>${found.length ? recordList(found) : `<p class="empty">${items.length ? '找不到符合條件的紀錄，試試其他關鍵字或清除篩選。' : '這個月還沒有紀錄'}</p>`}`;
}

/* ---------- 設定 ---------- */

export function settings(ctx) {
  const { people, expenseCats, incomeCats, month, me, theme, budgets = {}, isLocal, biometric = {} } = ctx;
  const totalLimit = people.reduce((sum, person) => sum + budgetFor(person, month), 0);
  const catTags = (list, kind) => list
    .map((c) => `<span class="tag">${esc(c)}<button type="button" data-del-cat="${kind}" data-category="${esc(c)}" aria-label="刪除 ${esc(c)}">×</button></span>`)
    .join('');

  return `
    <div class="stack">
      <div class="card">
        <div class="setting-row">
          <div>
            <div class="setting-name">這支手機是</div>
            <p class="setting-hint">記帳時預設選這個人</p>
          </div>
          <select id="set-me" aria-label="這支手機的預設記帳人" style="max-width:150px">${people.map((p) => `<option ${p === me ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-name">外觀</div>
            <p class="setting-hint">跟著系統或手動指定</p>
          </div>
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
          const limit = budgetFor(person, month);
          return `
          <p class="setting-hint" style="margin:12px 0 0">${personLabel(person, index)} · ${limit ? `${calc.money(limit)} 元` : '未設定'}</p>
          <div class="date-row" style="margin-top:6px">
            <input id="set-budget-${index}" type="number" inputmode="numeric" placeholder="例如 20000"
                   value="${esc(budgets[person]?.[month] ?? '')}" aria-label="${esc(person)}本月支出額度" min="0" step="1"/>
            <button type="button" class="btn-quiet" data-budget-person="${esc(person)}" data-budget-index="${index}">套用</button>
          </div>`;
        }).join('')}
        <p class="setting-hint">每個人分別計算。填 0 代表取消上限；沒單獨設定這個月的人會沿用自己的預設值。</p>
      </div>

      <div class="card">
        <div class="budget-title">記帳人</div>
        <div class="tag-list" id="people-list">${people.map((p, i) => `
          <span class="tag">
            <button type="button" class="tag-edit" data-rename-person="${esc(p)}" aria-label="把 ${esc(p)} 改名">${esc(p)}</button>
            <button type="button" data-del-person="${esc(p)}" aria-label="刪除 ${esc(p)}">×</button>
          </span>`).join('')}</div>
        <p class="setting-hint">點名字可以改名，會連本月紀錄一起改。其他月份的紀錄仍是舊名字，不會跟著改。</p>
      </div>

      <div class="card">
        <div class="budget-title">支出分類</div>
        <div class="tag-list" id="cats-expense">${catTags(expenseCats, 'expense')}</div>
        <div class="date-row" style="margin-top:10px">
          <input id="new-cat-expense" type="text" placeholder="新增支出分類" enterkeyhint="done"/>
          <button type="button" class="btn-quiet" data-add-cat="expense">新增</button>
        </div>
        <label class="field" style="margin-top:10px"><span class="field-label">新分類歸在哪個大項？</span><select id="new-cat-group">${GROUPS.map((g) => `<option>${g}</option>`).join('')}</select></label>
        <p class="setting-hint">房、女兒、兒子會從月消費總額分列；日常歸在扣除列項後開銷，水電氣另計。</p>
      </div>

      <div class="card">
        <div class="budget-title">收入分類</div>
        <div class="tag-list" id="cats-income">${catTags(incomeCats, 'income')}</div>
        <div class="date-row" style="margin-top:10px">
          <input id="new-cat-income" type="text" placeholder="新增收入分類" enterkeyhint="done"/>
          <button type="button" class="btn-quiet" data-add-cat="income">新增</button>
        </div>
      </div>

      ${!isLocal ? `<div class="card"><h2 class="section-title">Face ID／生物辨識</h2>
        <p class="setting-hint">${biometric.enabled ? '已啟用。重新開啟帳本時，需要裝置驗證或帳本密碼。' : '啟用後用 Face ID、Touch ID 或裝置驗證解鎖；登入資訊會加密保存。'}</p>
        ${biometric.enabled && !biometric.pending ? '<button type="button" class="btn-quiet btn-block" id="set-biometric-disable">停用生物辨識</button>' : `<button type="button" class="btn-quiet btn-block" id="set-biometric-enable"${biometric.available ? '' : ' disabled data-unavailable'}>${biometric.pending ? '完成 Face ID 設定' : '啟用 Face ID／生物辨識'}</button>`}
        <p class="setting-hint">${biometric.enabled ? '停用後恢復記住登入。通行密鑰可另外在系統密碼設定中刪除。' : biometric.available ? '建立通行密鑰時可能需要兩次確認。每台裝置需各自啟用，帳本密碼仍可備援。' : '此裝置或瀏覽器沒有可用的生物辨識。可繼續使用帳本密碼。'}</p>
      </div>` : ''}

      <div class="card">
        <button type="button" class="btn-quiet btn-block" data-go="billing">年度月結與跨年比較</button>
        <p class="setting-hint">直接查看 billing 歷年分類、每月合計與備註。</p>
        <button type="button" class="btn-quiet btn-block" id="set-export">匯出本月 CSV</button>
        <p class="setting-hint" style="margin-top:8px">匯出 ${calc.monthLabel(month)}的全部紀錄，可用 Excel 開啟。</p>
        <button type="button" class="btn-quiet btn-block danger-button" id="set-clear">清空本月紀錄</button>
        <p class="setting-hint" style="margin-top:8px">刪掉 ${calc.monthLabel(month)}的全部紀錄，其他月份不受影響。清空後無法復原。</p>
        ${!isLocal ? `<button type="button" class="btn-quiet btn-block" id="set-lock">鎖定帳本</button><p class="setting-hint" style="margin-top:8px">${biometric.enabled ? '下次需要生物辨識或帳本密碼解鎖。' : '清除這台裝置記住的登入，下次需重新輸入密碼。'}</p>` : ''}
        ${isLocal ? '<p class="setting-hint">目前是本機預覽模式，資料在 local/data/，不會上傳。</p>' : ''}
      </div>
    </div>`;
}
