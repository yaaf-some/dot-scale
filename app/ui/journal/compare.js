// Compare: overlay two brews' curves.
import { h, append, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { section, segmented } from '../components.js';
import { methodById } from '../labels.js';
import { curveOf, ratioText, stars, grindText } from '../../journal/history.js';
import { curveCanvas } from './chart.js';
import { starsNode, timeText, shortDate, clock } from './shared.js';
import { brewTitle } from './list.js';

export async function mount(root, ctx, idA, idB) {
  const { store } = ctx;
  const [a, b, beans] = await Promise.all([store.get(idA), store.get(idB), store.list('bean')]);
  const back = h('a', { class: 'back', href: a ? `#/journal/brew/${encodeURIComponent(idA)}` : '#/journal' }, icon('back', { size: 20 }), a ? 'Back to brew' : 'Journal');
  if (!a || !b) {
    append(root, [back, h('div', { class: 'empty' }, h('h2', {}, 'Can’t compare these'), h('p', {}, 'One of the brews is gone. It may have been deleted on another device.'), h('a', { class: 'btn primary', href: '#/journal' }, 'Back to Journal'))]);
    return;
  }
  ctx.setTitle('Compare');
  const names = [a, b].map((x) => `${brewTitle(x, beans)}, ${shortDate(x.startedAt)} ${clock(x.startedAt)}`);
  const curves = [curveOf(a), curveOf(b)];
  let mode = 'weight';
  const stage = h('div', { class: 'section' });

  const paint = () => {
    const series = curves.map((c, i) => c && { curve: c, channel: mode, color: i ? 'crema' : 'cobalt', dash: !!i, width: 2.5 }).filter(Boolean);
    const missing = curves.map((c, i) => (c ? null : names[i])).filter(Boolean);
    stage.replaceChildren(
      series.length
        ? h('figure', { class: 'chart' }, curveCanvas(series, { label: `${mode === 'weight' ? 'Weight' : 'Flow'} curves of two brews overlaid.`, signal: ctx.signal }),
          h('ul', { class: 'legend' }, h('li', {}, h('span', { class: 'swatch' }), `A: ${names[0]}`), h('li', {}, h('span', { class: 'swatch b' }), `B: ${names[1]}`)))
        : null,
      missing.length ? h('p', { class: 'note' }, series.length ? `No curve was recorded for ${missing.join(' and ')}, so only the other one is drawn.` : 'Neither brew has a curve, so here are the numbers side by side.') : null);
  };
  paint();

  const rows = [
    ['Date', (x) => `${shortDate(x.startedAt)} ${clock(x.startedAt)}`],
    ['Method', (x) => methodById(x.method).name],
    ['Dose', (x) => `${fmtG(x.dose, 1)} g`], ['Yield', (x) => `${fmtG(x.yield, 1)} g`], ['Ratio', (x) => ratioText(x) || '–'],
    ['Time', (x) => timeText(x.timeS)], ['Grind', (x) => grindText(x) || '–'], ['Stars', (x) => starsNode(stars(x)) ?? '–'],
  ];
  const differs = (label, f) => ['Date'].includes(label) ? false : String(f(a).textContent ?? f(a)) !== String(f(b).textContent ?? f(b));
  append(root, [
    back,
    h('h1', {}, 'Compare'),
    segmented({ label: 'Curve', value: mode, options: [{ value: 'weight', label: 'Weight' }, { value: 'flow', label: 'Flow' }], onchange: (v) => { mode = v; paint(); } }),
    stage,
    section('Side by side', h('table', { class: 'cmp' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')), h('th', { scope: 'col' }, 'A'), h('th', { scope: 'col' }, 'B'))),
      h('tbody', {}, rows.map(([label, f]) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', { class: differs(label, f) ? 'diff' : '' }, f(a)), h('td', { class: differs(label, f) ? 'diff' : '' }, f(b)))))), { id: 'numbers' }),
  ]);
}
