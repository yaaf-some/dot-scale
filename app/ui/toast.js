// Toasts live in a polite live region so screen readers announce them. One at a time; a new one replaces the old.
// Enter/exit animation is CSS (data-leaving); see motion.js leave().
import { h } from './dom.js';
import { leave } from './motion.js';

let timer;
export function toast(message, { action, ms = 4000 } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  clearTimeout(timer);
  const dismiss = () => { const el = region.firstElementChild; if (el) leave(el, () => el.remove()); };
  region.replaceChildren(h('div', { class: 'toast' },
    h('span', {}, message),
    action ? h('button', { class: 'toast-action', onclick: () => { region.replaceChildren(); action.onClick(); } }, action.label) : null));
  timer = setTimeout(dismiss, ms);
}
