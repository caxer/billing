// 名稱規則：拆關鍵字、模糊比對、別名與關鍵字分類。手機記帳與本機整理工具（scripts/tidy）共用。
// 規則存在雲端設定 settings.rules = { aliases: [{ from, to, prefix }], keywords: [{ word, category }] }，兩支手機一起用。

/** 數量、單位、價錢與算式：比對與拆關鍵字時忽略。 */
const QUANTITY = /\d+(?:\.\d+)?\s*(?:包|顆|瓶|箱|片|個|入|條|件|雙|盒|罐|串|公斤|kg|斤|元|塊|碗|份|杯|袋|捲|支|張|組|台|堂|天份|天|人|次|小時|本|套|粒|籃|打)|[*×xX]\s*\d+|\$\s*\d+|\d+%|\d+(?:[/+\-~]\d+)+|\d+/gi;
const PUNCT = /[\s，、。,.;；:：()（）[\]【】「」『』"'!！?？~～\-_/\\+*×#=&|]+/g;
/** 本身含數字的店名或品項，比對與拆字時保留，不當成數量。 */
const KEEP = /7-11|10w40|3m|50嵐|85度c|18度c/gi;
const keepWords = (text, fn) => {
  // 用私用區字元當暫存記號（不含數字，不會被當成數量去掉）。
  const kept = [];
  const masked = text.replace(KEEP, (m) => { kept.push(m); return String.fromCharCode(0xE000 + kept.length - 1); });
  return fn(masked).replace(/[-]/g, (c) => kept[c.charCodeAt(0) - 0xE000]);
};

/** 名稱開頭的孩子稱呼。 */
export const KID = /^(誼|叡)/;

/** 比對用的鍵：全形轉半形、小寫、去掉數量與標點。「麻花捲14包」「麻花捲 10包」都是「麻花捲」。 */
export function normalizeKey(name) {
  return keepWords(String(name || '').normalize('NFKC').toLowerCase(), (t) => t.replace(QUANTITY, ' ').replace(PUNCT, ''));
}

/**
 * 把名稱拆成關鍵字：先依空白與標點切開、去掉數量，開頭的誼／叡獨立出來，
 * 再用詞庫由左往右找最長的詞；詞庫找不到的部分整段保留。
 */
export function tokenize(name, dictionary = new Set()) {
  const words = [...dictionary].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
  const tokens = [];
  // 數量當作分隔：「鞋墊100雞腳100」拆成鞋墊、雞腳。
  let pieces = [];
  keepWords(String(name || '').normalize('NFKC'), (t) => { pieces = t.replace(QUANTITY, ' ').split(PUNCT); return ''; });
  pieces = pieces.map((p) => p.replace(/[-]/g, (c) => (String(name || '').normalize('NFKC').match(KEEP) || [])[c.charCodeAt(0) - 0xE000] || ''));
  for (const raw of pieces) {
    let part = raw.trim();
    if (!part) continue;
    const kid = KID.exec(part);
    if (kid && part.length > 1) { tokens.push(kid[1]); part = part.slice(1); }
    let rest = '', i = 0;
    const lower = part.toLowerCase();
    while (i < part.length) {
      const hit = words.find((w) => lower.startsWith(w.toLowerCase(), i));
      if (hit) {
        if (rest) { tokens.push(rest); rest = ''; }
        tokens.push(part.slice(i, i + hit.length));
        i += hit.length;
      } else { rest += part[i]; i++; }
    }
    if (rest) tokens.push(rest);
  }
  const seen = new Set();
  return tokens.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 編輯距離（相差一兩個字判斷用）。 */
export function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/**
 * 模糊比對。groups：比對鍵相同的寫法（例如「麻花捲10包」「麻花捲 14包」）一群，標準名預設用筆數最多的；
 * pairs：比對鍵只差一個字（三個字以上）的兩群，例如楊博士／羊博士，只列成對的候選，不串連；
 * 只差開頭誼／叡的不算（那是兩個孩子）。names 是 [{ name, count }]。
 */
export function similar(names) {
  const byKey = new Map();
  for (const n of names) {
    const key = normalizeKey(n.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(n);
  }
  const clusters = [...byKey.entries()].map(([key, members]) => {
    const sorted = [...members].sort((x, y) => y.count - x.count);
    return { key, canonical: sorted[0].name, members: sorted, count: sorted.reduce((s, n) => s + n.count, 0) };
  });
  const groups = clusters.filter((c) => c.members.length > 1).sort((x, y) => y.count - x.count);
  const pairs = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      if (Math.min(a.key.length, b.key.length) < 3 || distance(a.key, b.key) !== 1) continue;
      if (a.key.length === b.key.length && KID.test(a.key) && KID.test(b.key) && a.key.slice(1) === b.key.slice(1)) continue;
      pairs.push(a.count >= b.count ? [a, b] : [b, a]);
    }
  }
  return { groups, pairs: pairs.sort((x, y) => y[0].count + y[1].count - x[0].count - x[1].count) };
}

/**
 * 套用別名：整個名稱相同（忽略大小寫與空白）就換成 to；prefix 的別名是店名，
 * 開頭相同時換掉店名、後面的品項保留並用空格隔開（711早餐 → 7-11 早餐）。
 */
export function applyAliases(note, aliases = []) {
  const text = String(note || '').trim();
  if (!text) return text;
  const flat = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  for (const a of aliases) if (a?.from && a.to && flat(text) === flat(a.from)) return a.to;
  const lower = text.normalize('NFKC').toLowerCase();
  const prefixes = aliases.filter((a) => a?.prefix && a.from && a.to).sort((x, y) => y.from.length - x.from.length);
  for (const a of prefixes) {
    const from = a.from.normalize('NFKC').toLowerCase();
    if (!lower.startsWith(from)) continue;
    const rest = text.normalize('NFKC').slice(from.length).trim();
    return rest ? `${a.to} ${rest}` : a.to;
  }
  return text;
}

/**
 * 輸入內容時提示以前用過的名稱，讓同樣的東西寫法一致。名稱先套用別名、只提示標準名；
 * 開頭相同的排最前，其次包含輸入的字、輸入裡包含的名稱、差一個字的，同一級筆數多的在前；和輸入一樣就不提示。
 * names 是 [{ name, count }]。
 */
export function suggestNames(input, names, aliases = [], limit = 6) {
  const flat = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(PUNCT, '');
  const q = flat(input);
  if (!q) return [];
  const counts = new Map();
  for (const n of names) {
    const name = applyAliases(n.name, aliases);
    if (name) counts.set(name, (counts.get(name) || 0) + (n.count || 1));
  }
  const ranked = [];
  for (const [name, count] of counts) {
    const key = flat(name);
    if (!key || key === q) continue;
    const rank = key.startsWith(q) ? 0 : key.includes(q) ? 1 : key.length >= 2 && q.includes(key) ? 2
      : q.length >= 3 && distance(q, key) === 1 ? 3 : -1;
    if (rank >= 0) ranked.push({ name, count, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank || b.count - a.count || a.name.length - b.name.length)
    .slice(0, limit).map((r) => r.name);
}

/** 依關鍵字規則判斷分類：名稱裡出現的最長關鍵字為準；分類不在可選清單時不回傳。 */
export function ruleCategory(note, keywords = [], allowed = []) {
  const text = String(note || '').normalize('NFKC').toLowerCase();
  if (!text) return null;
  const hit = keywords.filter((k) => k?.word && text.includes(k.word.normalize('NFKC').toLowerCase()) && allowed.includes(k.category))
    .sort((a, b) => b.word.length - a.word.length)[0];
  return hit?.category || null;
}

/** 合併新的規則：同一個 from／word 以後加的為準。 */
export function mergeRules(rules = {}, patch = {}) {
  const aliases = new Map((rules.aliases || []).map((a) => [a.from, a]));
  for (const a of patch.aliases || []) aliases.set(a.from, a);
  const keywords = new Map((rules.keywords || []).map((k) => [k.word, k]));
  for (const k of patch.keywords || []) keywords.set(k.word, k);
  for (const from of patch.removeAliases || []) aliases.delete(from);
  for (const word of patch.removeKeywords || []) keywords.delete(word);
  return { aliases: [...aliases.values()], keywords: [...keywords.values()] };
}
