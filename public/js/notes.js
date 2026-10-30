// 記事（換濾心之類）：不記金額與分類，全部放在 notes.json。寫入一律走 mutate()，兩支手機可能同時改。

import * as store from './store.js';

let items = [];
const listeners = new Set();
let writes = Promise.resolve();

export const all = () => items;

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next) {
  if (JSON.stringify(next) === JSON.stringify(items)) return false;
  items = next;
  for (const fn of listeners) fn(items);
  return true;
}

/** 重讀雲端記事；內容有變回傳 true。 */
export async function load() {
  return set((await store.loadNotes()).items);
}

/** fn 直接改傳入的陣列；回傳 false 代表取消。撞到 409 就重讀重試，最多三次。 */
export function mutate(fn) {
  const operation = writes.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await store.loadNotes();
      const draft = structuredClone(fresh.items);
      if (fn(draft) === false) return false;
      try {
        await store.saveNotes(draft, fresh.sha);
        set(draft);
        return true;
      } catch (err) {
        if (!err.conflict) throw err;
      }
    }
    throw new Error('另一支手機正在修改，請稍後再試一次');
  });
  writes = operation.catch(() => {});
  return operation;
}

/** 新增一筆：呼叫端給 date、note、by。 */
export const add = (entry) =>
  mutate((list) => list.push({ ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() }));

export const update = (id, patch) => mutate((list) => {
  const it = list.find((x) => x.id === id);
  if (!it) return false;
  Object.assign(it, patch);
});

export const remove = (id) => mutate((list) => {
  const i = list.findIndex((it) => it.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
});
