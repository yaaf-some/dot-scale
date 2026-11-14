// Step 1: pick a method. Large tiles, the profile's most recently used first.
import { h, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { ago } from '../components.js';
import { getMethod } from '../../methods/index.js';
import { methodOrder } from '../../core/brew-record.js';

export function renderPicker(root, ctx, { brews }) {
  const mine = brews.filter((b) => b.profileId === ctx.profile?.id);
  const order = methodOrder(ctx.profile, mine);
  const last = (id) => mine.filter((b) => b.method === id).sort((a, b) => b.startedAt - a.startedAt)[0];
  const tile = (id, i) => {
    const m = getMethod(id);
    const b = last(id);
    const sub = b ? `Last: ${fmtG(b.dose, 1)} → ${fmtG(b.targetYield ?? b.yield)} g · ${ago(b.startedAt)}` : `Starts at ${fmtG(m.defaults.dose, 1)} → ${fmtG(m.defaults.yield)} g`;
    return h('a', { class: 'method-tile', href: `#/brew/${id}`, 'data-method': id, 'data-first': i === 0 ? '' : undefined },
      h('span', { class: 'method-art' }, icon(m.icon, { size: 36 })),
      h('span', { class: 'method-name' }, m.name),
      h('span', { class: 'method-sub' }, sub));
  };
  root.append(
    h('div', { class: 'view-head' }, h('h1', {}, 'What are you brewing?')),
    h('p', { class: 'section-note' }, ctx.profile ? `Your most recent first, ${ctx.profile.name}.` : 'Pick a method.'),
    h('nav', { class: 'method-tiles', 'aria-label': 'Brew methods' }, order.map(tile)));
}
