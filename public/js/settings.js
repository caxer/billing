// 設定：分類、人物、每月額度。
// 私人 repo 的 settings.json 是真正來源；public/settings.json 只是首次寫入前的預設值。

import * as store from './store.js';
import { upgradeSettings } from './billing.js';

let current = null;
let writes = Promise.resolve();

export async function load() {
  const { settings } = await store.loadSettings();

  if (settings) {
    current = upgradeSettings(settings);
    return current;
  }

  const res = await fetch('settings.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('無法讀取預設設定');
  current = upgradeSettings(await res.json());
  // 第一次使用：把預設值寫進私人 repo，之後兩邊共用同一份
  try {
    await store.saveSettings(current, null);
  } catch (err) {
    if (!err.conflict) throw err;
    current = upgradeSettings((await store.loadSettings()).settings || current);
  }
  return current;
}

export function all() {
  return current;
}

export function people() {
  return current?.people || [];
}

export function categories(type) {
  return (type === 'income' ? current?.incomeCategories : current?.expenseCategories) || [];
}

/** 某人某個月的支出上限；該月沒單獨設定就用這個人的 default。沒設定回傳 0。 */
export function budgetFor(person, month) {
  const per = current?.budgets?.[person];
  return Number(per?.[month] ?? per?.default ?? 0);
}

/**
 * 改設定後存檔。存之前先重讀一次 sha：
 * 設定在這支手機、其他手機或後台都可能改過，沿用舊 sha 一定會 409。
 */
export function save(mutator) {
  const operation = writes.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await store.loadSettings();
      const next = upgradeSettings(fresh.settings || current);
      mutator(next);
      try {
        await store.saveSettings(next, fresh.sha);
        current = next;
        return;
      } catch (err) {
        if (!err.conflict) throw err;
      }
    }
    throw new Error('另一支手機正在修改設定，請稍後再試一次');
  });
  writes = operation.catch(() => {});
  return operation;
}
