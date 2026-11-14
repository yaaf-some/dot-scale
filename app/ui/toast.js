// Toasts live in a polite live region so screen readers announce them. One at a time; a new one replaces the old.
import { h } from './dom.js';

let timer;
export function toast(message, { action, ms = 4000 } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  clearTimeout(timer);
  region.replaceChildren(h('div', { class: 'toast' },
    h('span', {}, message),
    action ? h('button', { class: 'toast-action', onclick: () => { region.replaceChildren(); action.onClick(); } }, action.label) : null));
  timer = setTimeout(() => region.replaceChildren(), ms);
}
