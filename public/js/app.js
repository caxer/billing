// 進入點：解鎖、分頁切換、記帳表單、每月導覽、輪詢同步。

import * as store from './store.js';
import * as state from './state.js';
import * as notes from './notes.js';
import * as settings from './settings.js';
import * as calc from './calc.js';
import * as views from './views.js';
import { readStored, writeStored, removeStored } from './storage.js';
import { classify, GROUPS, UTILITY_PAYER, FUND_PAYER, guessCategory } from './billing.js';
import * as reports from './reports.js';
import { initLoginScreen } from './login-screen.js';
import * as ai from './ai.js';
import { preparePhoto } from './photo.js';
import { asButtons, enhance } from './choices.js';
import { applyAliases, suggestNames } from './rules.js';

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

const TITLES = { add: '記帳', calendar: '行事曆', stats: '本月', billing: '年度', settings: '設定' };

let view = 'add';
let month = calc.monthKey();
let prevItems = [];
let categoryType = 'expense';
let editingId = null;
let addType = 'expense';
let calendarDay = '';
let me = readStored('spa-me') || '';
let theme = readStored('spa-theme') || 'auto';
let working = false;
let dataReady = false;
let unlocking = false;
let stopWatching = () => {};
const filters = { query: '', by: '', category: '', sort: 'date', dir: 'desc' };

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

/** 回到 App 與開著時每分鐘看一次設定，別支手機或電腦改的分類、記帳人、額度會跟著更新。 */
async function syncSettings() {
  if (!dataReady || working || document.visibilityState === 'hidden') return;
  // 正在設定頁輸入時不重畫，打到一半的額度才不會被清掉；下次再同步。
  if (view === 'settings' && document.activeElement?.closest('#view-settings')) return;
  try { if (await settings.refresh()) { refreshFormOptions(); render(); } } catch { /* 斷網下次再試 */ }
}
setInterval(syncSettings, 60000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { checkVersion(); syncSettings(); }
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
  for (const control of document.querySelectorAll('.tab, [data-cat-switch], #month-nav button, #month-picker button, #add-form input, #add-form select, #add-form button, #view-add .seg-btn, #view-calendar button, #view-settings button, #view-settings input, #view-settings select')) {
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

/** 本月分頁（stats）上面是摘要與圖表，下面是明細；show('records') 開本月並捲到明細。 */
function show(target) {
  if (working) return;
  const next = target === 'records' ? 'stats' : target;
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.view === next);
    if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const sec of document.querySelectorAll('.view')) {
    sec.hidden = sec.id !== `view-${next}` && !(next === 'stats' && sec.id === 'view-records');
  }
  ui.title.textContent = next === 'add' && editingId ? editTitle() : TITLES[next];
  ui.monthNav.hidden = next === 'add' || next === 'billing';
  togglePicker(false);
  reports.setActive(next === 'billing');
  renderSync();
  if (next === 'add' && !editingId && !$('#add-amount').value && !$('#add-note').value) resetForm();
  if (next === 'add') refreshFormOptions();
  if (next === 'calendar') syncNotes();
  render();
  if (target === 'records') $('#view-records').scrollIntoView({ block: 'start' });
}

const editTitle = () => (addType === 'note' ? '編輯記事' : '編輯紀錄');

/** 打開行事曆或手動同步時重讀記事，別支手機記的會跟著出現。 */
async function syncNotes() {
  try { await notes.load(); } catch (err) { toast(err.message || '記事讀取失敗'); }
}

/* ---------- 繪製 ---------- */

function render() {
  if (view === 'stats') {
    $('#view-stats').innerHTML = views.stats(month, state.allItems(), prevItems, categoryType, settings.people());
    const active = document.activeElement;
    const selection = active?.id === 'record-query' ? [active.selectionStart, active.selectionEnd] : null;
    const { items, scope } = recordPool();
    $('#view-records').innerHTML = views.recordsView(items, filters, settings.people(), scope);
    enhance($('#view-records'));
    if (selection) {
      const input = $('#record-query');
      input.focus({ preventScroll: true });
      input.setSelectionRange(...selection);
    }
  } else if (view === 'calendar') {
    $('#view-calendar').innerHTML = views.calendar(month, notes.all(), calendarDay.startsWith(month) ? calendarDay : '');
  } else if (view === 'settings') {
    renderSettings();
  } else if (view === 'add') {
    $('#add-recent').innerHTML = views.recentView(state.allItems(), settings.people());
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
    month,
    me: meValue,
    theme,
    budgets: all.budgets || {},
    isLocal: store.isLocal(),
  });
  enhance($('#view-settings'));
  for (const id of opened) { const el = document.getElementById(id); if (el) el.open = true; }
}

/* ---------- 記帳表單 ---------- */

function fillSelect(select, list, selected) {
  const values = [...new Set([...list, ...(selected ? [selected] : [])])];
  select.replaceChildren(...values.map((value) => new Option(value, value, false, value === selected)));
}

function fillCategories(type, selected) {
  if (type === 'note') return;
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

/** 依內容自動選分類；手動改過或在編輯舊紀錄時不覆蓋。 */
let categoryTouched = false;
function guessFromNote() {
  if (categoryTouched || editingId || addType === 'note') return;
  const select = $('#add-category');
  const rules = settings.all()?.rules || {};
  const note = applyAliases($('#add-note').value, rules.aliases);
  const guess = guessCategory(note, addType, [...state.allItems(), ...prevItems], settings.categories(addType), rules.keywords);
  $('#add-category-auto').textContent = '自動';
  $('#add-category-auto').hidden = !guess;
  if (!guess || guess === select.value) return;
  select.value = guess;
  updateCategoryHint();
  applyUtilityPayer();
}

/* ---------- AI 記帳：分類、語音、拍收據 ---------- */

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
let aiBusy = false, aiCategoryRun = 0, listening = null;

function renderAiTools() {
  $('#ai-tools').hidden = !ai.available();
  $('#ai-voice').hidden = !Recognition;
}

function aiStatus(text) {
  $('#ai-status').textContent = text;
  $('#ai-status').hidden = !text;
}

/** 給 Claude 的參考：可選分類、今天日期、本月與上月最近 60 個不同內容的分類。 */
function aiContext() {
  const seen = new Set(), history = [];
  for (const it of calc.byDateDesc([...state.allItems(), ...prevItems])) {
    const note = (it.note || '').trim();
    if (!note || seen.has(note) || ['結餘調整', '與原表差額'].includes(it.category)) continue;
    seen.add(note);
    history.push({ note, category: it.category });
    if (history.length >= 60) break;
  }
  return { categories: { expense: settings.categories('expense'), income: settings.categories('income') }, history, today: calc.todayKey() };
}

function markAi(category) {
  const select = $('#add-category');
  if (![...select.options].some((o) => o.value === category)) return false;
  select.value = category;
  categoryTouched = false;
  $('#add-category-auto').textContent = 'AI';
  $('#add-category-auto').hidden = false;
  updateCategoryHint();
  applyUtilityPayer();
  return true;
}

/** 關鍵字與以前的紀錄判斷不出來時，離開「內容」欄位後請 Claude 判斷分類。 */
async function aiCategory() {
  const note = $('#add-note').value.trim();
  if (!ai.available() || aiBusy || categoryTouched || editingId || addType === 'note' || !note || !$('#add-category-auto').hidden) return;
  const run = ++aiCategoryRun;
  $('#add-category-auto').textContent = 'AI…';
  $('#add-category-auto').hidden = false;
  try {
    const entry = await ai.parseEntry({ text: note, ...aiContext() });
    if (run !== aiCategoryRun || categoryTouched || editingId || $('#add-note').value.trim() !== note) return;
    if (entry.type !== addType && entry.category) setAddType(entry.type);
    if (!entry.category || !markAi(entry.category)) $('#add-category-auto').hidden = true;
  } catch (err) {
    if (run === aiCategoryRun) { $('#add-category-auto').hidden = true; toast(err.message); }
  }
}

/** 把 Claude 判斷的一筆填進表單，日期在別的月份就先切過去；不自動送出，讓人確認。 */
async function fillFromAi(entry) {
  if (entry.date && calc.validDate(entry.date) && !entry.date.startsWith(month) && !await switchMonth(entry.date.slice(0, 7))) {
    throw new Error(`這筆的日期是 ${entry.date}，切換月份失敗，請再試一次`);
  }
  setAddType(entry.type);
  if (entry.amount) $('#add-amount').value = String(entry.amount);
  if (entry.note) $('#add-note').value = sameSpelling(entry.note);
  if (entry.date && calc.validDate(entry.date) && entry.date.startsWith(month)) setDate(entry.date);
  if (!entry.category || !markAi(entry.category)) guessFromNote();
  renderNoteSuggest(true);
}

/* ---------- 內容的名稱提示：輸入時列出以前用過的名稱，寫法一致 ---------- */

/** 以前用過的名稱與筆數：記事看記事，收支看全部時段同收支的紀錄（還沒讀完先用本月與上月）。 */
function pastNames() {
  const list = addType === 'note' ? notes.all()
    : Object.values({ [calc.shiftMonth(month, -1)]: prevItems, ...reports.allRecords(), [month]: state.allItems() }).flat()
      .filter((it) => it.type === addType && !['結餘調整', '與原表差額'].includes(it.category));
  const counts = new Map();
  for (const it of list) {
    const note = (it.note || '').trim();
    if (note) counts.set(note, (counts.get(note) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** Claude 給的名稱和以前的只差大小寫、全半形或空白時，沿用以前的寫法。 */
function sameSpelling(note) {
  const flat = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const name = applyAliases(note, settings.all()?.rules?.aliases);
  return pastNames().find((n) => flat(n.name) === flat(name))?.name || name;
}

/** 輸入中或 AI 剛填好時顯示；離開欄位就收起來。 */
function renderNoteSuggest(show = document.activeElement === $('#add-note')) {
  const box = $('#note-suggest');
  const names = show ? suggestNames($('#add-note').value, pastNames(), settings.all()?.rules?.aliases) : [];
  box.replaceChildren(...names.map((name) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = name;
    button.dataset.name = name;
    return button;
  }));
  box.hidden = !names.length;
}

function chooseName(name) {
  aiCategoryRun++;
  $('#add-note').value = name;
  $('#add-category-auto').hidden = true;
  guessFromNote();
  renderNoteSuggest(false);
}

async function runAi(request, label) {
  if (aiBusy || working) { aiStatus(''); toast('正在處理上一筆，稍後再試一次'); return; }
  // 說一筆、拍收據一律是新增；正在編輯舊紀錄時先放掉，不然按「更新這筆」會蓋掉那筆。
  if (editingId) resetForm();
  aiBusy = true;
  aiCategoryRun++;
  for (const id of ['#ai-voice', '#ai-photo']) $(id).disabled = true;
  aiStatus(`${label} · AI 判斷中…`);
  try {
    const entry = await ai.parseEntry({ ...request, ...aiContext() });
    await fillFromAi(entry);
    aiStatus(`${label} · 已填好，確認後按「記下來」`);
  } catch (err) {
    aiStatus('');
    toast(err.message || 'AI 判斷失敗');
  } finally {
    aiBusy = false;
    for (const id of ['#ai-voice', '#ai-photo']) $(id).disabled = false;
  }
}

/**
 * 聽到完整的一句、再按一次或過了 12 秒就自己收尾，不等 onend：iPhone Safari 有時不送 onend，
 * 舊的辨識沒放掉麥克風時第二次就聽不到，所以收尾一律 abort，之後舊辨識送來的事件也不理。
 */
function toggleVoice() {
  if (listening) { listening(); return; }
  const rec = new Recognition();
  rec.lang = 'zh-TW';
  rec.interimResults = true;
  let heard = '', failed = '', done = false, timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    listening = null;
    rec.onresult = rec.onerror = rec.onend = null;
    try { rec.abort(); } catch { /* 已經停了 */ }
    $('#ai-voice').setAttribute('aria-pressed', 'false');
    $('#ai-voice span').textContent = '說一筆';
    const text = heard.trim();
    if (failed) { aiStatus(''); toast(failed); } else if (text) runAi({ text }, `「${text}」`);
    else aiStatus('沒有聽到聲音，再按一次「說一筆」');
  };
  rec.onresult = (e) => {
    const results = [...e.results];
    heard = results.map((r) => r[0].transcript).join('');
    aiStatus(`「${heard}」`);
    if (results.length && results.every((r) => r.isFinal)) finish();
  };
  rec.onerror = (e) => {
    if (!['aborted', 'no-speech'].includes(e.error)) failed = e.error === 'not-allowed' ? '請允許使用麥克風' : `語音辨識失敗（${e.error}）`;
    finish();
  };
  rec.onend = finish;
  listening = finish;
  $('#ai-voice').setAttribute('aria-pressed', 'true');
  $('#ai-voice span').textContent = '聆聽中…';
  aiStatus('請說，例如「昨天全聯三百五」');
  timer = setTimeout(finish, 12000);
  try { rec.start(); } catch { failed = '無法開始語音辨識'; finish(); }
}

async function photoChosen(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    aiStatus('處理照片…');
    const { blob } = await preparePhoto(file);
    await runAi({ image: { data: await ai.blobToBase64(blob), mediaType: blob.type || 'image/jpeg' } }, '收據');
  } catch (err) { aiStatus(''); toast(err.message || '照片處理失敗'); }
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
  aiCategoryRun++; // 換了收支或記事，進行中的 AI 分類作廢
  for (const btn of document.querySelectorAll('.seg-btn[data-type]')) {
    if (btn.hasAttribute('data-cat-switch')) continue;
    btn.classList.toggle('is-on', btn.dataset.type === type);
    btn.setAttribute('aria-pressed', String(btn.dataset.type === type));
  }
  $('#amount-sign').textContent = type === 'income' ? '+' : '−';
  $('.amount-row').classList.toggle('is-income', type === 'income');
  // 記事不記金額與分類：欄位藏起來，也不能留著 required 擋住送出。
  $('#add-form').classList.toggle('is-note', type === 'note');
  $('#add-amount').required = type !== 'note';
  $('#add-category').required = type !== 'note';
  $('#add-note').placeholder = type === 'note' ? '換濾心' : '全聯、麥當勞、電費';
  fillCategories(type);
  applyUtilityPayer();
  guessFromNote();
  renderNoteSuggest();
}

/** 日期是透明 input 蓋在按鈕上，每次改值都要同步按鈕上的文字。 */
function setDate(value) {
  $('#add-date').value = value;
  $('#add-date-text').textContent = calc.dateLabel(value);
}

/** 編輯時不能在收支和記事之間互換，兩者存在不同檔案；kind 為 null 時全部開放。 */
function lockTypes(kind) {
  for (const btn of document.querySelectorAll('#view-add .seg-btn[data-type]')) {
    const off = kind !== null && (btn.dataset.type === 'note') !== (kind === 'note');
    btn.toggleAttribute('data-unavailable', off);
    btn.disabled = off || working;
  }
}

/** 從行事曆新增記事：保留記帳草稿，只把類型切成記事並帶入日期。 */
function newNote(date) {
  show('add');
  if (editingId) resetForm();
  setAddType('note');
  setDate(date);
  $('#add-note').focus();
}

function resetForm() {
  editingId = null;
  lockTypes(null);
  sameRecords = [];
  $('#add-same').hidden = true;
  $('#add-same-all').checked = false;
  categoryTouched = false;
  aiCategoryRun++;
  aiStatus('');
  $('#add-category-auto').hidden = true;
  $('#add-form').reset();
  $('#add-repeat').value = '';
  renderNoteSuggest(false);
  setDate(month === calc.monthKey() ? calc.todayKey() : `${month}-01`);
  fillSelect($('#add-by'), settings.people(), me);
  setAddType('expense');
  $('#add-submit').textContent = '記下來';
  $('#add-cancel').hidden = true;
  $('#add-delete').hidden = true;
  $('#add-error').hidden = true;
  if (view === 'add') ui.title.textContent = TITLES.add;
}

/* ---------- 明細搜尋：有關鍵字時搜尋全部時段 ---------- */

let allLoading = null;

/** 沒有關鍵字列本月；有關鍵字搜尋全部月份（本月用最新的狀態）。 */
function recordPool() {
  if (!filters.query.trim() && !filters.category) { allLoading = null; return { items: state.allItems(), scope: '' }; }
  if (!allLoading) {
    allLoading = reports.loadAll().then((ok) => {
      if (!ok) allLoading = null;
      if (view === 'stats' && (filters.query.trim() || filters.category)) refreshRecordResults();
    });
  }
  const all = { ...reports.allRecords(), [month]: state.allItems() };
  return { items: Object.values(all).flat(), scope: reports.allLoaded() ? '全部時段' : '全部時段讀取中' };
}

function refreshRecordResults() {
  const box = $('#record-results');
  if (!box) return;
  const { items, scope } = recordPool();
  box.innerHTML = views.records(items, filters, settings.people(), scope);
}

/** 點搜尋結果：別的月份的紀錄先切到那個月再編輯。 */
async function openRecord(id) {
  if (state.allItems().some((it) => it.id === id)) return editRecord(id);
  const found = Object.values(reports.allRecords()).flat().find((it) => it.id === id);
  if (found && await switchMonth(found.date.slice(0, 7))) editRecord(id);
}

/* ---------- 同名一起改 ---------- */

let sameRecords = [];

/** 找全部時段裡同名（同收支）的其他紀錄；有的話顯示「一起改」。 */
async function findSameName(item) {
  sameRecords = [];
  $('#add-same').hidden = true;
  $('#add-same-all').checked = false;
  const note = (item.note || '').trim();
  if (!note) return;
  // 沒讀完全部月份就不提示，免得筆數少算還以為全部改到了。
  if (!await reports.loadAll() || editingId !== item.id) return;
  const all = { ...reports.allRecords(), [month]: state.allItems() };
  sameRecords = Object.entries(all).flatMap(([m, list]) => list
    .filter((it) => it.id !== item.id && it.type === item.type && (it.note || '').trim() === note).map((it) => ({ month: m, id: it.id })));
  if (!sameRecords.length) return;
  $('#add-same-text').textContent = `同名「${note}」的另外 ${sameRecords.length} 筆，分類和名稱一起改`;
  $('#add-same').hidden = false;
}

/** 把這筆改掉的分類或名稱套到同名的其他紀錄（只動分類與名稱，金額日期不動）。 */
async function applyToSameName(original, payload) {
  const changes = {};
  if (payload.category !== original.category) {
    changes.category = payload.category;
    if (payload.type === 'expense') changes.billingGroup = payload.billingGroup;
  }
  if (payload.note !== (original.note || '')) changes.note = payload.note;
  if (!Object.keys(changes).length) return 0;
  const byMonth = new Map();
  for (const r of sameRecords) byMonth.set(r.month, [...(byMonth.get(r.month) || []), r.id]);
  let done = 0, i = 0;
  for (const [m, ids] of byMonth) {
    setSync('busy', `一起改 ${++i}/${byMonth.size}`);
    const set = new Set(ids);
    await state.mutateMonth(m, (list) => {
      const hits = list.filter((it) => set.has(it.id));
      if (!hits.length) return false;
      for (const it of hits) Object.assign(it, changes);
      done += hits.length;
    });
  }
  reports.refresh();
  return done;
}

function editRecord(id) {
  if (working) return;
  const item = state.allItems().find((it) => it.id === id);
  if (!item) return;
  editingId = id;
  setAddType(item.type);
  lockTypes(item.type);
  $('#add-amount').value = String(item.amount);
  setDate(item.date);
  fillCategories(item.type, item.category);
  $('#add-note').value = item.note || '';
  fillSelect($('#add-by'), settings.people(), item.by);
  $('#add-submit').textContent = '更新這筆';
  $('#add-cancel').hidden = false;
  $('#add-delete').hidden = false;
  show('add');
  findSameName(item);
}

function editNote(id) {
  if (working) return;
  const item = notes.all().find((it) => it.id === id);
  if (!item) return;
  editingId = id;
  sameRecords = [];
  $('#add-same').hidden = true;
  $('#add-same-all').checked = false;
  setAddType('note');
  lockTypes('note');
  setDate(item.date);
  $('#add-note').value = item.note;
  $('#add-repeat').value = item.repeat || '';
  fillSelect($('#add-by'), settings.people(), item.by);
  $('#add-submit').textContent = '更新這筆';
  $('#add-cancel').hidden = false;
  $('#add-delete').hidden = false;
  show('add');
}

/** 記事只有日期、內容、誰記的；日期不限本月，可以記未來的日子倒數。存完回行事曆看天數。 */
async function submitNote(fail) {
  // 不重複時存 undefined，寫檔時就不會留 repeat 欄位。
  const payload = { date: $('#add-date').value, note: $('#add-note').value.trim(), by: $('#add-by').value, repeat: $('#add-repeat').value || undefined };
  if (!payload.note) return fail('請填內容，例如換濾心');
  if (!calc.validDate(payload.date)) return fail('請選有效日期');
  if (!payload.by) return fail('請選記事的人');
  setSync('busy', '儲存中');
  setWorking(true);
  $('#add-submit').textContent = '儲存中…';
  let saved = false;
  try {
    if (editingId) {
      if (!await notes.update(editingId, payload)) throw new Error('這則記事已被刪除，請同步後確認');
      toast('已更新');
    } else {
      await notes.add(payload);
      toast(`已記事 · ${calc.REPEATS[payload.repeat] ? `${calc.REPEATS[payload.repeat]} · ` : ''}${calc.daysLabel(calc.nextNoteDate(payload))}`);
    }
    saved = true;
  } catch (err) {
    setSync('error', '失敗');
    fail(err.message || '儲存失敗');
  } finally {
    setWorking(false);
    $('#add-submit').textContent = editingId ? '更新這筆' : '記下來';
  }
  if (!saved) return;
  calendarDay = '';
  resetForm();
  setSync('ok', '已同步');
  show('calendar');
}

async function submitForm(event) {
  event.preventDefault();
  if (working) return;
  const error = $('#add-error');
  error.hidden = true;
  if (!dataReady) return fail('資料尚未載入，請按右上角同步重試');
  if (addType === 'note') return submitNote(fail);
  const amount = calc.parseAmount($('#add-amount').value);
  const payload = {
    type: addType,
    amount,
    date: $('#add-date').value,
    category: $('#add-category').value,
    // 別名規則：例如 711早餐 → 7-11 早餐、楊博士 → 羊博士。
    note: applyAliases($('#add-note').value.trim(), settings.all()?.rules?.aliases),
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
      const original = structuredClone(state.allItems().find((it) => it.id === editingId));
      if (!await state.update(editingId, payload)) throw new Error('這筆紀錄已被刪除，請重新整理後確認');
      const together = $('#add-same-all').checked && sameRecords.length ? await applyToSameName(original, payload) : 0;
      toast(together ? `已更新，同名的 ${together} 筆一起改` : '已更新');
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
    if (refreshSettings) syncNotes();
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

/* ---------- 年月快選 ---------- */

let pickerYear = Number(calc.monthKey().slice(0, 4));

function togglePicker(open = $('#month-picker').hidden) {
  $('#month-picker').hidden = !open;
  $('#month-label').setAttribute('aria-expanded', String(open));
  if (!open) return;
  pickerYear = Number(month.slice(0, 4));
  drawPicker();
  $('#picker-months .is-on')?.focus();
}

function drawPicker() {
  const now = calc.monthKey();
  $('#picker-year').textContent = `${pickerYear} 年`;
  $('#picker-months').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const key = `${pickerYear}-${String(i + 1).padStart(2, '0')}`;
    return `<button type="button" class="seg-btn${key === month ? ' is-on' : ''}${key === now ? ' is-now' : ''}" data-month="${key}" aria-pressed="${key === month}"${key === now ? ' title="本月"' : ''}>${i + 1} 月</button>`;
  }).join('');
}

/* ---------- 事件 ---------- */

function bind() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => show(tab.dataset.view));
  }

  $('#month-prev').addEventListener('click', () => switchMonth(calc.shiftMonth(month, -1)));
  $('#month-next').addEventListener('click', () => switchMonth(calc.shiftMonth(month, 1)));
  $('#month-label').addEventListener('click', () => togglePicker());
  $('#month-picker').addEventListener('click', (e) => {
    const step = e.target.closest('[data-year-step]');
    if (step) { pickerYear += Number(step.dataset.yearStep); drawPicker(); return; }
    const target = e.target.closest('[data-month]')?.dataset.month || (e.target.closest('#picker-today') && calc.monthKey());
    if (!target) return;
    togglePicker(false);
    $('#month-label').focus();
    if (target !== month) switchMonth(target);
  });
  document.addEventListener('click', (e) => {
    if (!$('#month-picker').hidden && !e.target.closest('#month-picker, #month-label')) togglePicker(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('#month-picker').hidden) return;
    togglePicker(false);
    $('#month-label').focus();
  });
  ui.sync.addEventListener('click', async () => {
    if (updateReady) { location.reload(); return; }
    if (working) return;
    // 本機模式先把線上帳本抓到 local/data，再重讀。
    if (store.isLocal()) {
      setWorking(true);
      setSync('busy', '抓線上中');
      try {
        if (await store.pullCloud()) toast('已抓到線上最新資料');
      } catch (err) {
        toast(`${err.message}，顯示本機資料`);
      } finally {
        setWorking(false);
      }
    }
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
  asButtons($('#add-by'));
  asButtons($('#add-repeat'));
  $('#add-note').addEventListener('input', () => { guessFromNote(); renderNoteSuggest(); });
  // 第一次點內容時讀全部月份，之後的提示才有以前的名稱。
  $('#add-note').addEventListener('focus', () => {
    if (addType !== 'note' && !reports.allLoaded()) reports.loadAll().then(() => renderNoteSuggest(), () => {});
  });
  // 晚一點收，點提示時不會先被收掉。
  $('#add-note').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#add-note')) renderNoteSuggest(false); }, 200));
  // 按下提示時不讓輸入框失去焦點，避免先把打到一半的字送去判斷分類。
  $('#note-suggest').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#note-suggest').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button && !working) chooseName(button.dataset.name);
  });
  $('#add-note').addEventListener('change', aiCategory);
  $('#ai-voice').addEventListener('click', toggleVoice);
  $('#ai-photo').addEventListener('click', () => $('#ai-photo-file').click());
  $('#ai-photo-file').addEventListener('change', photoChosen);
  $('#add-category').addEventListener('change', () => {
    categoryTouched = true;
    $('#add-category-auto').hidden = true;
    updateCategoryHint();
    applyUtilityPayer();
  });

  $('#view-billing').addEventListener('click', async (e) => {
    if (!e.target.closest('#billing-show-records') || working) return;
    if (await switchMonth(reports.selectedDetailMonth())) show('records');
  });

  $('#add-cancel').addEventListener('click', () => resetForm());

  $('#add-delete').addEventListener('click', async () => {
    const isNote = addType === 'note';
    if (working || !editingId || !confirm(isNote ? '確定刪除這則記事？' : '確定刪除這筆紀錄？')) return;
    setWorking(true);
    setSync('busy', '刪除中');
    let removed = false;
    try {
      if (!await (isNote ? notes : state).remove(editingId)) throw new Error(`這${isNote ? '則記事' : '筆紀錄'}已被刪除，請同步後確認`);
      resetForm();
      afterWrite();
      toast('已刪除');
      removed = true;
    } catch (err) {
      setSync('error', '刪除失敗');
      toast(err.message || '刪除失敗');
    } finally {
      setWorking(false);
    }
    if (removed && isNote) show('calendar');
  });

  $('#view-calendar').addEventListener('click', (e) => {
    const day = e.target.closest('.cal-day');
    if (day) {
      calendarDay = calendarDay === day.dataset.date ? '' : day.dataset.date;
      return render();
    }
    if (e.target.closest('#cal-clear')) { calendarDay = ''; return render(); }
    if (e.target.closest('#cal-add')) return newNote(calendarDay.startsWith(month) ? calendarDay : calc.todayKey());
    const row = e.target.closest('[data-note-id]');
    if (row) editNote(row.dataset.noteId);
  });

  for (const event of ['input', 'change']) {
    $('#view-records').addEventListener(event, (e) => {
      const key = e.target.dataset.filter;
      if (!key || (key === 'query' ? event !== 'input' : event !== 'change')) return;
      filters[key] = e.target.value;
      const { items, scope } = recordPool();
      $('#record-results').innerHTML = views.records(items, filters, settings.people(), scope);
    });
  }

  $('#add-recent').addEventListener('click', (e) => {
    const row = e.target.closest('.row[data-id]');
    if (row) editRecord(row.dataset.id);
  });

  $('#view-records').addEventListener('click', (e) => {
    if (e.target.closest('#record-clear-category')) { filters.category = ''; return render(); }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      // 再按一次目前的排序就反轉方向。
      filters.dir = filters.sort === sort.dataset.sort && filters.dir === 'desc' ? 'asc' : 'desc';
      filters.sort = sort.dataset.sort;
      return render();
    }
    const row = e.target.closest('.row[data-id]');
    if (row) openRecord(row.dataset.id);
  });

  $('#view-stats').addEventListener('click', (e) => {
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
    const budgetBtn = e.target.closest('[data-budget-person]');
    const renameBtn = e.target.closest('[data-rename-person]');
    if (working || (!budgetBtn && !renameBtn)) return;
    const targetMonth = month;
    setWorking(true);
    setSync('busy', '儲存設定');

    try {
      if (budgetBtn) {
        const person = budgetBtn.dataset.budgetPerson;
        const value = Number($(`#set-budget-${budgetBtn.dataset.budgetIndex}`).value || 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('請輸入 0 或正整數');
        await settings.save((s) => {
          s.budgets = s.budgets || {};
          s.budgets[person] = s.budgets[person] || {};
          s.budgets[person][budgetBtn.dataset.budgetPeriod || targetMonth] = value;
        });
        toast(`${person}的額度已更新`);
      }

      if (renameBtn) {
        const from = renameBtn.dataset.renamePerson;
        const answer = prompt(`把「${from}」改成什麼？`, from);
        const name = answer?.trim();
        if (!name || name === from) return;
        if (settings.people().includes(name)) throw new Error(`已經有「${name}」了`);
        if ([UTILITY_PAYER, FUND_PAYER].includes(name)) throw new Error(`「${name}」是帳戶名稱，請換一個`);
        // 所有月份的紀錄與記事一起改名，歷史月份的額外收入與公積金帳才不會斷成兩個人。
        // 先改紀錄、最後才改名單：中途失敗時名單還是舊名字，再按一次改名就會把剩下的月份補完。
        // 動紀錄前先重讀雲端名單，別支手機剛改過也不會改出重複的名字。
        await settings.refresh();
        if (!settings.people().includes(from)) throw new Error('這位記帳人已被修改，請同步後再試');
        if (settings.people().includes(name)) throw new Error(`已經有「${name}」了`);
        const months = [...new Set([targetMonth, ...(await store.listMonths()).map((f) => f.month)])];
        const used = [];
        for (let i = 0; i < months.length; i += 6) {
          const loaded = await Promise.all(months.slice(i, i + 6).map((m) => store.loadMonth(m)));
          used.push(...loaded.filter((d) => d.items.some((it) => it.by === from)).map((d) => d.month));
        }
        for (const [i, m] of used.entries()) {
          setSync('busy', `改名 ${i + 1}/${used.length}`);
          await state.mutateMonth(m, (list) => {
            const hits = list.filter((it) => it.by === from);
            if (!hits.length) return false;
            for (const it of hits) it.by = name;
          });
        }
        await notes.mutate((list) => {
          const hits = list.filter((it) => it.by === from);
          if (!hits.length) return false;
          for (const it of hits) it.by = name;
        });
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
        toast(`已改成「${name}」${used.length ? `，${used.length} 個月的紀錄一起改` : ''}`);
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
    ai.setKey(await store.aiKey());
    renderAiTools();
    // 沒選過、或選的人已經不在名單裡，就先問一次再往下走。
    if (!settings.members().includes(me)) {
      me = await askWho();
      writeStored('spa-me', me);
    }
    await state.load(month);
    prevItems = await loadMonthQuietly(calc.shiftMonth(month, -1));
    dataReady = true;
    watchMonth();
    syncNotes();
    setSync('ok', '已同步');
  } catch (err) {
    setSync('error', '失敗');
    toast(err.message || '讀取失敗');
  } finally {
    setWorking(false);
  }

  ui.app.hidden = false;
  resetForm();
  show('add');
}

async function boot() {
  applyTheme();
  bind();
  bindSettings();
  reports.init($('#view-billing'), { settings: () => settings.all(), sync: (next, label) => setSync(next, label, 'billing'),
    // 占比點名稱或分類：到明細搜尋全部時段。
    search: (query, category = '') => { Object.assign(filters, { query, category, by: '' }); show('records'); } });
  state.onChange(() => {
    reports.updateMonth(state.currentMonth(), state.allItems());
    if (!working) render();
  });
  notes.onChange(() => { if (!working && view === 'calendar') render(); });
  if (store.isLocal()) return start();
  store.clearLegacy();
  let found;
  try { found = await LinkKey.current(); } catch (err) { return showLock(err.message); }
  if (!found) return showLock('');
  await unlockAccount(found.key, found.fresh);
}

boot();
