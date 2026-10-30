// 選項少的下拉選單改成一排按鈕，點一下就選好。原本的 select 留著保存值與事件（藏在按鈕後面），
// 程式照常讀寫 select.value、監聽 change；選項或值改變時按鈕跟著更新。
const MAX = 5;
const valueOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function draw(select, group) {
  const options = [...select.options];
  group.hidden = options.length > MAX;
  select.classList.toggle('choice-source', !group.hidden);
  if (group.hidden) return;
  group.style.gridTemplateColumns = `repeat(${options.length}, minmax(0, 1fr))`;
  group.replaceChildren(...options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `seg-btn${option.selected ? ' is-on' : ''}`;
    button.textContent = option.textContent;
    button.dataset.value = option.value;
    button.disabled = select.disabled || option.disabled;
    button.setAttribute('aria-pressed', String(option.selected));
    return button;
  }));
}

/** 把 select 換成按鈕；選項超過 5 個時維持下拉選單。重複呼叫不會重複加。 */
export function asButtons(select) {
  if (!select || select.dataset.choices) return;
  select.dataset.choices = 'on';
  const group = document.createElement('div');
  group.className = 'seg choice';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label, .field')?.querySelector('.field-label')?.textContent || '');
  select.after(group);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const redraw = () => draw(select, group);
  group.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button || button.disabled || select.disabled) return;
    if (select.value !== button.dataset.value) {
      select.value = button.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    group.querySelector(`[data-value="${CSS.escape(button.dataset.value)}"]`)?.focus();
  });
  select.addEventListener('change', redraw);
  // 程式直接改 select.value、換選項或停用時也要更新按鈕。
  Object.defineProperty(select, 'value', { configurable: true, get() { return valueOf.get.call(this); }, set(v) { valueOf.set.call(this, v); redraw(); } });
  new MutationObserver(redraw).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  redraw();
}

/** 把容器裡標了 data-choices 的 select 都換成按鈕。 */
export function enhance(root) {
  for (const select of root.querySelectorAll('select[data-choices="auto"]')) {
    select.removeAttribute('data-choices');
    asButtons(select);
  }
}
