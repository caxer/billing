// 進入點：解鎖、分頁切換、記帳表單、每月導覽、輪詢同步。

import * as store from './store.js';
import * as state from './state.js';
import * as settings from './settings.js';
import * as calc from './calc.js';
import * as views from './views.js';
import { readStored, writeStored, removeStored } from './storage.js';
import { classify, GROUPS, UTILITY_PAYER } from './billing.js';
import * as reports from './reports.js';
import { initLoginScreen } from './login-screen.js';

const $ = (sel) => document.querySelector(sel);

const ui = {
  lock: $('#lock'),
  app: $('#app'),
  title: $('#view-title'),
  sync: $('#sync-state'),
  monthNav: $('#month-nav'),
  monthLabel: $('#month-label'),
};

const loginScreen = initLoginScreen(ui.lock, { onKey: (key) => unlockAccount(key, true) });

const TITLES = { dashboard: '看板', add: '記帳', stats: '統計', billing: '月結', settings: '設定' };

let view = 'dashboard';
let month = calc.monthKey();
let prevItems = [];
let categoryType = 'expense';
let editingId = null;
let addType = 'expense';
let me = readStored('spa-me') || '';
let theme = readStored('spa-theme') || 'auto';
let working = false;
let dataReady = false;
let unlocking = false;
let stopWatching = () => {};
const filters = { query: '', type: '', by: '' };

/* ---------- 部署更新偵測 ---------- */

// 部署時由 GitHub Actions 寫入 version.json。載入時記下版本，之後定期比對；
// 站台換新版時把狀態列按鈕變成重新整理入口。
const VERSION_EVERY = 60000;
let loadedVersion = null;
let updateReady = false;
let versionTimer = setInterval(checkVersion, VERSION_EVERY);
checkVersion();

function showUpdateReady() {
  if (updateReady) return;
  updateReady = true;
  clearInterval(versionTimer);
  setSync('update', '有更新 · 點此重新整理');
}

async function checkVersion() {
  try {
    // 加時間參數避免吃到 GitHub Pages 的靜態快取。
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const version = (await res.json()).version;
    if (!version) return;
    if (loadedVersion === null) { loadedVersion = version; return; }
    if (version !== loadedVersion) showUpdateReady();
  } catch {
    /* 讀不到版本檔就當作沒有更新 */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkVersion();
});

/** 還沒決定這支手機是誰時問一次；不問的話所有裝置都會落到名單第一個人。 */
function askWho() {
  const box = $('#who');
  const people = settings.members();
  if (!people.length) return Promise.resolve('');
  return new Promise((resolve) => {
    $('#who-choices').replaceChildren(...people.map((person) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'who-choice';
      btn.textContent = person;
      btn.addEventListener('click', () => {
        box.hidden = true;
        resolve(person);
      });
      return btn;
    }));
    box.hidden = false;
    box.querySelector('button')?.focus();
  });
}

/* ---------- 狀態列 ---------- */

// 月資料與年度資料各自保留狀態，背景同步不影響正在使用的分頁。
const syncStatus = { month: { state: 'ok', label: '已同步' }, billing: { state: 'ok', label: '已同步' } };

function renderSync() {
  const status = syncStatus[view === 'billing' ? 'billing' : 'month'];
  ui.sync.dataset.state = updateReady ? 'update' : status.state;
  ui.sync.textContent = updateReady ? '有更新 · 點此重新整理' : status.label;
  ui.sync.disabled = working || (!updateReady && view === 'billing' && status.state === 'busy');
}

function setSync(next, label, scope = view === 'billing' ? 'billing' : 'month') {
  if (next !== 'update') syncStatus[scope] = { state: next, label };
  renderSync();
}

function setWorking(value) {
  working = value;
  ui.app.setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll('.tab, [data-go], [data-cat-switch], #month-nav button, #add-form input, #add-form select, #add-form button, #view-add .seg-btn, #view-settings button, #view-settings input, #view-settings select')) {
    control.disabled = value || control.hasAttribute('data-unavailable');
  }
  renderSync();
}

/* ---------- 提示 ---------- */

let toastTimer;
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

/* ---------- 主題 ---------- */

function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/* ---------- 分頁 ---------- */

function show(next) {
  if (working) return;
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.view === next);
    if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const sec of document.querySelectorAll('.view')) {
    sec.hidden = sec.id !== `view-${next}`;
  }
  ui.title.textContent = next === 'add' && editingId ? '編輯紀錄' : TITLES[next];
  ui.monthNav.hidden = next === 'add' || next === 'billing';
  reports.setActive(next === 'billing');
  renderSync();
  if (next === 'add' && !editingId && !$('#add-amount').value && !$('#add-note').value) resetForm();
  if (next === 'add') refreshFormOptions();
  render();
}

/* ---------- 繪製 ---------- */

function render() {
  if (view === 'dashboard') {
    $('#view-dashboard').innerHTML = views.dashboard(month, state.allItems(), prevItems, settings.people());
  } else if (view === 'stats') {
    const active = document.activeElement;
    const selection = active?.id === 'record-query' ? [active.selectionStart, active.selectionEnd] : null;
    $('#view-stats').innerHTML = views.stats(month, state.allItems(), prevItems, categoryType, filters, settings.people());
    if (selection) {
      const input = $('#record-query');
      input.focus({ preventScroll: true });
      input.setSelectionRange(...selection);
    }
  } else if (view === 'settings') {
    renderSettings();
  }
  ui.monthLabel.textContent =
    month === calc.monthKey() ? `${calc.monthLabel(month)}（本月）` : calc.monthLabel(month);
}

function renderSettings() {
  const all = settings.all();
  if (!all) {
    $('#view-settings').textContent = '設定尚未載入，請按右上角同步重試。';
    return;
  }
  const meValue = me || settings.members()[0];
  // 重畫時保留使用者展開的區塊，刪完一個分類不會又收起來。
  const opened = [...document.querySelectorAll('#view-settings details[open]')].map((el) => el.id);
  $('#view-settings').innerHTML = views.settings({
    people: all.people,
    members: settings.members(),
    expenseCats: all.expenseCategories,
    incomeCats: all.incomeCategories,
    month,
    me: meValue,
    theme,
    budgets: all.budgets || {},
    isLocal: store.isLocal(),
  });
  for (const id of opened) { const el = document.getElementById(id); if (el) el.open = true; }
}

/* ---------- 記帳表單 ---------- */

function fillSelect(select, list, selected) {
  const values = [...new Set([...list, ...(selected ? [selected] : [])])];
  select.replaceChildren(...values.map((value) => new Option(value, value, false, value === selected)));
}

function fillCategories(type, selected) {
  const list = settings.categories(type);
  const select = $('#add-category');
  const previous = select.value;
  const chosen = selected ?? (list.includes(previous) ? previous : list[0]);
  if (type === 'income') fillSelect(select, list, chosen);
  else {
    const values = [...new Set([...list, ...(chosen ? [chosen] : [])])];
    const groups = GROUPS.map((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      for (const value of values.filter((value) => classify(value, settings.all()?.billingGroups) === group)) {
        optgroup.append(new Option(value, value, false, value === chosen));
      }
      return optgroup;
    }).filter((group) => group.children.length);
    select.replaceChildren(...groups);
  }
  updateCategoryHint();
}

/** 分類怎麼計入月結，放在選單的提示裡，不佔版面。 */
function updateCategoryHint() {
  const group = classify($('#add-category').value, settings.all()?.billingGroups);
  $('#add-category').title = addType === 'income' ? '收入另行統計，不扣減月消費總額。' : group === '水電氣'
    ? '土銀扣款，水電氣另計；會計入家庭總支出。' : group === '房'
      ? '公積金支付，會計入房屋分類及月消費總額。' : group === '日常'
        ? '會計入月消費總額及扣除列項後開銷。' : `會計入${group}分類及月消費總額。`;
}

/** 選到水電氣時改記在土銀名下，改回其他分類時還給這支手機的人。 */
function applyUtilityPayer() {
  if (!settings.people().includes(UTILITY_PAYER)) return;
  const by = $('#add-by');
  const utility = addType === 'expense' && classify($('#add-category').value, settings.all()?.billingGroups) === '水電氣';
  if (utility) by.value = UTILITY_PAYER;
  else if (by.value === UTILITY_PAYER && me) by.value = me;
}

function refreshFormOptions() {
  const people = settings.people();
  if (!settings.members().includes(me)) {
    me = settings.members()[0] || '';
    writeStored('spa-me', me);
  }
  const selected = $('#add-by').value;
  fillSelect($('#add-by'), people, editingId || people.includes(selected) ? selected : me);
  fillCategories(addType, editingId ? $('#add-category').value : undefined);
}

function setAddType(type) {
  addType = type;
  for (const btn of document.querySelectorAll('.seg-btn[data-type]')) {
    if (btn.hasAttribute('data-cat-switch')) continue;
    btn.classList.toggle('is-on', btn.dataset.type === type);
    btn.setAttribute('aria-pressed', String(btn.dataset.type === type));
  }
  $('#amount-sign').textContent = type === 'income' ? '+' : '−';
  $('.amount-row').classList.toggle('is-income', type === 'income');
  fillCategories(type);
  applyUtilityPayer();
}

/** 清掉目前這個月的全部紀錄。連按兩次確認，且不可復原。 */
async function clearMonthRecords() {
  const count = state.allItems().length;
  if (!count) return toast('這個月本來就沒有紀錄');
  if (!confirm(`確定要清掉 ${calc.monthLabel(month)}的全部 ${count} 筆紀錄？`)) return;
  if (!confirm('清空後無法復原，確定要繼續？')) return;
  setWorking(true);
  setSync('busy', '清空中');
  try {
    await state.mutate((list) => { list.length = 0; });
    setSync('ok', '已清空');
    toast(`${calc.monthLabel(month)}已清空`);
  } catch (err) {
    setSync('error', '清空失敗');
    toast(err.message || '清空失敗');
  } finally {
    setWorking(false);
  }
}

/** 日期是透明 input 蓋在按鈕上，每次改值都要同步按鈕上的文字。 */
function setDate(value) {
  $('#add-date').value = value;
  $('#add-date-text').textContent = calc.dateLabel(value);
}

function resetForm() {
  editingId = null;
  $('#add-form').reset();
  setDate(month === calc.monthKey() ? calc.todayKey() : `${month}-01`);
  fillSelect($('#add-by'), settings.people(), me);
  setAddType('expense');
  $('#add-submit').textContent = '記下來';
  $('#add-cancel').hidden = true;
  $('#add-delete').hidden = true;
  $('#add-error').hidden = true;
  if (view === 'add') ui.title.textContent = TITLES.add;
}

function editRecord(id) {
  if (working) return;
  const item = state.allItems().find((it) => it.id === id);
  if (!item) return;
  editingId = id;
  setAddType(item.type);
  $('#add-amount').value = String(item.amount);
  setDate(item.date);
  fillCategories(item.type, item.category);
  $('#add-note').value = item.note || '';
  fillSelect($('#add-by'), settings.people(), item.by);
  $('#add-submit').textContent = '更新這筆';
  $('#add-cancel').hidden = false;
  $('#add-delete').hidden = false;
  show('add');
}

async function submitForm(event) {
  event.preventDefault();
  if (working) return;
  const error = $('#add-error');
  error.hidden = true;
  if (!dataReady) return fail('資料尚未載入，請按右上角同步重試');
  const amount = calc.parseAmount($('#add-amount').value);
  const payload = {
    type: addType,
    amount,
    date: $('#add-date').value,
    category: $('#add-category').value,
    note: $('#add-note').value.trim(),
    by: $('#add-by').value,
  };
  if (addType === 'expense') {
    const original = state.allItems().find((it) => it.id === editingId);
    payload.billingGroup = original?.category === payload.category && GROUPS.includes(original.billingGroup)
      ? original.billingGroup : classify(payload.category, settings.all()?.billingGroups);
  }

  if (!payload.amount) return fail('請輸入大於 0 的整數金額（可含千分位逗號）');
  if (!calc.validDate(payload.date)) return fail('請選有效日期');
  if (!payload.date.startsWith(month)) return fail('日期不在目前顯示的月份，請先切換月份');
  if (!payload.category) return fail('請選分類');
  if (!payload.by) return fail('請選記帳的人');

  setSync('busy', '儲存中');
  setWorking(true);
  $('#add-submit').textContent = '儲存中…';
  try {
    if (editingId) {
      if (!await state.update(editingId, payload)) throw new Error('這筆紀錄已被刪除，請重新整理後確認');
      toast('已更新');
    } else {
      await state.add(payload);
      toast(`已記下 ${payload.type === 'income' ? '+' : '−'}${calc.money(payload.amount)}`);
    }
    resetForm();
    afterWrite();
  } catch (err) {
    setSync('error', '失敗');
    fail(err.message || '儲存失敗');
  } finally {
    setWorking(false);
    $('#add-submit').textContent = editingId ? '更新這筆' : '記下來';
  }

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    return false;
  }
}

/* ---------- 讀寫後的整理 ---------- */

function afterWrite() {
  setSync('ok', '已同步');
  render();
}

async function loadMonthQuietly(target) {
  try {
    const data = await store.loadMonth(target);
    return data.items;
  } catch {
    return [];
  }
}

function watchMonth() {
  stopWatching();
  const target = month;
  stopWatching = store.watch(target, async () => {
    if (working || month !== target) throw new Error('稍後重試');
    if (await state.reload()) {
      setSync('ok', '剛剛更新', 'month');
      toast('資料已更新');
    }
  });
}

async function switchMonth(target = month, refreshSettings = false) {
  if (working) return false;
  setWorking(true);
  setSync('busy', '載入中');
  try {
    if (refreshSettings || !settings.all()) await settings.load();
    const changed = target !== month;
    await state.load(target);
    month = target;
    prevItems = await loadMonthQuietly(calc.shiftMonth(month, -1));
    dataReady = true;
    if (changed) resetForm();
    refreshFormOptions();
    watchMonth();
    const synced = view === 'billing' ? await reports.refresh() : true;
    setSync(synced ? 'ok' : 'error', synced ? '已同步' : '同步失敗');
    render();
    return true;
  } catch (err) {
    setSync('error', '讀取失敗');
    toast(err.message || '讀取失敗');
    return false;
  } finally {
    setWorking(false);
  }
}

/* ---------- 事件 ---------- */

function bind() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => show(tab.dataset.view));
  }

  $('#month-prev').addEventListener('click', () => switchMonth(calc.shiftMonth(month, -1)));
  $('#month-next').addEventListener('click', () => switchMonth(calc.shiftMonth(month, 1)));
  $('#month-label').addEventListener('click', () => switchMonth(calc.monthKey()));
  ui.sync.addEventListener('click', () => {
    if (updateReady) { location.reload(); return; }
    switchMonth(month, true);
  });

  for (const btn of document.querySelectorAll('.seg-btn[data-type]')) {
    if (btn.hasAttribute('data-cat-switch')) continue;
    btn.addEventListener('click', () => setAddType(btn.dataset.type));
  }

  for (const chip of document.querySelectorAll('.chip[data-day]')) {
    chip.addEventListener('click', () => {
      const d = new Date();
      if (chip.dataset.day === 'yesterday') d.setDate(d.getDate() - 1);
      setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    });
  }

  // 從原生日曆選日期不會經過 setDate，要另外同步按鈕文字。
  $('#add-date').addEventListener('input', (e) => setDate(e.target.value));
  $('#add-date').addEventListener('change', (e) => setDate(e.target.value));

  $('#add-form').addEventListener('submit', submitForm);
  $('#add-category').addEventListener('change', () => {
    updateCategoryHint();
    applyUtilityPayer();
  });

  $('#view-billing').addEventListener('click', async (e) => {
    if (!e.target.closest('#billing-show-records') || working) return;
    if (await switchMonth(reports.selectedDetailMonth())) show('stats');
  });

  $('#add-cancel').addEventListener('click', () => resetForm());

  $('#add-delete').addEventListener('click', async () => {
    if (working || !editingId || !confirm('確定刪除這筆紀錄？')) return;
    setWorking(true);
    setSync('busy', '刪除中');
    try {
      if (!await state.remove(editingId)) throw new Error('這筆紀錄已被刪除，請同步後確認');
      resetForm();
      afterWrite();
      toast('已刪除');
    } catch (err) {
      setSync('error', '刪除失敗');
      toast(err.message || '刪除失敗');
    } finally {
      setWorking(false);
    }
  });

  $('#view-dashboard').addEventListener('click', (e) => {
    const action = e.target.closest('[data-go]');
    if (action) return show(action.dataset.go);
    const row = e.target.closest('.row[data-id]');
    if (row) editRecord(row.dataset.id);
  });

  for (const event of ['input', 'change']) {
    $('#view-stats').addEventListener(event, (e) => {
      const key = e.target.dataset.filter;
      if (!key || (key === 'query' ? event !== 'input' : event !== 'change')) return;
      filters[key] = e.target.value;
      $('#record-results').innerHTML = views.records(state.allItems(), filters);
    });
  }

  $('#view-stats').addEventListener('click', async (e) => {
    if (e.target.closest('[data-go="billing"]')) return show('billing');
    if (e.target.closest('#record-clear')) {
      Object.assign(filters, { query: '', type: '', by: '' });
      return render();
    }
    const row = e.target.closest('.row[data-id]');
    if (row) return editRecord(row.dataset.id);
    const sw = e.target.closest('[data-cat-switch]');
    if (sw) {
      categoryType = sw.dataset.type;
      render();
    }
  });
}

/* ---------- 設定頁事件（委派） ---------- */

function bindSettings() {
  const root = $('#view-settings');

  root.addEventListener('change', async (e) => {
    if (e.target.id === 'set-me') {
      me = e.target.value;
      writeStored('spa-me', me);
      toast('已記住');
    }
    if (e.target.id === 'set-theme') {
      theme = e.target.value;
      writeStored('spa-theme', theme);
      applyTheme();
    }
  });

  root.addEventListener('click', async (e) => {
    const addBtn = e.target.closest('[data-add-cat]');
    const delBtn = e.target.closest('[data-del-cat]');
    const budgetBtn = e.target.closest('[data-budget-person]');
    const renameBtn = e.target.closest('[data-rename-person]');
    const delPersonBtn = e.target.closest('[data-del-person]');
    if (e.target.closest('[data-go="billing"]')) return show('billing');
    if (e.target.closest('#set-export')) return exportCsv();
    if (e.target.closest('#set-clear')) return clearMonthRecords();
    if (e.target.closest('#set-lock')) {
      if (working || !confirm('移除後，這台裝置要重新點專屬連結才能開啟帳本。確定移除？')) return;
      reports.lock();
      store.lock();
      if (!(await LinkKey.forget())) return toast('無法移除登入，請允許網站儲存後再試');
      location.reload();
      return;
    }
    if (working || (!addBtn && !delBtn && !budgetBtn && !renameBtn && !delPersonBtn)) return;
    const targetMonth = month;
    setWorking(true);
    setSync('busy', '儲存設定');

    try {
      if (addBtn) {
        const kind = addBtn.dataset.addCat;
        const input = $(`#new-cat-${kind}`);
        let name = input.value.trim();
        if (!name) return toast('請輸入分類名稱');
        let group = kind === 'expense' ? $('#new-cat-group').value : null;
        if (group && group !== '日常' && !name.startsWith(`${group}／`)) name = `${group}／${name}`;
        if (group === '日常') group = classify(name);
        const key = kind === 'income' ? 'incomeCategories' : 'expenseCategories';
        await settings.save((s) => {
          if (!s[key].includes(name)) s[key].push(name);
          if (group) s.billingGroups[name] = group;
        });
        toast('已新增');
      }

      if (delBtn) {
        const kind = delBtn.dataset.delCat;
        const name = delBtn.dataset.category;
        if (!confirm(`確定刪除分類「${name}」？已記錄的紀錄不會受影響。`)) return;
        const key = kind === 'income' ? 'incomeCategories' : 'expenseCategories';
        await settings.save((s) => {
          const remaining = s[key].filter((c) => c !== name);
          if (!remaining.length) throw new Error('請至少保留一個分類');
          s[key] = remaining;
        });
        toast('已刪除');
      }

      if (budgetBtn) {
        const person = budgetBtn.dataset.budgetPerson;
        const value = Number($(`#set-budget-${budgetBtn.dataset.budgetIndex}`).value || 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('請輸入 0 或正整數');
        await settings.save((s) => {
          s.budgets = s.budgets || {};
          s.budgets[person] = s.budgets[person] || {};
          s.budgets[person][targetMonth] = value;
        });
        toast(`${person}的額度已更新`);
      }

      if (renameBtn) {
        const from = renameBtn.dataset.renamePerson;
        const answer = prompt(`把「${from}」改成什麼？`, from);
        const name = answer?.trim();
        if (!name || name === from) return;
        if (settings.people().includes(name)) throw new Error(`已經有「${name}」了`);
        await settings.save((s) => {
          if (!s.people.includes(from)) throw new Error('這位記帳人已被修改，請同步後再試');
          if (s.people.includes(name)) throw new Error(`已經有「${name}」了`);
          s.people = s.people.map((p) => (p === from ? name : p));
          if (s.budgets) {
            if (s.budgets[from]) s.budgets[name] = s.budgets[from];
            delete s.budgets[from];
          }
        });
        if (me === from) {
          me = name;
          writeStored('spa-me', name);
        }
        // 本月紀錄一起改名，其他月份讀不到，這裡明確只處理已載入的那個月。
        await state.mutate((list) => {
          for (const it of list) if (it.by === from) it.by = name;
        });
        toast(`已改成「${name}」`);
      }

      if (delPersonBtn) {
        const name = delPersonBtn.dataset.delPerson;
        if (!settings.members().some((p) => p !== name)) throw new Error('請至少保留一位記帳人');
        const used = state.allItems().filter((it) => it.by === name).length;
        const tail = used ? `本月有 ${used} 筆紀錄記在這個人名下，紀錄不會被刪除。` : '本月沒有這個人的紀錄。';
        if (!confirm(`確定刪除記帳人「${name}」？${tail}`)) return;
        await settings.save((s) => {
          const remaining = s.people.filter((p) => p !== name);
          if (!remaining.some((p) => p !== UTILITY_PAYER)) throw new Error('請至少保留一位記帳人');
          s.people = remaining;
          if (s.budgets) delete s.budgets[name];
        });
        if (me === name) {
          me = settings.members()[0];
          writeStored('spa-me', me);
          toast(`已刪除，這支手機改用「${me}」`);
        } else {
          toast('已刪除');
        }
      }

      render();
    } catch (err) {
      setSync('error', '設定失敗');
      toast(err.message || '操作失敗');
      return;
    } finally {
      setWorking(false);
      if (ui.sync.dataset.state === 'busy') setSync('ok', '已同步');
    }
  });
}

function exportCsv() {
  const items = calc.byDateDesc(state.allItems());
  const rows = [['日期', '類型', '分類', '內容', '記帳人', '金額']];
  for (const it of items) {
    rows.push([it.date, it.type === 'income' ? '收入' : '支出', it.category, it.note || '', it.by || '', it.amount]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => {
    const text = typeof c === 'string' && /^[\s]*[=+\-@]/.test(c) ? `'${c}` : String(c);
    return `"${text.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${month}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 啟動 ---------- */

/** 金鑰來自網址（fresh）或這台裝置；解得開才記住網址帶來的金鑰。 */
async function unlockAccount(key, fresh) {
  if (unlocking) return;
  unlocking = true;
  loginScreen.render({ busy: true, message: '' });
  try {
    await store.unlock(key);
    const remembered = !fresh || await LinkKey.save(key);
    await start();
    if (!remembered) toast('這個瀏覽器無法記住登入，下次仍需用專屬連結開啟');
  } catch (err) {
    if (err.code === 'revoked' && !fresh) await LinkKey.forget();
    showLock(err.message === '找不到 secret.json' ? '這個網站還沒設定。請在電腦上執行 npm run setup 後重新發布。' : err.message || '無法開啟帳本');
  } finally {
    unlocking = false;
    loginScreen.render({ busy: false });
  }
}

function showLock(message) {
  ui.app.hidden = true;
  loginScreen.render({ visible: true, message });
}

async function start() {
  loginScreen.render({ visible: false });
  applyTheme();
  setWorking(true);

  setSync('busy', '載入中');
  try {
    await settings.load();
    // 沒選過、或選的人已經不在名單裡，就先問一次再往下走。
    if (!settings.members().includes(me)) {
      me = await askWho();
      writeStored('spa-me', me);
    }
    await state.load(month);
    prevItems = await loadMonthQuietly(calc.shiftMonth(month, -1));
    dataReady = true;
    watchMonth();
    setSync('ok', '已同步');
  } catch (err) {
    setSync('error', '失敗');
    toast(err.message || '讀取失敗');
  } finally {
    setWorking(false);
  }

  ui.app.hidden = false;
  resetForm();
  show('dashboard');
}

async function boot() {
  applyTheme();
  bind();
  bindSettings();
  reports.init($('#view-billing'), { settings: () => settings.all(), sync: (next, label) => setSync(next, label, 'billing') });
  state.onChange(() => {
    reports.updateMonth(state.currentMonth(), state.allItems());
    if (!working) render();
  });
  if (store.isLocal()) return start();
  store.clearLegacy();
  let found;
  try { found = await LinkKey.current(); } catch (err) { return showLock(err.message); }
  if (!found) return showLock('');
  await unlockAccount(found.key, found.fresh);
}

boot();
