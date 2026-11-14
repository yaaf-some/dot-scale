import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/core/store.js';
import { memoryAdapter } from '../app/core/store-adapters.js';
import { legacyToRecords, resampleCurve, runFirstRun } from '../app/core/bootstrap.js';
import { SEED_IDS, seedRecords } from '../app/core/seeds.js';

const ls = (o) => ({ getItem: (k) => { const key = k.replace(/^dot\./, ''); return key in o ? JSON.stringify(o[key]) : null; } });

test('seeds: Yaaf and Alexa, EC260 with a 51 mm group, 16 g unpressurized basket, naked and 2-spout portafilters', () => {
  const s = seedRecords();
  assert.deepEqual(s.filter((r) => r.type === 'profile').map((r) => r.name), ['Yaaf', 'Alexa']);
  const machine = s.find((r) => r.kind === 'espresso-machine');
  assert.match(machine.name, /EC260/); assert.equal(machine.props.groupMm, 51);
  const basket = s.find((r) => r.kind === 'basket');
  assert.deepEqual([basket.props.doseG, basket.props.pressurized], [16, false]);
  assert.deepEqual(s.filter((r) => r.kind === 'portafilter').map((r) => r.props.style).sort(), ['naked', 'spouted']);
  assert.equal(new Set(s.map((r) => r.id)).size, s.length);
  assert.ok(s.every((r) => r.updatedAt === 1), 'seeds lose to any real edit');
});

test('legacyToRecords converts recipe, prefs and history', () => {
  const r = legacyToRecords({
    recipe: { dose: 15, ratio: 16 }, autoStart: false, beep: true,
    history: [{ at: 1000, dose: 15, out: 240, time: 190 }, { at: 'bad' }, { at: 5, dose: 0, out: 1 }],
  }, 'P', 42);
  assert.deepEqual(r.prefs, { autoStart: false, beep: true });
  assert.equal(r.recipes.length, 1);
  assert.deepEqual([r.recipes[0].yield, r.recipes[0].profileId, r.recipes[0].updatedAt], [240, 'P', 42]);
  assert.equal(r.brews.length, 1);
  const b = r.brews[0];
  assert.deepEqual([b.type, b.profileId, b.dose, b.yield, b.ratio, b.timeS, b.startedAt, b.updatedAt], ['brew', 'P', 15, 240, 16, 190, 1000, 1000]);
  assert.equal(b.samples, undefined, 'old brews have no curve');
});

test('legacyToRecords tolerates garbage', () => {
  const r = legacyToRecords({ recipe: 'x', autoStart: 'yes', history: 'nope' }, 'P');
  assert.deepEqual([r.recipes, r.brews, r.prefs], [[], [], {}]);
});

test('legacy history with curves and notes (from the history-export format) is carried over', () => {
  const samples = [[0, 0, 0], [1, 5, 5], [2, 12, 7]];
  const { brews } = legacyToRecords({ history: [{ at: 9, dose: 15, out: 12, time: 2, samples, notes: { bean: 'Guji', grind: '12', text: 'bright' } }] }, 'P');
  assert.equal(brews[0].samples.hz, 10);
  assert.equal(brews[0].samples.channels.weight.length, 21);
  assert.equal(brews[0].samples.channels.weight.at(-1), 12);
  assert.equal(brews[0].notes, 'Guji · 12 · bright');
});

test('resampleCurve interpolates to 10 Hz and rejects too-short input', () => {
  const c = resampleCurve([[0, 0, 0], [1, 10, 10]]);
  assert.equal(c.channels.weight.length, 11);
  assert.equal(c.channels.weight[5], 5);
  assert.equal(resampleCurve([[0, 0, 0]]), undefined);
  assert.equal(resampleCurve(undefined), undefined);
});

test('runFirstRun seeds once, migrates once, and attaches history to Yaaf', async () => {
  const store = createStore(memoryAdapter());
  const local = ls({ recipe: { dose: 18, ratio: 2 }, autoStart: false, history: [{ at: 1, dose: 18, out: 36, time: 28 }] });
  const first = await runFirstRun(store, { localStorage: local });
  assert.deepEqual(first, { seeded: true, migrated: true });
  assert.equal((await store.list('profile')).length, 2);
  assert.equal((await store.list('gear')).length, 4);
  const [brew] = await store.list('brew');
  assert.equal(brew.profileId, SEED_IDS.yaaf);
  assert.equal(store.prefs.get('autoStart'), false);
  const second = await runFirstRun(store, { localStorage: local });
  assert.deepEqual(second, { seeded: false, migrated: false });
  assert.equal((await store.list('brew')).length, 1);
});

test('runFirstRun does not resurrect a seed that was deleted (tombstone) before seeding', async () => {
  const store = createStore(memoryAdapter());
  await store.adapter.put({ id: SEED_IDS.alexa, type: 'profile', updatedAt: 999, deleted: true });
  await runFirstRun(store, { localStorage: ls({}) });
  assert.deepEqual((await store.list('profile')).map((p) => p.name), ['Yaaf']);
});

test('runFirstRun works without localStorage', async () => {
  const store = createStore(memoryAdapter());
  assert.deepEqual(await runFirstRun(store, { localStorage: undefined }), { seeded: true, migrated: false });
});
