import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeCandidates, journalNudge, beanAge } from '../app/journal/nudge.js';
import { goodShot, fastShot, slowShot } from './insights-fixtures.mjs';

const DAY = 86400000;
const NOW = new Date(2026, 10, 14, 12).getTime();
const bean = (o = {}) => ({ id: 'bean1', type: 'bean', name: 'Ethiopia Guji', roaster: 'x', updatedAt: 1, ...o });
const shot = (fn, n, o = {}) => ({ ...fn({ seed: n }), id: `s${n}`, profileId: 'p1', beanId: 'bean1', startedAt: NOW - (10 - n) * DAY, updatedAt: 1, ...o });
const good = { taste: { balance: 0, strength: 0, stars: 4 } };

test('three fast shots on a bean → "start 1 step finer", naming the bean and a grind value to try', () => {
  const brews = [1, 2, 3].map((n) => shot(fastShot, n, { grind: { value: 12 - n } }));
  const n = journalNudge({ brews, beans: [bean()], now: NOW });
  assert.match(n.id, /^run-fast-bean1-/);
  assert.match(n.text, /last 3 shots on Ethiopia Guji ran fast; start 1 step finer \(try 8\)\./);
  assert.equal(n.action.href, '#/journal/bean/bean1?method=espresso');
});

test('slow runs say coarser; a single odd shot says nothing', () => {
  const slow = [1, 2].map((n) => shot(slowShot, n));
  assert.match(journalNudge({ brews: slow, beans: [bean()], now: NOW }).text, /last 2 shots .* ran slow; start 1 step coarser/);
  assert.equal(journalNudge({ brews: [shot(fastShot, 1)], beans: [bean()], now: NOW }), null);
  assert.equal(journalNudge({ brews: [shot(fastShot, 1), shot(slowShot, 2)], beans: [bean()], now: NOW }), null, 'fast then slow is not a run');
});

test('flipped grinder: finer means a higher number', () => {
  const brews = [1, 2].map((n) => shot(fastShot, n, { grind: { value: 5 }, gear: { grinderFinerIsHigher: true } }));
  assert.match(journalNudge({ brews, beans: [bean()], now: NOW }).text, /try 6\)/);
});

test('two good rated shots → dialled-in congratulation that names the grind, and no advice', () => {
  const brews = [shot(fastShot, 1), shot(goodShot, 2, { ...good, grind: { value: 10 } }), shot(goodShot, 3, { ...good, grind: { value: 10 } })];
  const n = journalNudge({ brews, beans: [bean()], now: NOW });
  assert.match(n.id, /^dialled-bean1-s3$/);
  assert.match(n.text, /Ethiopia Guji is dialled in: grind 10/);
  assert.ok(!nudgeCandidates({ brews, beans: [bean()], now: NOW }).some((c) => c.id.startsWith('run-')));
});

test('dialled in long ago (more than 3 shots back) is no longer news', () => {
  const brews = [shot(goodShot, 1, good), shot(goodShot, 2, good), shot(fastShot, 3), shot(fastShot, 4), shot(slowShot, 5)];
  const ids = nudgeCandidates({ brews, beans: [bean()], now: NOW }).map((c) => c.id);
  assert.ok(!ids.some((i) => i.startsWith('dialled-')));
});

test('bean age heads-up between 4 and 6 weeks, from the roast date of the last-used bean', () => {
  const roast = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
  const brews = [shot(goodShot, 1)];
  assert.match(journalNudge({ brews, beans: [bean({ roastDate: roast(30) })], now: NOW }).text, /30 days off roast.*past its peak soon/);
  assert.equal(journalNudge({ brews, beans: [bean({ roastDate: roast(10) })], now: NOW }), null);
  assert.equal(journalNudge({ brews, beans: [bean({ roastDate: roast(60) })], now: NOW }), null, 'very old beans are the shell’s own nudge');
  assert.equal(beanAge(bean({ roastDate: 'nope' }), NOW), null);
});

test('dismissed ids are skipped and the next candidate (or nothing) is shown', () => {
  const roast = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
  const brews = [1, 2].map((n) => shot(fastShot, n));
  const data = { brews, beans: [bean({ roastDate: roast })], now: NOW };
  const first = journalNudge(data);
  assert.match(first.id, /^run-/);
  const second = journalNudge({ ...data, dismissed: { [first.id]: 1 } });
  assert.equal(second.id, 'peak-bean1');
  assert.equal(journalNudge({ ...data, dismissed: { [first.id]: 1, 'peak-bean1': 1 } }), null);
  // a new shot changes the id, so dismissing one piece of advice doesn't hide the next
  const more = journalNudge({ ...data, brews: [...brews, shot(fastShot, 3)], dismissed: { [first.id]: 1 } });
  assert.notEqual(more.id, first.id);
});

test('no history, legacy brews, archived or missing beans → null (an empty Home is fine)', () => {
  assert.equal(journalNudge({ brews: [], beans: [], now: NOW }), null);
  assert.equal(journalNudge({ brews: [{ id: 'l', type: 'brew', legacy: true, method: 'pour-over', startedAt: NOW, dose: 15, yield: 240 }], beans: [bean()], now: NOW }), null);
  assert.equal(journalNudge({ brews: [1, 2].map((n) => shot(fastShot, n)), beans: [bean({ archived: true })], now: NOW }), null);
  assert.equal(journalNudge({ brews: [1, 2].map((n) => shot(fastShot, n)), beans: [], now: NOW }), null);
});

test('non-espresso runs use brew/steep wording', () => {
  const mk = (n) => ({ id: `a${n}`, type: 'brew', profileId: 'p1', method: 'aeropress', beanId: 'bean1', startedAt: NOW - n * DAY, dose: 12, yield: 200, timeS: 40, updatedAt: 1 });
  const n = journalNudge({ brews: [mk(1), mk(2)], beans: [bean()], now: NOW });
  if (n) assert.match(n.text, /brews on Ethiopia Guji steeped (short|long); steep a little (longer|shorter)/);
});
