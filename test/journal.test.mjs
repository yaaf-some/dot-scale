import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, dayLabel, groupByDay, filterBrews, filterChoices, curveOf, sparkPath, thin, ratioText, stars,
  grindChange, grindText, buildTrail, groupByBean, NO_BEAN,
} from '../app/journal/history.js';
import { goodShot, fastShot, slowShot } from './insights-fixtures.mjs';

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 14, 12);
const brew = (o) => ({ id: o.id ?? `b${Math.random()}`, type: 'brew', profileId: 'p1', method: 'espresso', beanId: 'bean1', dose: 16, yield: 32, ratio: 2, timeS: 27, startedAt: NOW, updatedAt: 1, ...o });
// A saved espresso brew with a synthetic curve (fast / good / slow shot), as the Brew flow would store it.
const shot = (fn, o = {}) => { const s = fn({ seed: o.seed ?? 1 }); return brew({ ...s, id: o.id, startedAt: o.startedAt, grind: o.grind, taste: o.taste, beanId: o.beanId ?? 'bean1', profileId: 'p1', yield: s.yield }); };

test('groupByDay: newest day first, newest brew first, tombstones and bad records skipped', () => {
  const list = [
    brew({ id: 'a', startedAt: at(2026, 11, 13, 8) }), brew({ id: 'b', startedAt: at(2026, 11, 14, 7) }),
    brew({ id: 'c', startedAt: at(2026, 11, 14, 10) }), brew({ id: 'd', startedAt: at(2026, 11, 1), deleted: true }), { id: 'bad' }, null,
  ];
  const g = groupByDay(list, NOW);
  assert.deepEqual(g.map((d) => d.key), ['2026-11-14', '2026-11-13']);
  assert.deepEqual(g[0].brews.map((b) => b.id), ['c', 'b']);
  assert.deepEqual(g.map((d) => d.label.slice(0, 5)), ['Today', 'Yeste']);
});

test('dayKey is the local calendar day; dayLabel names today and yesterday', () => {
  assert.equal(dayKey(at(2026, 1, 5, 23, 59)), '2026-01-05');
  assert.equal(dayLabel('2026-11-14', NOW), 'Today');
  assert.equal(dayLabel('2026-11-13', NOW), 'Yesterday');
  assert.match(dayLabel('2025-03-02', NOW), /2025/); // other years show the year
  assert.doesNotMatch(dayLabel('2026-03-02', NOW), /2026/);
});

test('filterBrews by profile, method and bean; "all" and empty mean any; NO_BEAN = no bean', () => {
  const list = [
    brew({ id: '1', profileId: 'p1', method: 'espresso', beanId: 'x' }), brew({ id: '2', profileId: 'p2', method: 'espresso', beanId: 'x' }),
    brew({ id: '3', profileId: 'p1', method: 'pour-over', beanId: undefined }), brew({ id: '4', profileId: 'p1', method: 'espresso', beanId: 'y', deleted: true }),
  ];
  const ids = (f) => filterBrews(list, f).map((b) => b.id);
  assert.deepEqual(ids({}), ['1', '2', '3']);
  assert.deepEqual(ids({ profileId: 'p1' }), ['1', '3']);
  assert.deepEqual(ids({ profileId: 'all', method: 'espresso' }), ['1', '2']);
  assert.deepEqual(ids({ beanId: 'x' }), ['1', '2']);
  assert.deepEqual(ids({ beanId: NO_BEAN }), ['3']);
  assert.deepEqual(ids({ profileId: 'p1', method: 'pour-over', beanId: 'x' }), []);
  assert.deepEqual(filterChoices(list), { methods: ['espresso', 'pour-over'], beanIds: ['x'], noBean: true });
});

test('ratio and stars helpers cope with missing data', () => {
  assert.equal(ratioText({ dose: 16, yield: 32 }), '1:2');
  assert.equal(ratioText({ dose: 15, yield: 250 }), '1:16.7');
  assert.equal(ratioText({ ratio: 2.5 }), '1:2.5');
  assert.equal(ratioText({}), '');
  assert.equal(stars({ taste: { stars: 4 } }), 4);
  assert.equal(stars({ taste: { stars: 9 } }), null);
  assert.equal(stars({}), null);
});

test('curveOf: real samples, derived flow, and no curve for legacy / empty brews', () => {
  const s = shot(goodShot);
  const c = curveOf(s);
  assert.equal(c.hz, 10);
  assert.equal(c.weight.length, c.flow.length);
  assert.ok(c.duration > 20);
  const noFlow = curveOf({ samples: { hz: 10, t0: 0, channels: { weight: [0, 1, 2, 4, 8] } } });
  assert.equal(noFlow.flow.length, 5);
  assert.ok(noFlow.flow[2] > 0);
  assert.equal(curveOf({ legacy: true, dose: 15, yield: 240 }), null);
  assert.equal(curveOf({ samples: { channels: { weight: [1] } } }), null);
  assert.equal(curveOf(null), null);
  assert.deepEqual(curveOf({ samples: { hz: 10, channels: { weight: [0, null, 5] } } }).weight, [0, 0, 5], 'gaps are carried, not NaN');
});

test('sparkPath: bounded points inside the box; empty without a curve', () => {
  const d = sparkPath(shot(goodShot), { w: 72, h: 24, max: 30 });
  const pts = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(pts.length, 30);
  assert.ok(pts.every(([x, y]) => x >= 0 && x <= 72 && y >= 0 && y <= 24));
  assert.ok(pts.at(-1)[1] < pts[0][1], 'weight rises, so y falls');
  assert.equal(sparkPath({ legacy: true }), '');
  assert.deepEqual(thin([1, 2, 3], 10), [1, 2, 3]);
  assert.deepEqual(thin([0, 1, 2, 3, 4], 3), [0, 2, 4]);
});

test('grindChange: numbers (lower = finer by default), flipped grinders, text, unknown', () => {
  const g = (value, text) => ({ grind: { value, text } });
  assert.deepEqual(grindChange(g(12), g(11)), { kind: 'finer', delta: -1, label: 'Finer by 1' });
  assert.equal(grindChange(g(11), g(13)).kind, 'coarser');
  assert.equal(grindChange(g(11), g(11)).kind, 'same');
  assert.equal(grindChange(g(11), g(12), true).kind, 'finer');
  assert.equal(grindChange(g(undefined, '3 clicks'), g(undefined, '4 clicks')).kind, 'changed');
  assert.equal(grindChange(g(undefined, 'Medium'), g(undefined, 'medium')).kind, 'same');
  assert.equal(grindChange({}, g(10)), null);
  assert.equal(grindText(g(12, 'fine')), '12 · fine');
  assert.equal(grindText({}), '');
});

test('buildTrail: ordered shots, grind changes, outcomes recomputed by analyze()', () => {
  const brews = [
    shot(fastShot, { id: 's1', startedAt: at(2026, 11, 10), grind: { value: 12 } }),
    shot(fastShot, { id: 's2', seed: 2, startedAt: at(2026, 11, 11), grind: { value: 11 } }),
    shot(goodShot, { id: 's3', seed: 3, startedAt: at(2026, 11, 12), grind: { value: 10 }, taste: { balance: 0, strength: 0, stars: 4 } }),
    shot(goodShot, { id: 's4', seed: 4, startedAt: at(2026, 11, 13), grind: { value: 10 }, taste: { balance: 0, strength: 0, stars: 5 } }),
  ];
  const t = buildTrail([...brews].reverse(), { method: 'espresso' }); // input order must not matter
  assert.deepEqual(t.shots.map((s) => s.id), ['s1', 's2', 's3', 's4']);
  assert.equal(t.shots[0].change, null);
  assert.equal(t.shots[1].change.kind, 'finer');
  assert.equal(t.shots[3].change.kind, 'same');
  assert.equal(t.shots[0].status, 'fast');
  assert.ok(['sweet', 'ok'].includes(t.shots[2].status), t.shots[2].status);
  assert.ok(t.shots[0].verdict.length > 0);
  assert.equal(t.dialledIn, true);
  assert.equal(t.dialledInId, 's4');
  assert.deepEqual(t.shots.map((s) => s.dialledIn), [false, false, false, true]);
});

test('buildTrail: only the requested method, no dial-in without good shots, survives odd records', () => {
  const list = [shot(fastShot, { id: 'e', startedAt: at(2026, 11, 10) }), brew({ id: 'p', method: 'pour-over', startedAt: at(2026, 11, 11) }), { id: 'junk', type: 'brew', method: 'espresso', startedAt: 5 }];
  const t = buildTrail(list, { method: 'espresso' });
  assert.deepEqual(t.shots.map((s) => s.id), ['junk', 'e']);
  assert.equal(t.dialledIn, false);
  const boom = buildTrail(list, { method: 'espresso', analyzeFn: () => { throw new Error('x'); } });
  assert.equal(boom.shots.length, 2);
  assert.equal(boom.shots[0].status, null);
  assert.equal(buildTrail([], {}).shots.length, 0);
});

test('legacy brews (no samples, no taste, no bean) render in the trail and groupings', () => {
  const legacy = brew({ id: 'legacy-brew-1', legacy: true, method: 'pour-over', beanId: undefined, startedAt: 1700000000000, dose: 15, yield: 240, timeS: 190, samples: undefined });
  const t = buildTrail([legacy], { method: 'pour-over' });
  assert.equal(t.shots.length, 1);
  assert.equal(t.shots[0].stars, null);
  assert.equal(groupByBean([legacy]).length, 0, 'no bean, no trail');
  assert.equal(groupByDay([legacy], NOW).length, 1);
});

test('groupByBean groups by bean and method, most recent first, oldest shot first inside', () => {
  const list = [
    brew({ id: '1', beanId: 'a', startedAt: 10 }), brew({ id: '2', beanId: 'b', startedAt: 30 }), brew({ id: '3', beanId: 'a', startedAt: 20 }), brew({ id: '4', beanId: 'a', method: 'aeropress', startedAt: 5 }),
  ];
  const g = groupByBean(list);
  assert.deepEqual(g.map((x) => `${x.beanId}:${x.method}`), ['b:espresso', 'a:espresso', 'a:aeropress']);
  assert.deepEqual(g[1].brews.map((b) => b.id), ['1', '3']);
});

test('interrupted brews are not trend points: not in the trail, not dialled in, and they get no advice', async () => {
  const { buildTrail } = await import('../app/journal/history.js');
  const { analyze, findDialledIn } = await import('../app/insights/analyze.js');
  const weight = Array.from({ length: 280 }, (_, i) => Math.min(32, Math.max(0, (i - 70) * 0.17)));
  const flow = weight.map((w, i) => (i > 70 && w < 32 ? 1.7 : 0));
  const good = (id, t) => ({ type: 'brew', id, method: 'espresso', profileId: 'p', beanId: 'b', startedAt: t, dose: 16, yield: 32, targetYield: 32, ratio: 2, timeS: 28, grind: { value: 10 }, taste: { balance: 0, strength: 0, stars: 5 }, samples: { hz: 10, t0: 0, channels: { weight, flow } } });
  const a = good('a', 1000), b = good('b', 3000);
  const cut = { ...good('cut', 2000), incomplete: true, yield: 7, timeS: 5, taste: undefined };
  // the interrupted shot sits between two good ones: it must not break the run of two (nor be one itself)
  assert.equal(findDialledIn([a, cut, b]), 'b');
  const trail = buildTrail([a, cut, b], { method: 'espresso' });
  assert.deepEqual(trail.shots.map((s) => s.id), ['a', 'b']);
  assert.equal(trail.dialledInId, 'b');
  // analyze(): a partial verdict, no tips, never dialled in, and not used as history for the next shot
  const r = analyze(cut, { method: 'espresso', history: [a] });
  assert.match(r.verdict, /^Interrupted/);
  assert.deepEqual(r.tips, []);
  assert.equal(r.metrics.dialledIn, false);
  const later = { ...good('n', 4000), grind: { value: 8 } };
  assert.deepEqual(analyze(later, { method: 'espresso', history: [a, cut] }), analyze(later, { method: 'espresso', history: [a] }), 'a later shot is judged as if the interrupted one never happened');
});

test('limitDays cuts the day groups at a row and counts what is left out', async () => {
  const { limitDays } = await import('../app/journal/history.js');
  const days = [{ label: 'A', brews: [1, 2, 3] }, { label: 'B', brews: [4, 5] }, { label: 'C', brews: [6] }];
  assert.deepEqual(limitDays(days, 4), { days: [days[0], { label: 'B', brews: [4] }], hidden: 2 });
  assert.deepEqual(limitDays(days, 99), { days, hidden: 0 });
  assert.deepEqual(limitDays(days, 0), { days: [], hidden: 6 });
});
