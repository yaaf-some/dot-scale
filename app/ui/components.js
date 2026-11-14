// Small shared building blocks. Views compose these so the design stays consistent; styles live in app.css.
import { h } from './dom.js';
import { icon } from './icons.js';

export function avatar(profile, { large = false } = {}) {
  return h('span', { class: `avatar${large ? ' lg' : ''}`, style: { '--disc': profile?.color || 'var(--cobalt)' }, 'aria-hidden': 'true' }, profile?.emoji || '☕');
}

/** A titled section. `note` is small supporting text under the heading. */
export function section(title, children, { note, id } = {}) {
  return h('section', { class: 'section', id, 'aria-labelledby': id ? `${id}-h` : undefined },
    title ? h('h2', { id: id ? `${id}-h` : undefined }, title) : null, note ? h('p', { class: 'section-note' }, note) : null, children);
}

/** Inset list container. */
export const group = (...rows) => h('div', { class: 'group' }, rows);

/** One list row. If `onclick` is given the whole row is a button. */
export function row({ title, sub, lead, end, onclick, className = '' }) {
  const body = [lead, h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'row-sub' }, sub) : null), end ? h('div', { class: 'row-end' }, end) : null];
  return onclick ? h('button', { class: `row ${className}`, type: 'button', onclick }, body) : h('div', { class: `row ${className}` }, body);
}

export const emptyRow = (text) => h('div', { class: 'row empty-row' }, text);

export function switchRow({ title, sub, checked, onchange }) {
  const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked, onchange: () => onchange(input.checked) });
  return h('label', { class: 'row switch-row' }, h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'row-sub' }, sub) : null), input);
}

/** Segmented control. options: [{ value, label }]. */
export function segmented({ label, options, value, onchange }) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const paint = (v) => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
  for (const o of options) wrap.append(h('button', { type: 'button', dataset: { value: o.value }, onclick: () => { paint(o.value); onchange(o.value); } }, o.label));
  paint(value);
  return wrap;
}

/** Friendly empty state: what this is, why it's empty, and the next action. */
export function emptyState({ iconName, title, text, actions = [] }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'art' }, icon(iconName, { size: 32 })),
    h('h2', {}, title), text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'chip-group' }, actions) : null);
}

/** Re-render a block when records of the given types change. build() returns a Node (or a promise of one). */
export function liveBlock(ctx, types, build) {
  const box = h('div', { class: 'live-block' });
  let n = 0;
  const paint = async () => { const mine = ++n; const node = await build(); if (mine === n && box.isConnected !== false) box.replaceChildren(node); };
  paint();
  ctx.store.on('change', (e) => { if (types.includes(e.type)) paint(); }, { signal: ctx.signal });
  return box;
}

export function ago(ts, now = Date.now()) {
  const d = Math.floor((now - ts) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
}
