// 這個月有哪些紀錄。寫入一律走 mutate()，因為兩支手機可能同時改。

import * as store from './store.js';
import { monthKey } from './calc.js';

let month = monthKey();
let items = [];
const listeners = new Set();
let revision = 0;
let loadSequence = 0;
let writes = Promise.resolve();

export const currentMonth = () => month;
export const allItems = () => items;

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(items);
}

/** 切換月份並重新載入。回傳目前紀錄。 */
export async function load(target = month) {
  const request = ++loadSequence;
  revision++;
  let data;
  for (;;) {
    const readingRevision = revision;
    data = await store.loadMonth(target);
    if (request !== loadSequence) return items;
    // 載入期間若有寫入完成，再讀一次，避免用寫入前的快照覆蓋資料。
    if (readingRevision === revision) break;
  }
  month = target;
  items = data.items;
  revision++;
  notify();
  return items;
}

/** 別人改了資料時重新載入；過期的讀取拋錯，讓訂閱下一輪重試。 */
export async function reload() {
  const target = month;
  const request = revision;
  const data = await store.loadMonth(target);
  if (target !== month || request !== revision) throw new Error('資料讀取期間有變更，稍後重試');
  if (JSON.stringify(data.items) === JSON.stringify(items)) return false;
  revision++;
  items = data.items;
  notify();
  return true;
}

/**
 * 改紀錄。fn 直接改傳入的陣列；回傳 false 代表取消，不會寫入。
 * 撞到 409 就重讀重試，最多三次。
 */
export const mutate = (fn) => mutateMonth(month, fn);

/** 改任一個月份的紀錄，和本月的寫入排在同一個佇列。 */
export function mutateMonth(target, fn) {
  const operation = writes.then(() => writeMutation(target, fn));
  writes = operation.catch(() => {});
  return operation;
}

async function writeMutation(target, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await store.loadMonth(target);
    const draft = structuredClone(fresh.items);
    if (fn(draft) === false) return false;
    try {
      await store.saveMonth(target, draft, fresh.sha);
      if (month === target) {
        revision++;
        items = draft;
        notify();
      }
      return true;
    } catch (err) {
      if (!err.conflict) throw err;
    }
  }
  throw new Error('另一支手機正在修改，請稍後再試一次');
}

/** 新增一筆，存進日期所在的月份。呼叫端必須給 date、amount、category、by、type。 */
export const add = (entry) => {
  const record = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  return mutateMonth(entry.date.slice(0, 7), (list) => list.push(record));
};

/** 依 id 移除或更新；找不到回傳 false。 */
export const remove = (id) => mutate((list) => {
  const i = list.findIndex((it) => it.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
});

export async function update(id, patch) {
  const from = month;
  const target = patch.date?.slice(0, 7) ?? from;
  if (target === from) {
    return mutateMonth(from, (list) => {
      const it = list.find((x) => x.id === id);
      if (!it) return false;
      Object.assign(it, patch);
    });
  }
  // 日期改到別的月份：先寫進新月份再從原月份移除，中途失敗頂多多一筆，不會遺失。
  const it = items.find((x) => x.id === id);
  if (!it) return false;
  const moved = { ...structuredClone(it), ...patch };
  await mutateMonth(target, (list) => list.push(moved));
  const removed = await mutateMonth(from, (list) => {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
  });
  // 原紀錄已被另一支手機刪掉：撤回剛寫進新月份的那筆。
  if (!removed) {
    await mutateMonth(target, (list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
    });
  }
  return removed;
}
