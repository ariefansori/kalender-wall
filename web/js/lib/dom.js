export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

let toastHost = null;

export function showToast(message, { type = 'info', timeout = 6000 } = {}) {
  toastHost = toastHost || document.getElementById('toasts');
  if (!toastHost) return;
  const toast = el(
    'div',
    { class: `toast toast-${type}` },
    el('span', { class: 'toast-mark' }),
    el('p', { class: 'toast-text' }, message),
    el(
      'button',
      { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss' },
      '×',
    ),
  );
  const remove = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  toastHost.append(toast);
  if (timeout) setTimeout(remove, timeout);
  return toast;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function debounce(fn, wait = 120) {
  let handle = null;
  const debounced = (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(handle);
  return debounced;
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.classList.add('is-busy');
    if (label) button.textContent = label;
  } else {
    button.disabled = false;
    button.classList.remove('is-busy');
    if (button.dataset.label) button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
}
