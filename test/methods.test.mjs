import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, getMethod, defaultRecipe, stepsFor, prepFor, linkRecipe, scaleRecipe, ratioOf, yieldFor } from '../app/methods/index.js';

test('every method has the §9 shape', () => {
  assert.deepEqual(METHODS.map((m) => m.id), ['espresso', 'pour-over', 'french-press', 'aeropress', 'moka', 'prestina']);
  for (const m of METHODS) {
    for (const k of ['id', 'name', 'icon', 'defaults', 'steps', 'prep', 'learn']) assert.ok(m[k] != null, `${m.id}.${k}`);
    assert.ok(m.prep.length >= 1 && m.prep.length <= 3, `${m.id} prep has at most 3 lines`);
    assert.equal(m.defaults.method, m.id);
    assert.ok(Math.abs(m.defaults.ratio - m.defaults.yield / m.defaults.dose) < 0.02, `${m.id} ratio matches yield/dose`);
    assert.ok(['espresso', 'pour', 'immersion', 'moka'].includes(m.kind));
  }
});

test('espresso defaults and portafilter', () => {
  const e = getMethod('espresso');
  assert.equal(e.defaults.dose, 16);
  assert.equal(e.defaults.yield, 32);
  assert.ok(['naked', 'spouted'].includes(e.defaults.portafilter));
  assert.equal(e.defaults.tempC, null); // the EC260 has no temperature control
  assert.deepEqual(e.timeRangeS, [25, 30]);
});

test('only the Prestina is flagged unverified', () => {
  assert.deepEqual(METHODS.filter((m) => m.unverified).map((m) => m.id), ['prestina']);
});

test('ratio <-> yield stay linked', () => {
  const r = defaultRecipe('espresso');
  assert.equal(ratioOf(16, 36), 2.25);
  assert.equal(yieldFor(16, 2.5), 40);
  const a = linkRecipe(r, 'dose', 18); // ratio kept
  assert.deepEqual([a.dose, a.yield, a.ratio], [18, 36, 2]);
  const b = linkRecipe(r, 'ratio', 2.5); // dose kept
  assert.deepEqual([b.dose, b.yield, b.ratio], [16, 40, 2.5]);
  const c = linkRecipe(r, 'yield', 36); // dose kept
  assert.deepEqual([c.dose, c.yield, c.ratio], [16, 36, 2.25]);
  assert.deepEqual(linkRecipe(r, 'dose', NaN), r);
  assert.equal(r.dose, 16, 'does not mutate');
});

test('scaleRecipe keeps the ratio and scales custom step targets', () => {
  const r = { ...defaultRecipe('pour-over'), steps: [{ kind: 'pour', label: 'x', targetG: 100 }] };
  const s = scaleRecipe(r, 30);
  assert.equal(s.dose, 30);
  assert.ok(Math.abs(s.yield / s.dose - r.ratio) < 0.01);
  assert.equal(s.steps[0].targetG, 200);
  assert.equal(r.steps[0].targetG, 100);
});

test('pour-over steps resolve to bloom 2x dose, 60%, 100%', () => {
  const st = stepsFor(defaultRecipe('pour-over'));
  assert.deepEqual(st.map((s) => s.kind), ['bloom', 'pour', 'pour', 'wait']);
  assert.deepEqual(st.map((s) => s.targetG), [30, 150, 250, undefined]);
  assert.equal(st[0].durationS, 45);
  assert.equal(st[1].atS, 45);
  assert.ok(st[3].atS + st[3].durationS >= 180 && st[3].atS + st[3].durationS <= 210);
  assert.match(st[1].label, /150/);
});

test('stepsFor follows the dose and handles custom steps', () => {
  const r = linkRecipe(defaultRecipe('pour-over'), 'dose', 20); // 20 g -> 333.4 g
  const st = stepsFor(r);
  assert.equal(st[0].targetG, 40);
  assert.equal(st[2].targetG, r.yield);
  const custom = stepsFor({ ...r, steps: [{ kind: 'pour', label: 'a', targetG: 50, durationS: 10 }, { kind: 'wait', label: 'b' }] });
  assert.equal(custom[1].atS, 10);
});

test('every method gives steps with increasing times and sensible targets', () => {
  for (const m of METHODS) {
    const st = stepsFor(m.defaults);
    assert.ok(st.length >= 1, m.id);
    for (let i = 1; i < st.length; i++) assert.ok(st[i].atS >= st[i - 1].atS, `${m.id} step ${i} is in order`);
    const t = st.filter((s) => s.targetG != null).map((s) => s.targetG);
    assert.deepEqual([...t].sort((a, b) => a - b), t, `${m.id} cumulative targets rise`);
  }
  assert.deepEqual(stepsFor(getMethod('french-press').defaults).map((s) => s.kind), ['pour', 'wait', 'stir', 'stir', 'wait', 'plunge']);
  assert.equal(stepsFor(getMethod('french-press').defaults)[5].atS, 570);
});

test('prep lines fill in dose and temperature', () => {
  assert.match(prepFor(defaultRecipe('espresso'))[0], /16 g/);
  assert.match(prepFor(defaultRecipe('pour-over'))[2], /94/);
  assert.deepEqual(prepFor(null), []);
});
