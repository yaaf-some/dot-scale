// Brew: STUB. The method → recipe → prep → live → result flow (PRODUCT.md §3-4) is built by another worker.
// Until then this shows the live scale readout so the scale stays usable, and answers "Brew again" taps.
// Replace mount() wholesale; keep `export const meta`.
import { h, fmtTime } from '../dom.js';
import { emptyState } from '../components.js';
import { scaleLine } from '../scale-line.js';
import { methodById } from '../labels.js';

export const meta = { title: 'Brew' };

export function mount(root, ctx) {
  const { scale } = ctx;
  const method = ctx.params[0] ? methodById(ctx.params[0]) : null;

  const weight = h('div', { class: 'weight', 'data-testid': 'weight' });
  const flow = h('b', {}, '0.0'), time = h('b', {}, '0:00');
  const start = h('button', { class: 'btn big', type: 'button', onclick: () => (scale.state.timerRunning ? scale.timer.pause() : scale.timer.start()) }, 'Start');
  const tare = h('button', { class: 'btn big', type: 'button', onclick: () => scale.tare() }, 'Tare');
  const reset = h('button', { class: 'btn big', type: 'button', onclick: () => scale.timer.reset() }, 'Reset');
  const live = h('div', {},
    h('div', { class: 'readout', 'aria-label': 'Live weight' }, weight,
      h('div', { class: 'readout-stats' }, h('span', {}, time, 'time'), h('span', {}, flow, 'g/s'))),
    h('div', { class: 'live-actions' }, tare, start, reset));
  const none = emptyState({
    iconName: 'brew', title: 'Connect your scale to brew',
    text: 'Live weight, time and flow appear here as soon as the scale is connected.',
    actions: [],
  });

  const paint = () => {
    const s = scale.state, on = s.status === 'connected';
    live.hidden = !on; none.hidden = on;
    weight.className = `weight${s.overload ? ' over' : ''}`;
    weight.replaceChildren(s.grams.toFixed(1), h('small', {}, 'g'));
    flow.textContent = s.flow.toFixed(1);
    time.textContent = fmtTime(s.seconds);
    start.textContent = s.timerRunning ? 'Pause' : 'Start';
    for (const b of [tare, start, reset]) b.disabled = !on;
  };
  scale.on('weight', paint, { signal: ctx.signal });
  scale.on('status', paint, { signal: ctx.signal });
  scale.on('timer', paint, { signal: ctx.signal });
  paint();

  root.append(
    h('div', { class: 'view-head' }, h('h1', {}, method ? `Brew ${method.name.toLowerCase()}` : 'Brew')),
    scaleLine(ctx), none, live,
    h('p', { class: 'section-note' }, 'Guided brewing is on its way: pick a method, check the recipe, and a hands-free live screen with one takeaway at the end. For now this is the scale’s live readout.'));
}
