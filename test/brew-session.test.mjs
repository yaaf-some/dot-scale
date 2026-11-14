import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrewSession, suggestEarlyStopG, downsample } from '../app/core/brew-session.js';
import { defaultRecipe } from '../app/methods/index.js';

// ---------- a tiny simulated scale ----------
// `load` is the true weight on the scale; the rig quantises to 0.1 g, adds noise, applies tare commands (0.3 s lag),
// and feeds the session at `dt`. Scenarios script the world with rig.at(t, fn) and rig.physics.
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeRig(session, { noise = 0.04, seed = 7, dt = 0.1 } = {}) {
  const rng = mulberry32(seed);
  const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.73; // ~N(0,1)
  const rig = {
    recorder: () => session.record(),
    t: 0, dt, load: 0, offset: 0, tareAt: null, prev: 0, physics: null, sched: [],
    events: [], cues: [], commands: [], states: [], last: null,
    at(t, fn) { rig.sched.push([t, fn]); rig.sched.sort((a, b) => a[0] - b[0]); },
    take(out) {
      rig.last = out; rig.states.push(out.state);
      rig.events.push(...out.events); rig.cues.push(...out.cues);
      for (const c of out.commands) { rig.commands.push(c); if (c.cmd === 'tare') rig.tareAt = rig.t + 0.3; }
    },
    send(e) { rig.take(session.dispatch({ ...e, t: rig.t })); },
    tick() {
      rig.t = Math.round((rig.t + rig.dt) * 1000) / 1000;
      while (rig.sched.length && rig.sched[0][0] <= rig.t + 1e-9) rig.sched.shift()[1](rig);
      rig.physics?.(rig.t, rig.dt, rig);
      if (rig.tareAt != null && rig.t >= rig.tareAt) { rig.offset = rig.load; rig.tareAt = null; }
      const grams = Math.round((rig.load - rig.offset + noise * gauss()) * 10) / 10;
      const flow = Math.max(0, (grams - rig.prev) / rig.dt); // like the real scale: coarse and clamped
      rig.prev = grams;
      rig.take(session.feed({ t: rig.t, grams, flow }));
    },
    run(until) { while (rig.t < until - 1e-9) rig.tick(); },
    runWhile(cond, max = 600) { const end = rig.t + max; while (cond() && rig.t < end) rig.tick(); },
    when: (type) => rig.events.find((e) => e.type === type),
    cmds: (name) => rig.commands.filter((c) => c.cmd === name),
    cueIds: () => rig.cues.map((c) => c.id),
    get state() { return rig.last.state; },
  };
  return rig;
}

// Espresso world: portafilter with beans on the scale, then removed, cup placed, pump on. Flow comes from a simple pump model.
function espressoRig(opts = {}) {
  const { recipe = defaultRecipe('espresso'), history, stallAtG, stallS = 4, stallForever = false, seed = 7, reaction = 0.5, settings } = opts;
  const session = createBrewSession({ method: 'espresso', recipe, history, settings });
  const rig = makeRig(session, { seed });
  const w = { cup: 0, cupOn: false, pf: 0, pump: false, pumpT: null, offT: null, stall: null, stalled: false, flow: 0, firstFlowT: null };
  rig.w = w;
  rig.physics = (t, dt) => {
    let f = 0;
    if (w.pump) {
      const tau = t - w.pumpT;
      f = tau < 7 ? 0 : Math.min(1.3, 0.25 + (tau - 7) * 0.35);
      if (w.firstFlowT == null && f > 0) w.firstFlowT = t;
      if (stallAtG != null && !w.stalled && w.cup >= stallAtG) { w.stalled = true; w.stall = { from: t, to: stallForever ? Infinity : t + stallS }; }
      if (w.stall && t >= w.stall.from && t < w.stall.to) f = 0.02;
    } else if (w.offT != null) f = 1.3 * Math.exp(-(t - w.offT) / 1.2);
    if (w.offT != null && f < 0.02) f = 0;
    w.flow = f;
    w.cup += f * dt;
    rig.load = w.pf + (w.cupOn ? 110 + w.cup : 0);
  };
  // stop the pump `reaction` s after the "stop the pump" cue
  const origTake = rig.take;
  rig.take = (out) => {
    origTake(out);
    if (out.cues.some((c) => c.id === 'espresso:stop') && w.pump && w.offT == null) rig.at(rig.t + reaction, () => { w.pump = false; w.offT = rig.t; });
  };
  if (settings) rig.settings = settings;
  // script: begin, beans in the portafilter, use as dose, remove it, put the cup on
  rig.send({ type: 'begin' });
  w.pf = 16;
  rig.run(3);
  return rig;
}
function espressoToReady(rig, cupAt = 8) {
  const w = rig.w;
  rig.send({ type: 'useAsDose' });
  rig.at(5, () => { w.pf = 0; });
  rig.at(cupAt, () => { w.cupOn = true; });
  rig.runWhile(() => rig.state.phase !== 'ready', 120);
}
const pumpOn = (rig) => { rig.w.pump = true; rig.w.pumpT = rig.t; };

// ---------- helpers ----------
test('downsample resamples to 10 Hz with interpolation', () => {
  const raw = [{ t: 100, g: 0, f: 0 }, { t: 100.5, g: 5, f: 10 }, { t: 102, g: 20, f: 10 }];
  const d = downsample(raw, 100, 102, 10);
  assert.equal(d.hz, 10);
  assert.equal(d.t0, 0);
  assert.equal(d.channels.weight.length, 21);
  assert.equal(d.channels.weight[0], 0);
  assert.equal(d.channels.weight[5], 5);
  assert.equal(d.channels.weight[20], 20);
  assert.equal(d.channels.flow.length, 21);
});

test('suggestEarlyStopG learns the drip from history', () => {
  const b = (drip, extra = {}) => ({ type: 'brew', method: 'espresso', dripAfterStopG: drip, startedAt: 1, ...extra });
  assert.equal(suggestEarlyStopG([]), null);
  assert.equal(suggestEarlyStopG([b(2)]), null, 'one shot is not enough');
  assert.equal(suggestEarlyStopG([b(2), b(3), b(2.4)]), 2.4);
  assert.equal(suggestEarlyStopG([b(0.1), b(0.2)]), 0.5, 'clamped low');
  assert.equal(suggestEarlyStopG([b(9), b(8)]), 6, 'clamped high');
  assert.equal(suggestEarlyStopG([{ method: 'espresso', metrics: { dripAfterStopG: 1.5 } }, { method: 'espresso', metrics: { dripAfterStopG: 2.5 } }]), 2);
  assert.equal(suggestEarlyStopG([b(3, { method: 'pour-over' }), b(3, { deleted: true }), b(3, { profileId: 'x' }), b(1, { profileId: 'y' })], { profileId: 'y' }), null, 'filters other methods, deleted and profiles');
  const newest = [b(5, { startedAt: 1 }), b(5, { startedAt: 2 }), b(1, { startedAt: 30 }), b(1, { startedAt: 31 })];
  assert.equal(suggestEarlyStopG(newest, { n: 2 }), 1, 'recent shots count most');
});

// ---------- espresso ----------
test('espresso: normal shot, hands-off from dose to done', () => {
  const rig = espressoRig();
  espressoToReady(rig);
  const s0 = rig.state;
  assert.equal(s0.phase, 'ready');
  assert.equal(s0.doseG, 16);
  assert.equal(rig.cmds('tare').length, 1, 'one auto-tare when the cup was placed');
  assert.ok(rig.t > 8, 'tare happened after the cup was placed');
  assert.ok(rig.cmds('timer:reset').length >= 1);
  assert.equal(rig.cmds('timer:start').length, 0);
  rig.run(rig.t + 5);
  assert.equal(rig.state.phase, 'ready', 'still waiting for the pump');
  pumpOn(rig);
  rig.runWhile(() => rig.state.phase !== 'done', 90);

  const st = rig.state;
  assert.equal(st.phase, 'done');
  assert.equal(st.done.reason, 'target');
  assert.equal(rig.cmds('timer:start').length, 1);
  assert.equal(rig.cmds('timer:stop').length, 1);
  assert.equal(rig.when('start').source, 'auto');
  const phases = rig.events.filter((e) => e.type === 'espresso:phase').map((e) => e.phase);
  assert.deepEqual(phases, ['main-flow', 'finishing']);
  const stopCue = rig.cues.find((c) => c.id === 'espresso:stop');
  assert.ok(stopCue, 'stop the pump cue');
  assert.ok(stopCue.grams >= 29.5 && stopCue.grams <= 31, `cue near 2 g before target, got ${stopCue.grams}`);

  const r = rig.recorder();
  assert.ok(r.yield > 31.5 && r.yield < 33.5, `yield ${r.yield}`);
  assert.equal(r.dose, 16);
  assert.equal(r.targetYield, 32);
  assert.equal(r.startSource, 'auto');
  assert.equal(r.firstDropS, undefined, 'auto-start does not know the pump start, so no first-drop time');
  // pump stopped at w.offT; the shot time should match (counted from the auto-started timer)
  const truth = rig.w.offT - rig.w.firstFlowT;
  assert.ok(Math.abs(r.timeS - truth) < 1.0, `timeS ${r.timeS} vs ${truth.toFixed(1)}`);
  assert.ok(r.dripAfterStopG > 0.5 && r.dripAfterStopG < 3.5, `drip ${r.dripAfterStopG}`);
  const { weight, flow } = r.samples.channels;
  assert.equal(r.samples.hz, 10);
  assert.equal(weight.length, flow.length);
  assert.ok(weight.length > r.timeS * 10, 'samples keep the tail after the pump stopped');
  assert.ok(weight[0] < 0.8);
  assert.ok(Math.abs(weight[weight.length - 1] - r.yield) < 0.8);
  assert.ok(Math.max(...flow) > 1 && Math.max(...flow) < 2);
});

test('espresso: manual start records first-drop time and shows the waiting phase', () => {
  const rig = espressoRig();
  espressoToReady(rig);
  rig.send({ type: 'start' }); pumpOn(rig);
  rig.runWhile(() => rig.state.phase === 'running' && rig.state.espresso.phase === 'waiting', 30);
  assert.equal(rig.states.some((s) => s.espresso?.phase === 'waiting'), true);
  rig.runWhile(() => rig.state.phase !== 'done', 90);
  assert.equal(rig.state.done.reason, 'target');
  const first = rig.when('first-drops');
  assert.ok(first && Math.abs(first.atS - 7) < 1.0, `first drops at ${first?.atS}`);
  const phases = rig.events.filter((e) => e.type === 'espresso:phase').map((e) => e.phase);
  assert.deepEqual(phases, ['main-flow', 'finishing']);
  const r = rig.recorder();
  assert.equal(r.startSource, 'manual');
  assert.ok(Math.abs(r.firstDropS - 7) < 1.0);
  assert.ok(r.timeS > 20 && r.timeS < 40, `timeS ${r.timeS}`);
  assert.ok(Math.abs(r.samples.channels.weight[Math.round(r.timeS * 10)] - r.yield) < 3);
});

test('espresso: learned drip moves the stop cue earlier', () => {
  const history = [3, 3.2, 2.8].map((d, i) => ({ method: 'espresso', dripAfterStopG: d, startedAt: i }));
  const rig = espressoRig({ history });
  assert.equal(rig.state.espresso.stopLeadG, 3);
  assert.equal(rig.state.espresso.learnedLeadG, 3);
  assert.equal(rig.state.espresso.stopAtG, 29);
  espressoToReady(rig);
  pumpOn(rig);
  rig.runWhile(() => rig.state.phase !== 'done', 90);
  const cue = rig.cues.find((c) => c.id === 'espresso:stop');
  assert.ok(cue.grams >= 28.9 && cue.grams < 30.5, `cue at ${cue.grams}`);
  assert.equal(cue.leadG, 3);
});

test('espresso: a stall mid-shot does not end the shot, and the flow can resume', () => {
  const rig = espressoRig({ stallAtG: 10, stallS: 4 });
  espressoToReady(rig);
  pumpOn(rig);
  rig.runWhile(() => !rig.w.stalled, 60);
  rig.run(rig.t + 3.9);
  assert.equal(rig.state.phase, 'running', 'not done during a 4 s stall far from target');
  rig.runWhile(() => rig.state.phase !== 'done', 90);
  assert.equal(rig.state.done.reason, 'target');
  assert.ok(rig.state.done.yieldG > 31);
});

test('espresso: a stall that never ends cues once, then finishes as idle with what was collected', () => {
  const rig = espressoRig({ stallAtG: 10, stallForever: true });
  espressoToReady(rig);
  pumpOn(rig);
  rig.runWhile(() => rig.state.phase !== 'done', 120);
  assert.equal(rig.state.done.reason, 'idle');
  assert.equal(rig.cues.filter((c) => c.id === 'espresso:stall').length, 1);
  assert.ok(rig.state.done.yieldG > 9 && rig.state.done.yieldG < 12);
  assert.equal(rig.cues.some((c) => c.id === 'espresso:stop'), false);
});

test('espresso: cup placed late still tares, and nothing starts before', () => {
  const rig = espressoRig();
  espressoToReady(rig, 30);
  assert.equal(rig.state.phase, 'ready');
  assert.ok(rig.cmds('tare').length === 1 && rig.cmds('tare')[0].t >= 30, 'tare only after the cup landed');
  assert.ok(rig.states.filter((s) => s.t > 3.5 && s.t < 30).every((s) => s.phase === 'prep' && s.prepStep === 'cup'), 'waited in prep');
  assert.ok(rig.cues.some((c) => c.id === 'cup'));
  assert.equal(rig.cmds('timer:start').length, 0);
});

test('espresso: dose capture needs a stable weight, and beans on the scale', () => {
  const session = createBrewSession({ method: 'espresso' });
  const rig = makeRig(session);
  rig.send({ type: 'begin' });
  rig.run(1);
  rig.send({ type: 'useAsDose' });
  assert.equal(rig.state.doseG, null, 'empty scale');
  assert.ok(rig.cueIds().includes('dose:empty') || rig.cueIds().includes('dose:unstable'));
  rig.physics = (t) => { rig.load = 5 + t * 3; }; // someone is still moving beans
  rig.run(3);
  rig.send({ type: 'useAsDose' });
  assert.equal(rig.state.doseG, null);
  assert.ok(rig.cueIds().includes('dose:unstable'));
  rig.physics = null; rig.load = 16.2;
  rig.run(5);
  assert.equal(rig.state.canUseAsDose, true);
  rig.send({ type: 'useAsDose' });
  assert.equal(rig.state.doseG, 16.2);
  assert.equal(rig.state.prepStep, 'cup');
});

test('manual tare path: autoTare off asks the user and waits for the tare', () => {
  const rig = espressoRig({ settings: { autoTare: false } });
  espressoToReady(rig, 8);
  assert.equal(rig.state.phase, 'prep', 'no auto-tare, so still prepping');
  assert.equal(rig.cmds('tare').length, 0);
  rig.offset = rig.load; // the user presses tare on the scale
  rig.send({ type: 'tare' });
  rig.run(rig.t + 2);
  assert.equal(rig.state.phase, 'ready');
});

test('espresso: skipDose uses the recipe dose', () => {
  const session = createBrewSession({ method: 'espresso' });
  const rig = makeRig(session);
  rig.send({ type: 'begin' });
  rig.send({ type: 'skipDose' });
  assert.equal(rig.state.doseG, 16);
  assert.equal(rig.state.prepStep, 'cup');
});

// ---------- false triggers ----------
function readyRig(seed = 3, noise = 0.05) {
  const session = createBrewSession({ method: 'pour-over' });
  const rig = makeRig(session, { seed, noise });
  rig.send({ type: 'begin' });
  rig.load = 15; rig.run(2);
  rig.send({ type: 'useAsDose' });
  rig.load = 15; // coffee stays on the scale, tare right away
  rig.runWhile(() => rig.state.phase !== 'ready', 20);
  assert.equal(rig.state.phase, 'ready');
  return rig;
}

test('noisy readings around zero never start the timer', () => {
  for (const [seed, noise] of [[1, 0.04], [2, 0.06], [3, 0.08], [4, 0.1], [5, 0.12]]) {
    const rig = readyRig(seed, noise);
    rig.run(rig.t + 120);
    assert.equal(rig.state.phase, 'ready', `seed ${seed} noise ${noise}`);
    assert.equal(rig.cmds('timer:start').length, 0);
  }
});

test('noise also leaves the empty-scale prep alone', () => {
  const session = createBrewSession({ method: 'espresso' });
  const rig = makeRig(session, { noise: 0.1 });
  rig.send({ type: 'begin' });
  rig.run(60);
  assert.equal(rig.state.phase, 'prep');
  assert.equal(rig.state.prepStep, 'dose');
  assert.equal(rig.commands.length, 0);
});

test('a bump or knock on the scale does not start the timer', () => {
  const rig = readyRig(11);
  const t0 = rig.t;
  // 1) sharp spike +6 g for 0.3 s
  rig.at(t0 + 5, (r) => { r.load += 6; }); rig.at(t0 + 5.3, (r) => { r.load -= 6; });
  // 2) a damped knock, +-1.5 g wobbling over ~1 s
  for (let k = 0; k < 10; k++) rig.at(t0 + 15 + k * 0.1, (r) => { r.knock = 1.5 * Math.exp(-k / 4) * (k % 2 ? -1 : 1); r.load = 15 + r.knock; });
  rig.at(t0 + 16.2, (r) => { r.load = 15; });
  // 3) a quick press and release: +4 g over 0.3 s, held 0.2 s, back
  [1, 2, 3].forEach((k) => rig.at(t0 + 25 + k * 0.1, (r) => { r.load = 15 + k * 1.3; }));
  rig.at(t0 + 25.5, (r) => { r.load = 15; });
  rig.run(t0 + 40);
  assert.equal(rig.state.phase, 'ready');
  assert.equal(rig.cmds('timer:start').length, 0);
  assert.ok(rig.events.some((e) => e.type === 'disturbance'));
});

test('a cup nudged to a new resting weight is re-tared, not started', () => {
  const rig = readyRig(12);
  const t0 = rig.t;
  rig.at(t0 + 3, (r) => { r.load += 8; }); // someone puts a hand/dripper-lid weight on and leaves it
  rig.run(t0 + 12);
  assert.equal(rig.state.phase, 'ready');
  assert.equal(rig.cmds('timer:start').length, 0);
  assert.equal(rig.cmds('tare').length, 2, 'initial tare plus one re-tare');
  assert.ok(Math.abs(rig.state.grams) < 0.5);
});

// ---------- pour-over ----------
test('pour-over: steps advance by weight and time, ending when the dripper is lifted', () => {
  const rig = readyRig(21);
  let water = 0;
  let rate = 0;
  const base = 15;
  rig.physics = (t, dt, r) => { water += rate * dt; r.load = base + water + (r.dripperOff ? -140 : 0); };
  const t0 = rig.t + 2; // pour starts here
  rig.at(t0, () => { rate = 3.75; });          // bloom: 30 g in 8 s
  rig.at(t0 + 8, () => { rate = 0; });
  rig.at(t0 + 45, () => { rate = 4.5; });      // pour to 150 g, starts at the planned time
  rig.at(t0 + 45 + 120 / 4.5, () => { rate = 0; });
  rig.at(t0 + 90, () => { rate = 5; });        // pour to 250 g
  rig.at(t0 + 90 + 100 / 5, () => { rate = 0; });
  rig.at(t0 + 195, (r) => { r.dripperOff = true; });
  rig.runWhile(() => rig.state.phase !== 'done', 400);

  assert.equal(rig.state.phase, 'done');
  assert.equal(rig.state.done.reason, 'removed');
  assert.equal(rig.when('start').source, 'auto');
  assert.ok(rig.cmds('timer:start')[0].t0 >= t0 - 1 && rig.cmds('timer:start')[0].t0 <= t0 + 1.5);
  const steps = rig.events.filter((e) => e.type === 'step').map((e) => e.index);
  assert.deepEqual(steps, [0, 1, 2, 3]);
  const startS = rig.events.filter((e) => e.type === 'step').map((e) => e.step.atS);
  assert.deepEqual(startS, [0, 45, 90, 120]);
  assert.ok(rig.cueIds().includes('step:0:reached'), 'bloom reached');
  assert.ok(rig.cueIds().includes('step:1:soon'), 'heads-up before the first pour');
  assert.ok(rig.cueIds().includes('step:2:reached'));
  // state exposed while running: current target and next cue
  const mid = rig.states.find((s) => s.brew?.index === 1 && s.phase === 'running');
  assert.equal(mid.brew.targetG, 150);
  assert.equal(mid.brew.nextCue.targetG, 250);
  assert.equal(mid.brew.nextCue.atS, 90);
  assert.ok(mid.brew.countdownS <= 45 && mid.brew.countdownS > 0);
  const r = rig.recorder();
  assert.ok(Math.abs(r.yield - 250) < 3, `yield ${r.yield}`);
  assert.equal(r.dose, 15);
  assert.ok(r.timeS > 185 && r.timeS < 205, `time ${r.timeS}`);
  assert.equal(r.stepLog.length, 4);
  assert.ok(r.pourEndS > 100 && r.pourEndS < 125);
  assert.equal(r.samples.channels.weight.length, Math.floor((rig.state.done.t - rig.state.startT) * 10 + 1e-6) + 1);
  assert.equal(r.firstDropS, undefined);
});

test('pour-over: a slow pour holds the next step until the weight is reached (then grace)', () => {
  const rig = readyRig(22);
  let water = 0; let rate = 0;
  rig.physics = (t, dt, r) => { water += rate * dt; r.load = 15 + water; };
  const t0 = rig.t + 1;
  rig.at(t0, () => { rate = 4; });          // bloom 30 in 7.5 s
  rig.at(t0 + 7.5, () => { rate = 0; });
  rig.at(t0 + 45, () => { rate = 1.5; });   // very slow: 120 g needs 80 s, so step 2 (planned t=90) must wait
  rig.run(t0 + 100);
  assert.equal(rig.state.brew.index, 1, 'still pouring step 1 at 100 s? grace is 15 s, so 105 s is the cut-off');
  rig.run(t0 + 106);
  assert.equal(rig.state.brew.index, 2, 'grace period expired, moved on');
});

// ---------- immersion ----------
test('immersion: French press countdown with stir, skim and plunge cues', () => {
  const session = createBrewSession({ method: 'french-press' });
  const rig = makeRig(session, { seed: 31 });
  rig.send({ type: 'begin' });
  rig.load = 30; rig.run(2);
  rig.send({ type: 'useAsDose' });
  rig.runWhile(() => rig.state.phase !== 'ready', 20);
  assert.equal(rig.state.doseG, 30);
  let water = 0; let rate = 0;
  rig.physics = (t, dt, r) => { water += rate * dt; r.load = 30 + water + (r.press || 0); };
  const t0 = rig.t + 1;
  rig.at(t0, () => { rate = 25; });
  rig.at(t0 + 20, () => { rate = 0; });
  rig.run(t0 + 30);
  assert.equal(rig.state.phase, 'running');
  rig.dt = 1; // the rest of the brew is slow: 1 Hz is plenty
  const startT = rig.state.startT;
  rig.runWhile(() => rig.t < startT + 235, 400);
  assert.equal(rig.state.brew.step.kind, 'wait');
  assert.ok(rig.state.brew.countdownS > 0 && rig.state.brew.countdownS <= 5);
  rig.runWhile(() => rig.t < startT + 565, 400);
  assert.ok(rig.states.some((s) => s.brew?.step?.kind === 'stir' && s.brew.step.label.includes('crust')));
  rig.at(rig.t + 6, (r) => { r.press = 25; }); rig.at(rig.t + 20, (r) => { r.press = 60; });
  rig.runWhile(() => rig.state.phase !== 'done', 200);
  assert.equal(rig.state.done.reason, 'timer');
  const stir = rig.cues.find((c) => c.id === 'step:2');
  assert.ok(stir && /crust/i.test(stir.text));
  assert.ok(rig.cues.some((c) => c.id === 'step:3' && /skim/i.test(c.text)));
  const plunge = rig.cues.find((c) => c.id === 'step:5');
  assert.equal(plunge.kind, 'plunge');
  const r = rig.recorder();
  assert.ok(Math.abs(r.yield - 500) < 3, `yield is the water poured, not the press force: ${r.yield}`);
  assert.equal(r.ratio, 16.67);
  assert.ok(r.timeS >= 598 && r.timeS <= 603, `time ${r.timeS}`);
  assert.equal(r.stepLog.length, 6);
  assert.ok(r.samples.channels.weight.length >= 5990, 'long brews are downsampled to 10 Hz too');
});

// ---------- moka ----------
test('moka: dose then water, then a timer with a heat-off cue', () => {
  const session = createBrewSession({ method: 'moka' });
  const rig = makeRig(session, { seed: 41 });
  rig.send({ type: 'begin' });
  rig.load = 16; rig.run(2);
  rig.send({ type: 'useAsDose' });
  assert.equal(rig.state.prepStep, 'cup');
  rig.at(4, (r) => { r.load = 0; });
  rig.at(6, (r) => { r.load = 320; }); // pot base placed
  rig.runWhile(() => rig.state.prepStep !== 'water', 30);
  assert.equal(rig.state.prepStep, 'water');
  assert.equal(rig.cmds('tare').length, 1);
  let w = 0;
  rig.physics = (t, dt, r) => { r.load = 320 + w; };
  const tw = rig.t + 1;
  for (let k = 0; k <= 30; k++) rig.at(tw + k * 0.2, () => { w = Math.min(130, k * 4.5); });
  rig.run(tw + 10);
  rig.send({ type: 'useAsWater' });
  assert.equal(rig.state.waterG, 130);
  assert.equal(rig.state.phase, 'ready');
  rig.run(rig.t + 10);
  assert.equal(rig.state.phase, 'ready', 'no auto-start for moka');
  rig.send({ type: 'start' });
  rig.dt = 1;
  rig.runWhile(() => rig.state.phase !== 'done', 400);
  assert.equal(rig.state.done.reason, 'timer');
  const heat = rig.cues.find((c) => c.id === 'step:1');
  assert.match(heat.text, /remove from heat/i);
  const r = rig.recorder();
  assert.equal(r.dose, 16);
  assert.equal(r.water, 130);
  assert.equal(r.yield, 130);
  assert.ok(r.timeS >= 268 && r.timeS <= 273);
});

// ---------- misc ----------
test('finish and reset', () => {
  const rig = readyRig(51);
  let water = 0;
  rig.physics = (t, dt, r) => { water += 3 * dt; r.load = 15 + water; };
  rig.run(rig.t + 6);
  assert.equal(rig.state.phase, 'running');
  rig.send({ type: 'finish' });
  assert.equal(rig.state.phase, 'done');
  assert.equal(rig.state.done.reason, 'user');
  assert.ok(rig.recorder().yield > 10);
  rig.send({ type: 'reset' });
  assert.equal(rig.state.phase, 'idle');
  assert.equal(rig.recorder(), null);
});

test('autoStart off: flow does not start the timer, the user does', () => {
  const rig = readyRig(52);
  rig.send({ type: 'settings', settings: { autoStart: false } });
  let water = 0;
  rig.physics = (t, dt, r) => { water += 3 * dt; r.load = 15 + water; };
  rig.run(rig.t + 8);
  assert.equal(rig.state.phase, 'ready');
  rig.send({ type: 'start' });
  assert.equal(rig.state.phase, 'running');
  assert.equal(rig.when('start').source, 'manual');
});

test('bad samples are ignored', () => {
  const s = createBrewSession({ method: 'espresso' });
  s.dispatch({ type: 'begin', t: 0 });
  s.feed({ t: 1, grams: 0, flow: 0 });
  const out = s.feed({ t: 0.5, grams: 99, flow: 0 });
  assert.equal(out.state.grams, 0);
  assert.equal(s.feed({ t: 2, grams: NaN, flow: 0 }).state.grams, 0);
  assert.throws(() => createBrewSession({ method: 'nope' }));
});
