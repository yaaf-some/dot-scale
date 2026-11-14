import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, findDialledIn } from '../app/insights/analyze.js';
import { RULES, LEARN } from '../app/insights/rules.js';
import { CARDS, CARDS_BY_ID, getCard } from '../app/learn/cards.js';
import { goodShot, fastShot, gusherShot, slowShot, channelingShot, espressoShot, pourTimeline } from './insights-fixtures.mjs';

const top = (r) => r.tips[0];
const ids = (r) => r.tips.map((t) => t.id);

test('good shot: in range, stable, nothing to fix', () => {
  const r = analyze(goodShot());
  assert.ok(r.metrics.timeS >= 25 && r.metrics.timeS <= 30, `time ${r.metrics.timeS}`);
  assert.equal(r.metrics.timeStatus, 'sweet');
  assert.equal(r.metrics.unstable, false);
  assert.ok(r.metrics.firstDropS > 8 && r.metrics.firstDropS < 10.5);
  assert.ok(r.metrics.flowCV < 0.3);
  assert.ok(r.metrics.dripAfterStopG > 1 && r.metrics.dripAfterStopG < 2.2);
  assert.match(r.verdict, /^Right on target: 3\d(\.\d)? g in \d+ s\.$/);
  assert.equal(top(r).id, 'log-taste');
});

test('fast shot: grind finer, ranked first', () => {
  const r = analyze(fastShot());
  assert.equal(r.metrics.timeStatus, 'fast');
  assert.match(r.verdict, /^Ran fast: /);
  assert.equal(top(r).id, 'grind-finer');
  assert.match(top(r).change, /finer/);
  assert.equal(top(r).learnCard, LEARN.fastSour);
});

test('gusher: much too fast, asks for a bigger step', () => {
  const r = analyze(gusherShot());
  assert.equal(top(r).id, 'grind-finer');
  assert.match(top(r).title, /Much too fast/);
  assert.match(top(r).change, /2-3 steps/);
});

test('slow shot: grind coarser, first drops noted', () => {
  const r = analyze(slowShot());
  assert.equal(r.metrics.timeStatus, 'slow');
  assert.match(r.verdict, /^Ran slow: /);
  assert.equal(top(r).id, 'grind-coarser');
  assert.match(top(r).why, /First drops took/i);
});

test('channeling: puck prep first, not grind', () => {
  const r = analyze(channelingShot());
  assert.equal(r.metrics.unstable, true);
  assert.ok(r.metrics.spikeRatio > RULES.espresso.stability.spikeRatio);
  assert.equal(top(r).id, 'puck-prep');
  assert.equal(top(r).variable, 'puck');
  assert.ok(!ids(r).includes('grind-finer') && !ids(r).includes('grind-coarser'));
  assert.match(r.verdict, /uneven/);
});

test('naked portafilter + spurts flagged by the user uses the naked-spurts card', () => {
  const r = analyze({ ...goodShot(), taste: { balance: 0, spurts: true } });
  assert.equal(top(r).id, 'puck-prep');
  assert.equal(top(r).learnCard, LEARN.nakedSpurts);
});

test('fast + channeling: puck prep outranks grind, grind stays out of the top 1', () => {
  const r = analyze(channelingShot({ firstDropS: 4, flowAt: (t) => 2.6 * Math.min(1, t / 2), stopAtG: 34.5, seed: 9, spikes: [{ at: 9, len: 1.4, add: 5 }, { at: 12, len: 1, add: 4 }] }));
  assert.equal(top(r).id, 'puck-prep');
});

test('taste: sour and bitter together means puck prep', () => {
  const r = analyze({ ...goodShot(), taste: { sour: true, bitter: true, stars: 2 } });
  assert.equal(top(r).id, 'puck-prep');
  assert.match(top(r).why, /both sour and bitter/);
});

test('taste: fast but bitter conflicts, so puck prep and not grind', () => {
  const r = analyze({ ...fastShot(), taste: { balance: 1 } });
  assert.equal(top(r).id, 'puck-prep');
});

test('taste: sour with a fast shot agrees, so higher confidence grind finer', () => {
  const plain = analyze(fastShot());
  const sour = analyze({ ...fastShot(), taste: { balance: -1 } });
  assert.equal(top(sour).id, 'grind-finer');
  assert.ok(top(sour).confidence > top(plain).confidence);
});

test('taste: in-range time but sour suggests a longer ratio', () => {
  const r = analyze({ ...goodShot(), taste: { balance: -1, stars: 3 } });
  assert.equal(top(r).id, 'ratio-longer');
  assert.match(top(r).change, /about 3[4-9](\.\d)? g/);
});

test('taste: in-range time but bitter suggests a shorter ratio', () => {
  const r = analyze({ ...goodShot(), taste: { balance: 1, stars: 3 } });
  assert.equal(top(r).id, 'ratio-shorter');
});

test('taste: weak suggests shorter ratio when time is fine', () => {
  const r = analyze({ ...goodShot(), taste: { balance: 0, strength: -2, stars: 3 } });
  assert.equal(top(r).id, 'strength-weak');
});

test('taste overrides time: fast but balanced and rated 4+ means keep it', () => {
  const r = analyze({ ...fastShot(), taste: { balance: 0, stars: 5 } });
  assert.equal(top(r).id, 'taste-wins');
});

test('one change at a time: tips never repeat a variable (except none)', () => {
  for (const shot of [fastShot(), slowShot(), channelingShot(), gusherShot(), goodShot()]) {
    const vars = analyze({ ...shot, targetYield: 32, taste: { balance: -1 } }).tips.map((t) => t.variable).filter((v) => v !== 'none');
    assert.equal(new Set(vars).size, vars.length);
  }
  assert.ok(analyze(fastShot()).tips.length <= RULES.maxTips);
});

test('low dose in the basket is called out', () => {
  const r = analyze(fastShot({ dose: 13.5 }));
  assert.equal(top(r).id, 'low-dose');
});

test('stopping: drip is reported and an early stop suggested when it overshoots', () => {
  const r = analyze(goodShot({ stopAtG: 33.5, dripG: 3 }));
  assert.ok(r.metrics.dripAfterStopG >= 2.5);
  assert.ok(ids(r).includes('stop-early'));
});

test('late ramp is blonding when flow is otherwise smooth', () => {
  const r = analyze(goodShot({ flowAt: (t) => (t < 15 ? 1.3 * Math.min(1, t / 3) : 1.3 + (t - 15) * 0.22), stopAtG: 29 }));
  assert.ok(r.metrics.lateRamp >= RULES.espresso.lateRamp.blondingRatio, `ramp ${r.metrics.lateRamp}`);
  assert.ok(ids(r).includes('blonding'));
});

test('first drops: early gets a clue, even when time is in range', () => {
  const r = analyze(goodShot({ firstDropS: 3 , stopAtG: 30 , flowAt: (t) => 1.1 * Math.min(1, t / 3)}));
  assert.ok(r.metrics.firstDropS < 5);
  assert.ok(ids(r).includes('first-drops-early'));
});

test('bean age: very fresh and erratic means wait, ahead of puck prep', () => {
  const brew = { ...channelingShot(), startedAt: Date.UTC(2026, 10, 14) };
  const r = analyze(brew, { bean: { roastDate: '2026-11-12' } });
  assert.equal(r.metrics.beanAgeDays, 2);
  assert.equal(top(r).id, 'fresh-beans');
  assert.ok(ids(r).includes('puck-prep'));
});

test('bean age: old beans with a fast shot add a stale note', () => {
  const brew = { ...fastShot(), startedAt: Date.UTC(2026, 10, 14) };
  const r = analyze(brew, { bean: { roastDate: '2026-09-01' } });
  assert.ok(r.metrics.beanAgeDays > 42);
  assert.ok(ids(r).includes('stale-beans'));
});

// ---- missing samples -------------------------------------------------------------------------
test('old brew with totals only still gets a verdict and a tip', () => {
  const r = analyze({ method: 'espresso', dose: 16, yield: 36, timeS: 19 });
  assert.equal(r.verdict, 'Ran fast: 36 g in 19 s.');
  assert.equal(r.metrics.hasSamples, false);
  assert.equal(r.metrics.flowCV, null);
  assert.equal(r.metrics.mainAvgFlow, null);
  assert.equal(top(r).id, 'grind-finer');
});

test('brew without time or samples does not crash', () => {
  const r = analyze({ method: 'espresso', dose: 16, yield: 32 });
  assert.match(r.verdict, /no timing/);
  assert.deepEqual(r.tips, []);
  assert.doesNotThrow(() => analyze({}));
  assert.doesNotThrow(() => analyze(null));
});

test('samples without a flow channel derive flow from weight', () => {
  const b = goodShot();
  delete b.samples.channels.flow;
  const r = analyze(b);
  assert.equal(r.metrics.timeStatus, 'sweet');
  assert.ok(r.metrics.mainAvgFlow > 0.8 && r.metrics.mainAvgFlow < 2);
});

test('samples with only timeS missing derive time and first drops', () => {
  const b = goodShot();
  delete b.timeS;
  delete b.yield;
  const r = analyze(b);
  assert.ok(r.metrics.timeS > 20 && r.metrics.timeS < 32);
  assert.ok(r.metrics.yield > 28);
});

test('unknown channels (pressure, temp) are ignored', () => {
  const b = goodShot();
  const n = b.samples.channels.weight.length;
  b.samples.channels.pressure = new Array(n).fill(9);
  b.samples.channels.temp = new Array(n).fill(93);
  assert.deepEqual(analyze(b).metrics, analyze(goodShot()).metrics);
});

test('too-short or malformed samples fall back to totals', () => {
  const r = analyze({ method: 'espresso', dose: 16, yield: 32, timeS: 28, samples: { hz: 10, t0: 0, channels: { weight: [0, 1], flow: 'x' } } });
  assert.equal(r.metrics.hasSamples, false);
  assert.equal(r.metrics.timeStatus, 'sweet');
});

// ---- history ---------------------------------------------------------------------------------
const hb = (over) => ({ ...goodShot(), beanId: 'bean1', profileId: 'p', ...over });

test('history: went finer, time rose, still fast: keep going', () => {
  const prev = hb({ startedAt: 1, id: 'a', grind: { value: 14 }, timeS: 14, yield: 32 });
  delete prev.samples;
  const cur = hb({ startedAt: 2, id: 'b', grind: { value: 13 }, timeS: 20, yield: 32 });
  delete cur.samples;
  const r = analyze(cur, { history: [prev] });
  assert.equal(top(r).id, 'history-keep-going');
  assert.match(top(r).why, /rose 6 s/);
});

test('history: step had no effect, so take a bigger step', () => {
  const prev = { id: 'a', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 14 }, timeS: 19, yield: 32, dose: 16 };
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 2, grind: { value: 13 }, timeS: 19.5, yield: 32, dose: 16 };
  assert.equal(top(analyze(cur, { history: [prev] })).id, 'history-no-effect');
});

test('history: overshoot after a correct move suggests half a step back', () => {
  const prev = { id: 'a', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 14 }, timeS: 18, yield: 32, dose: 16 };
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 2, grind: { value: 11 }, timeS: 40, yield: 32, dose: 16 };
  const r = analyze(cur, { history: [prev] });
  assert.equal(top(r).id, 'history-overshoot');
});

test('history: grind and time moved opposite ways', () => {
  const prev = { id: 'a', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 14 }, timeS: 20, yield: 32, dose: 16 };
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 2, grind: { value: 13 }, timeS: 15, yield: 32, dose: 16 };
  assert.equal(top(analyze(cur, { history: [prev] })).id, 'history-other-change');
});

test('history: grinderFinerIsHigher flips the direction', () => {
  const prev = { id: 'a', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 13 }, timeS: 14, yield: 32, dose: 16 };
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 2, grind: { value: 14 }, timeS: 20, yield: 32, dose: 16 };
  assert.equal(top(analyze(cur, { history: [prev], gear: { grinderFinerIsHigher: true } })).id, 'history-keep-going');
  assert.match(top(analyze({ ...cur, grind: { value: 14 } }, { history: [{ ...prev, grind: { value: 13 } }], gear: { grinderFinerIsHigher: true } })).change, /again \(try 15\)/);
});

test('history ignores other beans, later brews, deleted and other methods', () => {
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 10, grind: { value: 13 }, timeS: 19, yield: 32, dose: 16 };
  const others = [
    { id: 'x', method: 'espresso', beanId: 'other', startedAt: 1, grind: { value: 14 }, timeS: 14 },
    { id: 'y', method: 'espresso', beanId: 'bean1', startedAt: 20, grind: { value: 14 }, timeS: 14 },
    { id: 'z', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 14 }, timeS: 14, deleted: true },
    { id: 'w', method: 'moka', beanId: 'bean1', startedAt: 1, grind: { value: 14 }, timeS: 14 },
  ];
  assert.equal(top(analyze(cur, { history: others })).id, 'grind-finer');
});

test('history: three fast shots in a row raises confidence', () => {
  const mk = (i) => ({ id: `h${i}`, method: 'espresso', beanId: 'bean1', startedAt: i, timeS: 18, yield: 32, dose: 16 });
  const cur = { id: 'c', method: 'espresso', beanId: 'bean1', startedAt: 9, timeS: 18, yield: 32, dose: 16 };
  const alone = analyze(cur);
  const rep = analyze(cur, { history: [mk(1), mk(2)] });
  assert.ok(top(rep).confidence > top(alone).confidence);
  assert.match(top(rep).why, /3rd fast shot in a row/);
});

test('history: same grind but very different time flags inconsistent prep', () => {
  const prev = { id: 'a', method: 'espresso', beanId: 'bean1', startedAt: 1, grind: { value: 13 }, timeS: 20, yield: 32, dose: 16 };
  const cur = { id: 'b', method: 'espresso', beanId: 'bean1', startedAt: 2, grind: { value: 13 }, timeS: 28, yield: 32, dose: 16 };
  assert.ok(ids(analyze(cur, { history: [prev] })).includes('history-inconsistent'));
});

// ---- dialled in ------------------------------------------------------------------------------
test('dialled in: two consecutive in-range shots rated 4+', () => {
  const mk = (id, t, stars) => ({ id, method: 'espresso', beanId: 'bean1', startedAt: Number(id.slice(1)), timeS: t, yield: 32, dose: 16, taste: { balance: 0, stars } });
  const a = mk('s1', 27, 4);
  const b = mk('s2', 28, 5);
  const r = analyze(b, { history: [a] });
  assert.equal(r.metrics.dialledIn, true);
  assert.equal(top(r).id, 'dialled-in');
  // not dialled in if the previous one was rated 3, or out of range
  assert.equal(analyze(b, { history: [mk('s1', 27, 3)] }).metrics.dialledIn, false);
  assert.equal(analyze(b, { history: [mk('s1', 18, 5)] }).metrics.dialledIn, false);
  assert.equal(analyze({ ...b, taste: { balance: 0, stars: 3 } }, { history: [a] }).metrics.dialledIn, false);
  assert.equal(findDialledIn([mk('s0', 18, 5), a, b]), 's2');
  assert.equal(findDialledIn([a, mk('s2', 28, 2), mk('s3', 27, 5)]), null);
});

// ---- other methods ---------------------------------------------------------------------------
const bloomPlan = [
  { kind: 'bloom', targetG: 30, atS: 0, durationS: 10, label: 'Bloom' },
  { kind: 'pour', targetG: 150, atS: 45, durationS: 30, label: 'First pour' },
  { kind: 'pour', targetG: 250, atS: 90, durationS: 25, label: 'Second pour' },
];
const pourOver = (o = {}) => pourTimeline({ pours: [[0, 8, 30], [45, 75, 120], [90, 115, 100]], totalS: 195, ...o });

test('pour-over: on-plan brew has metrics, drawdown and adherence', () => {
  const r = analyze(pourOver(), { steps: bloomPlan });
  assert.equal(r.metrics.pours, 3);
  assert.ok(Math.abs(r.metrics.pourEndS - 115) < 2);
  assert.ok(Math.abs(r.metrics.drawdownS - 80) < 3);
  assert.equal(r.metrics.adherence, 1);
  assert.equal(r.metrics.steps.length, 3);
  assert.match(r.verdict, /3:15/);
});

test('pour-over: fast total time with sour taste means grind finer', () => {
  const r = analyze({ ...pourOver({ totalS: 125 }), taste: { balance: -1 } }, { method: 'pour-over' });
  assert.equal(top(r).id, 'grind-finer');
  assert.match(top(r).why, /sour/);
});

test('pour-over: long drawdown means grind coarser (drawdown card)', () => {
  const r = analyze(pourOver({ totalS: 215 }));
  assert.ok(r.metrics.drawdownS > 90);
  assert.equal(top(r).id, 'grind-coarser');
  assert.equal(top(r).learnCard, LEARN.drawdown);
});

test('pour-over: poor adherence is flagged', () => {
  const late = pourOver({ pours: [[10, 18, 30], [70, 100, 120], [130, 155, 100]], totalS: 240 });
  const r = analyze(late, { steps: bloomPlan, method: 'pour-over' });
  assert.ok(r.metrics.adherence < 0.5);
  assert.ok(ids(r).includes('follow-steps'));
});

test('pour-over: taste and time disagree means pouring technique', () => {
  const r = analyze({ ...pourOver({ totalS: 125 }), taste: { balance: 1 } });
  assert.equal(top(r).id, 'pour-technique');
});

test('immersion: short AeroPress steep with sour taste means steep longer', () => {
  const b = pourTimeline({ method: 'aeropress', dose: 12, pours: [[0, 10, 200]], totalS: 60 });
  const r = analyze({ ...b, taste: { balance: -1 } });
  assert.ok(Math.abs(r.metrics.steepS - 50) < 1.5, `steep ${r.metrics.steepS}`);
  assert.equal(r.metrics.timeStatus, 'short');
  assert.equal(top(r).id, 'steep-longer');
  assert.match(r.verdict, /^Steeped 50 s/);
});

test('immersion: French press, long steep with bitter taste means steep shorter', () => {
  const b = pourTimeline({ method: 'french-press', dose: 30, pours: [[0, 20, 500]], totalS: 900 });
  const r = analyze({ ...b, taste: { balance: 1 } });
  assert.equal(r.metrics.timeStatus, 'long');
  assert.equal(top(r).id, 'steep-shorter');
});

test('immersion: in-window steep with sour taste still steeps longer; conflict means stir evenly', () => {
  const b = pourTimeline({ method: 'prestina', dose: 14, pours: [[0, 10, 220]], totalS: 100 });
  assert.equal(top(analyze({ ...b, taste: { balance: -1 } })).id, 'steep-longer');
  const short = pourTimeline({ method: 'aeropress', dose: 12, pours: [[0, 10, 200]], totalS: 40 });
  assert.equal(top(analyze({ ...short, taste: { balance: 1 } })).id, 'stir-evenly');
});

test('moka: sputtering at the end suggests removing from heat sooner', () => {
  const b = pourTimeline({ method: 'moka', dose: 17, pours: [[20, 120, 40], [120, 150, 40]], totalS: 160 });
  const r = analyze(b);
  assert.ok(r.metrics.lateRamp >= RULES.moka.lateRamp.spurtRatio, `ramp ${r.metrics.lateRamp}`);
  assert.equal(top(r).id, 'moka-stop');
});

test('unknown method returns metrics and no tips', () => {
  const r = analyze({ method: 'cold-brew', dose: 50, yield: 500, timeS: 43200 });
  assert.deepEqual(r.tips, []);
  assert.equal(r.metrics.yield, 500);
});

// ---- learn cards -----------------------------------------------------------------------------
test('every learn id referenced by a rule or tip exists', () => {
  for (const id of Object.values(LEARN)) assert.ok(CARDS_BY_ID[id], `missing card ${id}`);
  const brews = [goodShot(), fastShot(), gusherShot(), slowShot(), channelingShot(), pourOver(), { dose: 16, yield: 36, timeS: 19 }];
  for (const b of brews) {
    for (const taste of [undefined, { balance: -2 }, { balance: 2 }, { sour: true, bitter: true }, { balance: 0, strength: -1 }, { balance: 0, stars: 5, spurts: true }]) {
      const r = analyze({ ...b, taste }, { method: b.method });
      for (const t of r.tips) assert.ok(!t.learnCard || CARDS_BY_ID[t.learnCard], `${t.id} -> ${t.learnCard}`);
      for (const id of r.learn) assert.ok(getCard(id), id);
    }
  }
});

test('cards are well formed', () => {
  assert.ok(CARDS.length >= 20 && CARDS.length <= 28);
  assert.equal(new Set(CARDS.map((c) => c.id)).size, CARDS.length);
  for (const c of CARDS) {
    for (const k of ['id', 'title', 'body', 'topic']) assert.equal(typeof c[k], 'string', `${c.id}.${k}`);
    assert.ok(Array.isArray(c.methods) && c.methods.length, `${c.id}.methods`);
    const sentences = c.body.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentences >= 3 && sentences <= 6, `${c.id} has ${sentences} sentences`);
    if (c.diagram) assert.match(c.diagram, /^<svg[\s\S]*<\/svg>$/);
  }
});

// ---- brew-session record() shapes ------------------------------------------------------------
// brew-session's record(): { method, dose, yield, targetYield, ratio, timeS, startSource, doneReason, samples,
// firstDropS? (only when the user started the timer), stopLeadG, stopS, dripAfterStopG }.
function sessionRecord(shot, source) {
  const first = shot.samples.channels.weight.findIndex((x) => x >= 0.5);
  const stopAbs = shot.timeS;
  const base = {
    method: 'espresso', dose: shot.dose, yield: shot.yield, targetYield: 32, ratio: Math.round((shot.yield / shot.dose) * 100) / 100,
    startSource: source, doneReason: 'target', stopLeadG: 2, gear: shot.gear,
  };
  if (source === 'auto') {
    const t0 = first / 10; // the timer starts at the first drops
    return {
      ...base, timeS: Math.round((stopAbs - t0) * 10) / 10, stopS: Math.round((stopAbs - t0) * 10) / 10,
      dripAfterStopG: 1.5,
      samples: { hz: 10, t0: 0, channels: { weight: shot.samples.channels.weight.slice(first), flow: shot.samples.channels.flow.slice(first) } },
    };
  }
  return { ...base, timeS: stopAbs, stopS: stopAbs, firstDropS: first / 10, dripAfterStopG: 1.5, samples: shot.samples };
}

test('auto-start: good shot is judged on pump time, no false first-drops tip', () => {
  const rec = sessionRecord(goodShot(), 'auto');
  assert.ok(rec.timeS < 22, `auto timer ${rec.timeS}`); // would read "fast" without the lag
  const r = analyze(rec);
  assert.equal(r.metrics.firstDropS, null);
  assert.equal(r.metrics.timeStatus, 'sweet');
  assert.ok(!ids(r).some((i) => i.startsWith('first-drops')));
  assert.match(r.verdict, /^Right on target: .* from first drops\.$/);
  assert.ok(r.metrics.mainAvgFlow > 0.8, 'flow metrics still computed from t=0');
});

test('auto-start: a really fast shot is still fast and still gets grind finer', () => {
  const r = analyze(sessionRecord(fastShot(), 'auto'));
  assert.equal(r.metrics.timeStatus, 'fast');
  assert.equal(top(r).id, 'grind-finer');
  assert.ok(!ids(r).includes('first-drops-early'));
  assert.match(top(r).why, /about \d+ s/i);
});

test('auto-start: confidence is a little lower than for a user-started timer', () => {
  const auto = top(analyze(sessionRecord(fastShot(), 'auto')));
  const user = top(analyze(sessionRecord(fastShot(), 'user')));
  assert.ok(auto.confidence < user.confidence);
});

test('user-start: first drops come from the record and keep today\'s behaviour', () => {
  const rec = sessionRecord(goodShot({ firstDropS: 3, stopAtG: 30, flowAt: (t) => 1.1 * Math.min(1, t / 3) }), 'user');
  const r = analyze(rec);
  assert.ok(r.metrics.firstDropS < 5);
  assert.ok(ids(r).includes('first-drops-early'));
  assert.doesNotMatch(r.verdict, /first drops\./);
  // missing startSource behaves like a user start
  const { startSource, ...noSource } = rec;
  assert.equal(analyze(noSource).metrics.timeStatus, r.metrics.timeStatus);
});

test('auto-start: an explicit firstDropS wins over the samples', () => {
  const r = analyze({ ...sessionRecord(goodShot(), 'auto'), firstDropS: 3 });
  assert.equal(r.metrics.firstDropS, 3);
  assert.ok(ids(r).includes('first-drops-early'));
});

test('auto-start lag is tunable and drip from the record is trusted', () => {
  const rec = { ...sessionRecord(goodShot(), 'auto'), dripAfterStopG: 4 };
  const rules = { ...RULES, espresso: { ...RULES.espresso, autoStartLagS: 0 } };
  assert.equal(analyze(rec, { rules }).metrics.timeStatus, 'fast');
  assert.equal(analyze(rec).metrics.dripAfterStopG, 4);
  assert.ok(ids(analyze({ ...rec, yield: 34.5 })).includes('stop-early'));
});

test('auto-start history: previous auto shots use pump-equivalent time too', () => {
  const prev = { ...sessionRecord(goodShot(), 'auto'), id: 'a', beanId: 'b1', startedAt: 1, taste: { balance: 0, stars: 4 } };
  const cur = { ...sessionRecord(goodShot({ seed: 5 }), 'auto'), id: 'b', beanId: 'b1', startedAt: 2, taste: { balance: 0, stars: 5 } };
  assert.equal(analyze(cur, { history: [prev] }).metrics.dialledIn, true);
});

test('auto-start only changes espresso: moka keeps its flow metrics', () => {
  const b = pourTimeline({ method: 'moka', dose: 17, pours: [[20, 120, 40], [120, 150, 40]], totalS: 160 });
  const r = analyze({ ...b, startSource: 'auto' });
  assert.ok(r.metrics.firstDropS > 0);
  assert.ok(r.metrics.lateRamp >= RULES.moka.lateRamp.spurtRatio);
});

test('auto-start: every tip is less confident than for the same shot started by hand', () => {
  const mk = (src) => analyze({ ...sessionRecord(fastShot(), src), taste: { balance: -1, stars: 2 } });
  const [a, u] = [mk('auto'), mk('user')];
  assert.equal(top(a).id, top(u).id);
  assert.ok(top(a).confidence < top(u).confidence);
  const tw = (src) => analyze({ ...sessionRecord(fastShot(), src), taste: { balance: 0, stars: 5 } }).tips[0];
  assert.equal(tw('auto').id, 'taste-wins');
  assert.ok(tw('auto').confidence < tw('user').confidence);
  assert.match(tw('auto').why, /about \d+ s/);
});

test('mixed manual and auto history compares on the pump-time basis', () => {
  const manual = { ...goodShot(), id: 'm', beanId: 'b1', startedAt: 1, grind: { value: 13 } };
  const auto = { ...sessionRecord(goodShot({ seed: 4 }), 'auto'), id: 'a', beanId: 'b1', startedAt: 2, grind: { value: 13 } };
  const r = analyze(auto, { history: [manual] });
  assert.ok(!ids(r).includes('history-inconsistent'), ids(r).join());
});
