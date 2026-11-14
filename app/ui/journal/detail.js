// One brew: curve, metrics, verdict + tips (recomputed with analyze() so engine improvements reach old brews), taste, notes, actions.
import { h, append, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { section } from '../components.js';
import { formDialog, confirmDialog } from '../dialog.js';
import { methodById } from '../labels.js';
import { analyze } from '../../insights/analyze.js';
import { getCard } from '../../learn/cards.js';
import { curveOf, ratioText, stars, beanOf, grindText, filterBrews } from '../../journal/history.js';
import { curveCanvas } from './chart.js';
import { starsNode, timeText, fullDate, clock, shortDate, BALANCE, STRENGTH, cardHref } from './shared.js';
import { brewTitle } from './list.js';

const metric = (label, value, unit) => (value === null || value === undefined || value === '' ? null
  : h('div', { class: 'metric' }, h('dt', {}, label), h('dd', {}, value, unit ? h('small', {}, unit) : null)));
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : null);

export function analysisFor(brew, beans, brews) {
  try {
    return analyze(brew, { method: brew.method, bean: beanOf(beans, brew), history: filterBrews(brews, { profileId: brew.profileId }) });
  } catch (e) { console.warn('analyze failed for', brew.id, e); return null; }
}

function metricsGrid(b, a) {
  const m = a?.metrics ?? {};
  const rows = [
    metric('Dose', num(b.dose), 'g'), metric('Yield', num(b.yield), 'g'), metric('Ratio', ratioText(b) || null), metric('Time', timeText(b.timeS)),
    b.method === 'espresso' ? metric('First drops', m.firstDropS != null ? timeText(m.firstDropS) : null) : null,
    metric('Average flow', m.mainAvgFlow != null ? num(m.mainAvgFlow) : null, 'g/s'),
    metric('Drip after stop', m.dripAfterStopG != null ? num(m.dripAfterStopG) : null, 'g'),
    metric('Drawdown', m.drawdownS != null ? timeText(m.drawdownS) : null),
    metric('Grind', grindText(b) || null), metric('Water', b.tempC != null ? num(b.tempC, 0) : null, '°C'),
  ].filter(Boolean);
  return h('dl', { class: 'metrics' }, rows);
}

function insightBlock(a) {
  if (!a || (!a.verdict && !a.tips?.length)) return null;
  const [top, ...rest] = a.tips ?? [];
  const shownCards = new Set((a.tips ?? []).slice(0, 3).map((t) => t.learnCard)); // those already have a link under their tip
  const learnIds = [...new Set((a.learn ?? []).filter((id) => getCard(id) && !shownCards.has(id)))];
  const tipNode = (t, withLink = true) => h('div', { class: 'tip' },
    h('h3', {}, t.title), t.change ? h('p', { class: 'change' }, t.change) : null, t.why ? h('p', { class: 'sub' }, t.why) : null,
    withLink && getCard(t.learnCard) ? h('a', { class: 'link', href: cardHref(t.learnCard) }, `Learn: ${getCard(t.learnCard).title}`) : null);
  return section('What happened', [
    a.verdict ? h('p', { class: 'verdict' }, a.verdict) : null,
    top ? tipNode(top) : null,
    rest.length ? h('details', { class: 'more-tips' }, h('summary', {}, 'More ideas'), rest.slice(0, 2).map((t) => tipNode(t))) : null,
    learnIds.length ? h('div', { class: 'chips', 'aria-label': 'Related lessons' }, learnIds.slice(0, 4).map((id) => h('a', { class: 'pill', href: cardHref(id) }, getCard(id).title))) : null,
  ], { id: 'insight', note: 'Worked out again each time you open this brew, so it improves as the app does.' });
}

function tasteBlock(b) {
  const t = b.taste;
  if (!t || (stars(b) == null && t.balance == null && t.strength == null && !t.spurts)) return h('p', { class: 'sub' }, 'No taste noted yet. Tap Edit to add stars and how it tasted.');
  return h('div', { class: 'taste' },
    starsNode(stars(b)),
    Number.isFinite(t.balance) ? h('span', { class: `pill ${t.balance === 0 ? 'good' : 'warn'}` }, BALANCE[t.balance] ?? `Balance ${t.balance}`) : null,
    Number.isFinite(t.strength) ? h('span', { class: `pill ${t.strength === 0 ? 'good' : ''}` }, STRENGTH[t.strength] ?? `Strength ${t.strength}`) : null,
    t.spurts ? h('span', { class: 'pill warn' }, 'Spurts') : null);
}

const choice = (label, values, labels) => ({ label, options: [{ value: '', label: '–' }, ...values.map((v) => ({ value: String(v), label: labels[v] ?? String(v) }))] });

async function editBrew(ctx, brew, beans) {
  const t = brew.taste ?? {};
  const str = (v) => (Number.isFinite(v) ? String(v) : '');
  const res = await formDialog({
    title: 'Edit brew', submitLabel: 'Save',
    fields: [
      { name: 'stars', type: 'choice', ...choice('Stars', [1, 2, 3, 4, 5], {}) },
      { name: 'balance', type: 'choice', ...choice('Taste', [-2, -1, 0, 1, 2], BALANCE) },
      { name: 'strength', type: 'choice', ...choice('Strength', [-2, -1, 0, 1, 2], STRENGTH) },
      { name: 'beanId', type: 'select', label: 'Beans', options: [{ value: '', label: 'No beans noted' }, ...beans.filter((x) => !x.archived || x.id === brew.beanId).map((x) => ({ value: x.id, label: x.name }))] },
      { name: 'grindText', type: 'text', label: 'Grind (words)', maxlength: 60 },
      { name: 'grindValue', type: 'number', label: 'Grind (number)', step: 'any', inputMode: 'decimal' },
      { name: 'notes', type: 'textarea', label: 'Notes', maxlength: 2000 },
    ],
    values: { stars: str(t.stars), balance: str(t.balance), strength: str(t.strength), beanId: brew.beanId ?? '', grindText: brew.grind?.text ?? '', grindValue: brew.grind?.value ?? '', notes: brew.notes ?? '' },
  });
  if (!res) return false;
  const next = { ...brew };
  const taste = { ...t };
  for (const k of ['stars', 'balance', 'strength']) { if (res[k] === '' || res[k] === undefined) delete taste[k]; else taste[k] = Number(res[k]); }
  if (Object.keys(taste).length) next.taste = taste; else delete next.taste;
  if (res.beanId) next.beanId = res.beanId; else delete next.beanId;
  const grind = { ...(brew.grind ?? {}) };
  if (res.grindText) grind.text = res.grindText; else delete grind.text;
  if (Number.isFinite(res.grindValue)) grind.value = res.grindValue; else delete grind.value;
  if (Object.keys(grind).length) next.grind = grind; else delete next.grind;
  if (res.notes) next.notes = res.notes; else delete next.notes;
  await ctx.store.put(next);
  return true;
}

async function chooseOther(ctx, brew, brews, beans) {
  const others = brews.filter((b) => b.id !== brew.id && !b.deleted && !b.incomplete && b.profileId === brew.profileId)
    .sort((a, b) => (b.method === brew.method) - (a.method === brew.method) || (b.beanId === brew.beanId) - (a.beanId === brew.beanId) || b.startedAt - a.startedAt).slice(0, 40);
  if (!others.length) { ctx.toast('You need a second brew to compare.'); return; }
  const res = await formDialog({
    title: 'Compare with…', submitLabel: 'Compare',
    fields: [{ name: 'other', type: 'select', label: 'Other brew', options: others.map((b) => ({ value: b.id, label: `${shortDate(b.startedAt)} · ${brewTitle(b, beans)} · ${num(b.dose)} → ${num(b.yield, 0)} g` })) }],
    values: { other: others[0].id },
  });
  if (res?.other) ctx.navigate(`/journal/compare/${encodeURIComponent(brew.id)}/${encodeURIComponent(res.other)}`);
}

export async function mount(root, ctx, id) {
  const { store } = ctx;
  const [brew, beans, brews, profiles] = await Promise.all([store.get(id), store.list('bean'), store.list('brew'), store.list('profile')]);
  const back = h('a', { class: 'back', href: '#/journal' }, icon('back', { size: 20 }), 'Journal');
  if (!brew || brew.type !== 'brew') {
    append(root, [back, h('div', { class: 'empty' }, h('h2', {}, 'Brew not found'), h('p', {}, 'It may have been deleted on another device.'), h('a', { class: 'btn primary', href: '#/journal' }, 'Back to Journal'))]);
    return;
  }
  const m = methodById(brew.method);
  const bean = beanOf(beans, brew);
  const owner = profiles.find((p) => p.id === brew.profileId);
  const a = analysisFor(brew, beans, brews);
  const curve = curveOf(brew);
  ctx.setTitle(brewTitle(brew, beans));

  let chart = null;
  if (curve) {
    const stats = [`${num(brew.dose)} g in, ${num(brew.yield)} g out`, `${timeText(brew.timeS)}`].join(', ');
    const canvas = curveCanvas([
      { curve, channel: 'flow', color: 'crema', axis: 'right', width: 1.75 },
      { curve, channel: 'weight', color: 'cobalt', axis: 'left', width: 2.75 },
    ], { target: brew.targetYield > 0 && brew.targetYield !== brew.yield ? brew.targetYield : undefined, stopS: brew.timeS > 0 ? brew.timeS : undefined,
      label: `Weight and flow curve. ${stats}.`, signal: ctx.signal });
    chart = h('figure', { class: 'chart' }, canvas,
      h('ul', { class: 'legend' }, h('li', {}, h('span', { class: 'swatch' }), 'Weight (g)'), h('li', {}, h('span', { class: 'swatch flow' }), 'Flow (g/s, right axis)'),
        brew.targetYield > 0 && brew.targetYield !== brew.yield ? h('li', {}, h('span', { class: 'swatch target' }), `Target ${fmtG(brew.targetYield)} g`) : null));
  }

  append(root, [
    back,
    h('header', { class: 'section' },
      h('h1', {}, brewTitle(brew, beans)),
      h('p', { class: 'sub' }, [m.name, fullDate(brew.startedAt), clock(brew.startedAt), owner?.name].filter(Boolean).join(' · '), ' ', brew.legacy ? h('span', { class: 'tag' }, 'Earlier app') : null, brew.incomplete ? h('span', { class: 'tag', 'data-testid': 'interrupted-tag' }, 'Interrupted') : null)),
    brew.incomplete ? h('p', { class: 'note' }, 'This brew was interrupted before it finished, so the numbers cover only the part that ran. It is left out of the dial-in trail and gets no advice.') : null,
    metricsGrid(brew, a),
    chart ?? h('p', { class: 'note' }, brew.legacy
      ? 'This brew was saved by the earlier version of Dot Scale, so there is no curve or taste, only the totals.'
      : 'No curve was recorded for this brew, so only the totals are shown.'),
    insightBlock(a),
    section('Taste', tasteBlock(brew), { id: 'taste' }),
    brew.notes ? section('Notes', h('p', { class: 'notes' }, brew.notes), { id: 'notes' }) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => { if (await editBrew(ctx, brew, beans)) ctx.navigate(`/journal/brew/${encodeURIComponent(brew.id)}`); } }, 'Edit'),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => chooseOther(ctx, brew, brews, beans) }, 'Compare…'),
      bean ? h('a', { class: 'btn secondary', href: `#/journal/bean/${encodeURIComponent(bean.id)}?${new URLSearchParams({ method: brew.method, profile: brew.profileId ?? '' })}` }, 'Dial-in trail') : null,
      brew.incomplete ? null : h('a', { class: 'btn secondary', href: `#/brew/${encodeURIComponent(brew.method)}?brew=${encodeURIComponent(brew.id)}` }, 'Brew again'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog({ title: 'Delete this brew?', message: 'It will be removed from this device and the household.', confirmLabel: 'Delete', danger: true }))) return;
        const copy = brew;
        await store.delete(brew.id);
        ctx.navigate('/journal', { replace: true });
        ctx.toast('Brew deleted', { action: { label: 'Undo', onClick: () => store.put(copy) } });
      } }, 'Delete')),
  ]);
}
