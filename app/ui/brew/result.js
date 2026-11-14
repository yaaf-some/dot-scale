// Step 5: the result. The numbers, the curve, ONE takeaway and ONE thing to try (the top tip from analyze()), a quick taste tap.
// Save is the default action. Nothing is lost if the user walks away: the brew autosaves after 2 minutes, when the page is
// hidden, and when the view is left. The Brew record keeps `id` stable, so saving again only updates it.
import { h, append, fmtG, fmtTime } from '../dom.js';
import { icon } from '../icons.js';
import { confirmDialog } from '../dialog.js';
import { segmented } from '../components.js';
import { uuid } from '../../core/store.js';
import { buildBrew, withAnalysis, saveBrew } from '../../core/brew-record.js';
import { createChart, pointsFromSamples } from './chart.js';

export const AUTOSAVE_MS = 2 * 60 * 1000;
const BALANCE = ['Sour', 'A little sour', 'Balanced', 'A little bitter', 'Bitter'];
const STRENGTH = ['Weak', 'A little weak', 'Just right', 'A little strong', 'Strong'];

/** One row of five round buttons (value -2..2 or 1..5). */
function scale5({ label, labels, values, value, onchange, ends }) {
  const wrap = h('div', { class: 'scale5', role: 'radiogroup', 'aria-label': label });
  const paint = (v) => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.v) === v)));
  values.forEach((v, i) => wrap.append(h('button', { type: 'button', role: 'radio', 'aria-label': labels[i], dataset: { v: String(v) }, onclick: () => { const next = Number(wrap.querySelector('[aria-checked="true"]')?.dataset.v) === v ? null : v; paint(next); onchange(next); } }, h('span', { 'aria-hidden': 'true' }, ends ? '' : String(v)))));
  paint(value);
  return h('div', { class: 'field' }, h('p', { class: 'field-label' }, label), wrap, ends ? h('div', { class: 'scale5-ends faint' }, ends.map((e) => h('span', {}, e))) : null);
}

export function renderResult(host, F) {
  const { ctx, method, run } = F;
  const record = run.session.record();
  if (!record) { F.cancel(); return () => {}; }
  const id = F.brewId ??= uuid();
  const profile = ctx.profile;
  const bean = F.beans.find((b) => b.id === F.beanId) ?? null;
  const history = F.history;
  const state = { taste: { ...(F.taste ?? {}) }, notes: F.notes ?? '', saved: false, discarded: false };
  const startedAt = run.startedAt ?? Date.now() - (record.timeS ?? 0) * 1000;
  const spurtsAsked = method.id === 'espresso' && F.recipe.portafilter === 'naked';

  let brew, analysis;
  const rebuild = () => {
    const base = buildBrew({ id, record, profile, recipe: F.recipe, recipeId: F.recipeId, beanId: F.beanId, startedAt, taste: state.taste, notes: state.notes.trim() });
    ({ brew, analysis } = withAnalysis(base, { history, bean, recipe: F.recipe, steps: method.kind === 'espresso' ? null : run.session.steps }));
  };
  rebuild();

  // ---- saving ----
  let saving = Promise.resolve();
  let autosave = null, edit = null;
  const save = () => {
    if (state.discarded) return saving;
    rebuild();
    state.saved = true;
    saving = saving.then(() => saveBrew(ctx.store, brew)).catch((e) => { state.saved = false; console.error('saving the brew failed', e); ctx.toast('Couldn’t save this brew. Tap Save to try again.'); });
    return saving;
  };
  const later = () => { clearTimeout(edit); edit = setTimeout(() => { edit = null; save(); }, 700); }; // keep a saved brew in step with later edits
  const changed = () => { rebuild(); paintInsight(); if (state.saved) later(); };
  autosave = setTimeout(save, AUTOSAVE_MS);
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', save);

  // ---- numbers ----
  const fact = (label, value, unit) => h('div', { class: 'fact' }, h('dd', { class: 'num' }, value, unit ? h('small', {}, unit) : null), h('dt', {}, label));
  const facts = [
    fact('Coffee', fmtG(brew.dose, 1), 'g'),
    fact(method.kind === 'espresso' ? 'Yield' : 'Water', fmtG(brew.yield, 1), 'g'),
    fact('Ratio', brew.ratio ? `1:${fmtG(brew.ratio, 1)}` : '–'),
    fact('Time', fmtTime(brew.timeS)),
  ];
  if (brew.firstDropS != null) facts.push(fact('First drops', `${brew.firstDropS.toFixed(0)}`, 's'));
  if (brew.dripAfterStopG != null) facts.push(fact('Drip after stop', brew.dripAfterStopG.toFixed(1), 'g'));

  // ---- the insight: one takeaway, one thing to try ----
  const takeaway = h('p', { class: 'takeaway', 'data-testid': 'takeaway' });
  const tryBox = h('div', { class: 'try', 'data-testid': 'try-next' });
  const more = h('details', { class: 'more-tips' });
  function paintInsight() {
    takeaway.textContent = analysis.verdict;
    const [top, ...rest] = analysis.tips;
    if (!top) {
      tryBox.replaceChildren(h('h2', {}, 'Try next'), h('p', {}, 'Nothing to change. Pull the next one the same way.'));
    } else {
      tryBox.replaceChildren(
        h('h2', {}, 'Try next'),
        h('p', { class: 'try-title' }, top.title),
        top.change ? h('p', {}, top.change) : null,
        top.why ? h('p', { class: 'muted' }, top.why) : null,
        top.learnCard ? h('a', { class: 'link', href: `#/learn?card=${encodeURIComponent(top.learnCard)}`, 'data-testid': 'learn-link', onclick: (e) => { e.preventDefault(); ctx.navigate(`/learn?card=${encodeURIComponent(top.learnCard)}`); } }, 'Why? Read the Learn card') : null);
    }
    const extra = rest.slice(0, 2);
    more.hidden = !extra.length;
    more.replaceChildren(h('summary', {}, `${extra.length} more idea${extra.length === 1 ? '' : 's'}`), ...extra.map((t) => h('div', { class: 'more-tip' }, h('p', { class: 'try-title' }, t.title), t.change ? h('p', {}, t.change) : null)));
  }
  paintInsight();

  // ---- the curve ----
  const chart = createChart({ label: 'Brew curve: weight and flow over time' });
  chart.set({ points: pointsFromSamples(record.samples), targetG: method.kind === 'espresso' ? record.targetYield : undefined, tEnd: record.timeS });

  // ---- taste ----
  const setTaste = (key, v) => { if (v == null) delete state.taste[key]; else state.taste[key] = v; F.taste = { ...state.taste }; changed(); };
  const taste = h('div', { class: 'taste' },
    h('h2', {}, 'How did it taste?'),
    scale5({ label: 'Flavour', labels: BALANCE, values: [-2, -1, 0, 1, 2], value: state.taste.balance, ends: ['Sour', 'Balanced', 'Bitter'], onchange: (v) => setTaste('balance', v) }),
    scale5({ label: 'Strength', labels: STRENGTH, values: [-2, -1, 0, 1, 2], value: state.taste.strength, ends: ['Weak', 'Just right', 'Strong'], onchange: (v) => setTaste('strength', v) }),
    scale5({ label: 'Your rating', labels: ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'], values: [1, 2, 3, 4, 5], value: state.taste.stars, onchange: (v) => setTaste('stars', v) }),
    spurtsAsked ? h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Did the naked portafilter spurt or jet?'),
      segmented({ label: 'Spurts', value: state.taste.spurts === undefined ? '' : String(state.taste.spurts), options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }], onchange: (v) => setTaste('spurts', v === 'true') })) : null);
  const notes = h('textarea', { id: 'res-notes', rows: 3, maxlength: 600, placeholder: 'Optional: what you noticed', value: state.notes });
  notes.value = state.notes;
  notes.addEventListener('input', () => { state.notes = notes.value; F.notes = notes.value; if (state.saved) later(); });

  // ---- actions ----
  const saveBtn = h('button', { class: 'btn primary big block', type: 'button', 'data-testid': 'save-brew', onclick: async () => {
    saveBtn.disabled = true;
    await save();
    if (state.saved) { ctx.toast('Saved to your journal'); F.done(); } else saveBtn.disabled = false;
  } }, icon('check', { size: 22 }), 'Save brew');
  const discard = h('button', { class: 'btn quiet danger', type: 'button', 'data-testid': 'discard-brew', onclick: async () => {
    if (!(await confirmDialog({ title: 'Discard this brew?', message: 'It won’t be saved to your journal.', confirmLabel: 'Discard', danger: true }))) return;
    state.discarded = true; clearTimeout(autosave); clearTimeout(edit);
    saving.then(() => ctx.store.delete(id)); // also removes an interrupted copy saved earlier under this id
    F.done();
  } }, 'Discard');

  append(host, [
    h('div', { class: 'view-head' }, h('h1', {}, 'Brew done'), h('span', { class: 'muted' }, method.name)),
    takeaway,
    h('dl', { class: 'facts' }, facts),
    h('div', { class: 'chart-wrap tall' }, chart.el),
    tryBox, more, taste,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'res-notes' }, 'Notes'), notes),
    h('div', { class: 'result-actions' }, saveBtn, discard),
    h('p', { class: 'field-hint' }, 'If you walk away, this saves by itself after two minutes.')]);

  return () => {
    clearTimeout(autosave); clearTimeout(edit);
    document.removeEventListener('visibilitychange', onHide);
    removeEventListener('pagehide', save);
    if (!state.discarded && (!state.saved || edit)) save(); // leaving the screen is "walking away": keep the brew
    chart.destroy();
  };
}
