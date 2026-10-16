// 用 Claude 從一句話、收據照片或「內容」判斷一筆帳：收支、金額、日期、內容與分類。
// 參考 teacher：瀏覽器直接用官方 SDK 呼叫，API key 來自專屬連結解開的 secret.json，只放記憶體。
import Anthropic from './vendor/anthropic-sdk.js';

export const MODEL = 'claude-opus-5-5';
// 拒答時由伺服器自動改用其他模型重跑同一個請求。
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

let client = null;

export function setKey(apiKey) {
  client = apiKey ? new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) : null;
}

export const available = () => !!client;

const SYSTEM = `你幫一個台灣家庭記帳。使用者會給你一句話、一張收據或發票照片，或只是一筆帳的「內容」，請判斷這一筆帳。

家庭：老公、老婆，女兒叫誼（也寫作妹、姊、姐），兒子叫叡。
分類的大項：
- 房：房貸還款、管理費、火險、房屋稅、地價稅、網路，以及家裡的大型用品與旅遊（房／其他）。
- 女兒、兒子：孩子的美語、安親班、補習班、註冊費、班費、保險、課照等；寫明誼或叡才放到該孩子。
- 水電氣：電費、水費、燃氣（由土銀扣款）。
- 日常：餐飲、交通、採買、娛樂、醫藥、其他。
請從使用者提供的分類清單選一個；看不出來就選「其他」。以前的紀錄若有相同或相似的內容，優先沿用它的分類。

欄位：
- type：expense（支出）或 income（收入）。
- amount：新台幣整數元；收據寫的是實付總額；看不出來填 0。
- date：YYYY-MM-DD；「今天」「昨天」「上週五」依使用者給的今天日期推算；收據上的日期照印的寫（民國年要換成西元）；沒提到填空字串。
- note：簡短內容，例如店名或品項（全聯、麥當勞、誼保險），不要重複金額與日期。
- category：分類清單裡的一個。`;

const schema = (categories) => ({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['expense', 'income'] },
    amount: { type: 'integer' },
    date: { type: 'string' },
    note: { type: 'string' },
    category: { type: 'string', enum: categories },
  },
  required: ['type', 'amount', 'date', 'note', 'category'],
  additionalProperties: false,
});

const fail = (message) => new Error(message);

function apiFailure(e) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return fail('Claude API key 已經失效，請在電腦重新執行 npm run setup:ai 並發布。');
  if (e instanceof Anthropic.NotFoundError) return fail(`這個 API key 不能使用 ${MODEL}。`);
  if (e instanceof Anthropic.RateLimitError) return fail('Claude 的用量暫時滿了，請過一會兒再試。');
  if (e instanceof Anthropic.BadRequestError) return fail(`Claude 不接受這次的請求：${e.error?.error?.message || e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return fail('連不到 Claude，請確認網路後再試一次。');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 402) return fail('Claude API 帳戶的額度或付款有問題。');
    if (e.status === 529 || e.status >= 500) return fail('Claude 現在很忙，請過一會兒再試。');
    return fail(`Claude 回應錯誤（${e.status}），請再試一次。`);
  }
  return e;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('照片讀取失敗'));
    reader.readAsDataURL(blob);
  });
}

/** 檢查 Claude 回來的欄位；不合格的欄位改成 null，交給表單保留原值。 */
export function normalizeEntry(value, categories) {
  if (!value || typeof value !== 'object') throw fail('Claude 沒有回傳可用的結果，請再試一次。');
  const date = typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : null;
  return {
    type: value.type === 'income' ? 'income' : 'expense',
    amount: Number.isSafeInteger(value.amount) && value.amount > 0 ? value.amount : null,
    date,
    note: typeof value.note === 'string' ? value.note.trim().slice(0, 60) : '',
    category: categories.includes(value.category) ? value.category : null,
  };
}

/**
 * 判斷一筆帳。text 是一句話或內容，image 是收據照片 { data, mediaType }（base64）。
 * categories 是可選的支出與收入分類，history 是最近的 { note, category } 供參考。
 */
export async function parseEntry({ text = '', image = null, categories, history = [], today, signal }) {
  if (!client) throw fail('還沒有設定 Claude API key。');
  const all = [...new Set([...categories.expense, ...categories.income])];
  const examples = history.length ? `以前的紀錄（內容 → 分類）：\n${history.map((h) => `${h.note} → ${h.category}`).join('\n')}\n\n` : '';
  const prompt = `今天是 ${today}。\n支出分類：${categories.expense.join('、')}\n收入分類：${categories.income.join('、')}\n\n${examples}${
    image ? '請看這張收據或發票照片，判斷這一筆帳。' : `請判斷這一筆帳：${text}`}`;
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }, { type: 'text', text: prompt }]
    : prompt;
  let message;
  try {
    message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      ...FALLBACK,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: schema(all) } },
      messages: [{ role: 'user', content }],
    }, { signal });
  } catch (e) { throw apiFailure(e); }
  if (message.stop_reason === 'refusal') throw fail('Claude 無法判斷這一筆，請手動填寫。');
  if (message.stop_reason === 'max_tokens') throw fail('Claude 的回覆被截斷，請再試一次。');
  const block = message.content.find((b) => b.type === 'text');
  let value;
  try { value = JSON.parse(block?.text || ''); } catch { throw fail('Claude 沒有回傳可用的結果，請再試一次。'); }
  const entry = normalizeEntry(value, all);
  // 收入分類只配收入，支出分類只配支出。
  if (entry.category && !categories[entry.type].includes(entry.category)) entry.category = null;
  return entry;
}
