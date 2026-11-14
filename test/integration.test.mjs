// Cross-module check: a simulated espresso goes through createBrewSession, and record() feeds analyze() (app/insights).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../app/insights/analyze.js';
import { espressoRig, espressoToReady, pumpOn } from './sim-scale.mjs';

function shot({ manual }) {
  const rig = espressoRig();
  espressoToReady(rig);
  if (manual) rig.send({ type: 'start' }); // pump on: the timer covers the wait for the first drops
  pumpOn(rig);
  rig.runWhile(() => rig.state.phase !== 'done', 90);
  assert.equal(rig.state.phase, 'done');
  const record = rig.recorder();
  return { record, result: analyze({ ...record, type: 'brew' }, { method: 'espresso', history: [] }) };
}

// Tip ids from app/insights/analyze.js that would mean "this shot ran fast / first drops came early / change the grind".
const speedAdvice = (tips) => tips.filter((t) => t.id === 'first-drops-early' || t.id === 'grind-faster' || /^grind-(fast|finer|coarser|slow)/.test(t.id) || t.variable === 'grind');

test('a normal 1:2 shot started from the pump gives no fast / early-first-drops advice', () => {
  const { record, result } = shot({ manual: true });
  assert.equal(record.startSource, 'manual');
  assert.ok(Math.abs(record.firstDropS - 7) < 1, `firstDropS ${record.firstDropS}`);
  assert.ok(record.timeS > 25 && record.timeS < 40, `timeS ${record.timeS}`);
  assert.equal(result.metrics.timeStatus, 'ok');
  assert.ok(Math.abs(result.metrics.firstDropS - record.firstDropS) < 0.01);
  assert.match(result.verdict, /In range/);
  assert.deepEqual(speedAdvice(result.tips), [], `unexpected tips: ${result.tips.map((t) => t.id)}`);
});

test('the same shot auto-started at the first drops is judged on pump time, not as a fast shot', () => {
  const { record, result } = shot({ manual: false });
  assert.equal(record.startSource, 'auto');
  assert.equal(record.firstDropS, undefined);
  assert.ok(record.timeS < 28, 'the auto timer leaves out the wait for the first drops');
  assert.equal(result.metrics.autoStart, true);
  assert.equal(result.metrics.firstDropS, null, 'not derived from the samples, so not reported as 0');
  assert.notEqual(result.metrics.timeStatus, 'fast');
  assert.deepEqual(speedAdvice(result.tips), [], `unexpected tips: ${result.tips.map((t) => t.id)}`);
});

test('the record from a session has what analyze() and the store need', () => {
  const { record } = shot({ manual: true });
  for (const k of ['dose', 'yield', 'targetYield', 'ratio', 'timeS']) assert.ok(Number.isFinite(record[k]), k);
  assert.equal(record.samples.hz, 10);
  assert.equal(record.samples.channels.weight.length, record.samples.channels.flow.length);
});
