// Pure glue for the Brew flow: recipe prefill, brew-record building, saving, and the small UI decisions that have no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/core/store.js';
import { memoryAdapter } from '../app/core/store-adapters.js';
import { methodOrder, startingRecipe, recipeFromBrew, editRecipe, buildBrew, saveBrew, saveProfileRecipe } from '../app/core/brew-record.js';
import { withAnalysis } from '../app/core/brew-analysis.js';
import { beepFor, showsManualEnd } from '../app/ui/brew/runner.js';
import { demoActions } from '../app/ui/brew/demo-panel.js';
import { layout, pointsFromSamples } from '../app/ui/brew/chart.js';
import { getMethod } from '../app/methods/index.js';
import { espressoRig, espressoToReady, pumpOn } from './sim-scale.mjs';

const alexa = { id: 'p-alexa', name: 'Alexa', methods: ['pour-over'], defaults: { portafilter: 'naked', machineId: 'm1', basketG: 16 } };
const brew = (o) => ({ type: 'brew', id: `b${Math.random()}`, profileId: 'p-alexa', method: 'espresso', startedAt: 1000, dose: 17, yield: 35, targetYield: 36, ...o });

function shot() {
  const rig = espressoRig();
  espressoToReady(rig);
  pumpOn(rig);
  rig.runWhile(() => rig.state.phase !== 'done', 90);
  return rig;
}

test('methodOrder: last used first, then onboarding choices, then the rest', () => {
  const order = methodOrder(alexa, [brew({ method: 'moka', startedAt: 5 }), brew({ method: 'espresso', startedAt: 9 }), brew({ profileId: 'other', method: 'aeropress', startedAt: 99 })]);
  assert.deepEqual(order.slice(0, 3), ['espresso', 'moka', 'pour-over']);
  assert.equal(new Set(order).size, 6);
});

test('startingRecipe: defaults, then last brew, then an explicit recipe or brew', () => {
  const d = startingRecipe({ method: 'espresso', profile: alexa });
  assert.equal(d.source, 'default');
  assert.equal(d.recipe.dose, 16);
  assert.equal(d.recipe.portafilter, 'naked', 'espresso takes the portafilter from the profile');
  const old = brew({ id: 'old', startedAt: 1, dose: 15, targetYield: 30 });
  const last = brew({ id: 'last', startedAt: 9, grind: { text: '12 clicks', value: 12 }, gear: { portafilter: 'spouted' }, beanId: 'bean1' });
  const l = startingRecipe({ method: 'espresso', profile: alexa, brews: [old, last] });
  assert.equal(l.source, 'last');
  assert.equal(l.recipe.dose, 17);
  assert.equal(l.recipe.yield, 36, 'the target yield, not what ran into the cup');
  assert.equal(l.recipe.ratio, 2.12);
  assert.deepEqual(l.recipe.grind, { text: '12 clicks', value: 12 });
  assert.equal(l.recipe.portafilter, 'spouted');
  assert.equal(l.recipe.beanId, 'bean1');
  assert.equal(startingRecipe({ method: 'espresso', profile: alexa, brews: [old, last], brewId: 'old' }).recipe.dose, 15);
  const rec = { id: 'r1', type: 'recipe', profileId: 'p-alexa', method: 'pour-over', name: 'Mine', dose: 20, yield: 320, favorite: true, updatedAt: 3 };
  const r = startingRecipe({ method: 'pour-over', profile: alexa, recipes: [rec], recipeId: 'r1' });
  assert.deepEqual([r.source, r.recipeId, r.recipe.dose, r.recipe.yield, r.recipe.ratio, r.recipe.name], ['recipe', 'r1', 20, 320, 16, 'Mine']);
  assert.ok(r.recipe.tempC, 'fields missing from the record come from the method defaults');
  assert.equal(startingRecipe({ method: 'pour-over', profile: { id: 'someone' }, brews: [last] }).source, 'default', 'other profiles brews are not used');
});

test('editRecipe keeps dose, ratio and yield linked and scales custom steps', () => {
  const r = { dose: 16, yield: 32, ratio: 2, steps: [{ kind: 'pour', targetG: 32, atS: 0 }] };
  const a = editRecipe(r, 'dose', 18);
  assert.deepEqual([a.dose, a.yield, a.ratio], [18, 36, 2]);
  assert.equal(a.steps[0].targetG, 36);
  const b = editRecipe(r, 'ratio', 2.5);
  assert.deepEqual([b.dose, b.yield], [16, 40]);
  const c = editRecipe(r, 'yield', 40);
  assert.deepEqual([c.dose, c.ratio], [16, 2.5]);
  assert.equal(editRecipe(r, 'dose', NaN).dose, 16);
  assert.equal(editRecipe(r, 'ratio', 2.5).steps[0].targetG, 40, 'a ratio change moves the water, so the step targets follow');
  assert.equal(editRecipe(r, 'tempC', 90).tempC, 90);
});

test('buildBrew makes a §6 Brew from a session record, and analyze() runs on it', () => {
  const rig = shot();
  const record = rig.recorder();
  const recipe = { ...rig.state && { method: 'espresso', portafilter: 'naked', grind: { text: '12', value: 12 }, dose: 16, yield: 32 } };
  const b = buildBrew({ id: 'fixed', record, profile: alexa, recipe, beanId: 'bean1', startedAt: 123456, taste: { stars: 4 }, notes: ' ok ' });
  assert.equal(b.id, 'fixed'); assert.equal(b.type, 'brew'); assert.equal(b.profileId, 'p-alexa'); assert.equal(b.startedAt, 123456);
  assert.deepEqual(b.gear, { machine: 'm1', portafilter: 'naked', basketG: 16 });
  assert.equal(b.beanId, 'bean1'); assert.deepEqual(b.grind, { text: '12', value: 12 });
  assert.equal(b.samples.hz, 10); assert.equal(b.startSource, 'auto'); assert.equal(b.firstDropS, undefined);
  assert.ok(Number.isFinite(b.timeS) && b.yield > 20 && b.dripAfterStopG >= 0);
  assert.deepEqual(b.taste, { stars: 4 });
  const { brew: full, analysis } = withAnalysis(b, { history: [] });
  assert.equal(full.metrics, analysis.metrics);
  assert.equal(typeof full.insights.verdict, 'string');
  assert.ok(Array.isArray(full.insights.tips));
  // taste feeds the next analysis (sour + bitter flagged both = channeling) without touching the id
  assert.equal(withAnalysis({ ...b, taste: { balance: -2, stars: 2 } }, {}).brew.id, 'fixed');
  assert.throws(() => buildBrew({ record: null }), /no record/);
});

test('saveBrew keeps one record per id; saveProfileRecipe keeps one favourite per profile and method', async () => {
  const store = createStore(memoryAdapter());
  const b = { type: 'brew', id: 'one', profileId: 'p-alexa', method: 'espresso', startedAt: 1, dose: 16, yield: 32 };
  await saveBrew(store, b); await saveBrew(store, { ...b, notes: 'later' });
  const list = await store.list('brew');
  assert.equal(list.length, 1); assert.equal(list[0].notes, 'later');
  const recipe = { method: 'espresso', name: 'Espresso 1:2', dose: 16, yield: 32, ratio: 2, portafilter: 'naked', grind: { text: '12' }, tempC: null };
  const r1 = await saveProfileRecipe(store, { profile: alexa, recipe, beanId: 'bean1' });
  const r2 = await saveProfileRecipe(store, { profile: alexa, recipe: { ...recipe, dose: 17, yield: 34 }, beanId: null });
  assert.equal(r1.id, r2.id);
  const recs = await store.list('recipe');
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].favorite, recs[0].dose, recs[0].portafilter, recs[0].beanId, recs[0].tempC], [true, 17, 'naked', undefined, undefined]);
  await saveProfileRecipe(store, { profile: { id: 'p2' }, recipe });
  assert.equal((await store.list('recipe')).length, 2);
  // the saved record round-trips into the next brew's starting recipe
  assert.equal(startingRecipe({ method: 'espresso', profile: alexa, recipes: recs }).source, 'recipe');
});

test('recipeFromBrew falls back to method defaults for old brews', () => {
  const r = recipeFromBrew({ method: 'pour-over', dose: 20, yield: 300 });
  assert.deepEqual([r.dose, r.yield, r.ratio], [20, 300, 15]);
  assert.equal(recipeFromBrew({ method: 'nope' }), null);
});

test('beepFor: stop-the-pump, step reached, new pour and done make sound; chatter does not', () => {
  assert.equal(beepFor({ id: 'espresso:stop' }), 'target');
  assert.equal(beepFor({ id: 'step:2:reached' }), 'step');
  assert.equal(beepFor({ id: 'step:2' }), 'step');
  assert.equal(beepFor({ id: 'step:0' }), null, 'the first step is the one you just started');
  assert.equal(beepFor({ id: 'step:1:soon' }), null);
  assert.equal(beepFor({ id: 'done' }), 'done');
});

test('demoActions offer what hands would do, per method and phase', () => {
  const espresso = getMethod('espresso'), pour = getMethod('pour-over'), moka = getMethod('moka');
  const ids = (method, state) => demoActions({ method, recipe: { dose: 16, yield: 32 }, state }).map((a) => a.id);
  assert.deepEqual(ids(espresso, { phase: 'prep', prepStep: 'dose' }), ['dose']);
  assert.deepEqual(ids(espresso, { phase: 'prep', prepStep: 'cup' }), ['cup']);
  assert.deepEqual(ids(moka, { phase: 'prep', prepStep: 'water' }), ['water']);
  assert.deepEqual(ids(espresso, { phase: 'ready' }), ['pump']);
  assert.deepEqual(ids(pour, { phase: 'ready', brew: { targetG: 30 } }), ['pour']);
  assert.deepEqual(ids(moka, { phase: 'ready' }), []);
});

test('chart layout scales to the data and handles too little data', () => {
  assert.equal(layout([{ t: 0, g: 0, f: 0 }], { w: 300, hgt: 150 }), null);
  const pts = pointsFromSamples({ hz: 10, t0: 0, channels: { weight: [0, 1, 2, 30], flow: [0, 1, 1, 0] } });
  assert.deepEqual(pts[3], { t: 0.3, g: 30, f: 0 });
  const L = layout(pts, { targetG: 32, tEnd: 30, w: 300, hgt: 150 });
  assert.ok(L.gMax >= 32 && L.t1 === 30);
  assert.ok(L.yG(32) < L.yG(0) && L.x(30) <= 292);
  assert.deepEqual(pointsFromSamples(undefined), []);
});

test('an interrupted shot is kept as an incomplete Brew, and the finished one replaces it', async () => {
  const rig = shot();
  const record = rig.recorder();
  const { shouldKeepPartial, buildPartialBrew } = await import('../app/core/brew-record.js');
  assert.equal(shouldKeepPartial(null), false, 'the timer never started');
  assert.equal(shouldKeepPartial({ yield: 0, timeS: 0.5 }), false);
  assert.equal(shouldKeepPartial({ yield: 5, timeS: 0 }), true);
  assert.equal(shouldKeepPartial({ yield: 0, timeS: 4 }), true);
  assert.equal(shouldKeepPartial({ method: 'moka', yield: 130, timeS: 0.2 }), false, 'moka yield is the water, not output');
  const store = createStore(memoryAdapter());
  const part = buildPartialBrew({ id: 'same', record: { ...record, yield: 12, timeS: 9 }, profile: alexa, recipe: { method: 'espresso' }, startedAt: 5 });
  assert.equal(part.incomplete, true);
  assert.ok(part.samples.channels.weight.length > 0);
  await saveBrew(store, part);
  await saveBrew(store, buildBrew({ id: 'same', record, profile: alexa, recipe: { method: 'espresso' }, startedAt: 5 }));
  const all = await store.list('brew');
  assert.equal(all.length, 1);
  assert.equal(all[0].incomplete, undefined, 'finishing the shot clears the flag');
  // incomplete brews never count as history for the coach
  const later = buildBrew({ id: 'next', record, profile: alexa, recipe: { method: 'espresso' }, startedAt: 50 });
  const { analysis } = withAnalysis(later, { history: [part] });
  assert.ok(analysis.verdict);
});

test('showsManualEnd: espresso has no Done button unless "finish by itself" is off; other methods always do', () => {
  assert.equal(showsManualEnd('espresso', { autoStop: true }), false);
  assert.equal(showsManualEnd('espresso', undefined), false);
  assert.equal(showsManualEnd('espresso', { autoStop: false }), true, 'the person chose to end it by hand');
  for (const k of ['pour', 'immersion', 'moka']) assert.equal(showsManualEnd(k, { autoStop: true }), true);
});
