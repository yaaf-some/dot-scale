// Brew session: a pure state machine that makes brewing hands-off (docs/PRODUCT.md §4).
// No DOM, no timers, no globals: it is fed `{ t, grams, flow }` samples (t in seconds, any origin, increasing) and user
// events, and answers with `{ state, events, cues, commands }` so tests can drive it with synthetic time.
//
//   phases:  idle -> prep -> ready -> running -> done
//   prep:    dose (use the weight as dose) -> cup (cup placed) -> taring -> [water, moka only] -> ready
//   ready:   tared and waiting; the timer auto-starts at the first sustained flow (or the user sends `start`)
//   running: espresso (waiting -> first-drops -> main-flow -> finishing) or a step plan (pour-over, immersion, moka)
//
// Outputs of every call:
//   state     plain snapshot for the UI (phase, prepStep, grams, flow, doseG, elapsedS, espresso{}, brew{}, ...)
//   events    things that happened: phase, dose, cup, tared, start, first-drops, step, step:reached, done, disturbance
//   cues      things to tell the user: { id, text, ...}. The shell decides on a beep / banner / speech
//   commands  things for the scale transport: { cmd: 'tare' | 'timer:reset' | 'timer:start' | 'timer:stop', t, ... }
//
// User events (dispatch): begin, useAsDose[{grams}], useAsWater[{grams}], skipDose, tare (the scale was tared by the user),
//   start, finish, pumpOff (espresso: the user stopped the pump), settings{autoTare,autoStart,autoStop}, reset.
//
// Design notes
// - The session derives its own smoothed flow (least-squares slope of grams). The scale's `flow` field is coarse (0.1 g/s
//   steps) and clamped at >= 0, which cannot tell a bump from a pour, so it is only used until ~0.5 s of history exists.
// - Auto-start needs flow > 0.2 g/s for >= 0.5 s *and* at least 0.3 g of net gain over the resting weight, and is held off
//   for ~1 s after a sudden jump (>= 3 g in one sample): a knock, a cup being set down or a hand on the scale must not start it.
// - Espresso: the scale only sees drops, not the pump. With the `start` event (pump on) the timer covers the waiting
//   phase and `firstDropS` is recorded. With auto-start the timer starts at the first drops, the waiting phase is skipped and
//   `firstDropS` is left undefined rather than reported as 0 (`startSource: 'auto'` says which).
// - timeS (espresso) is when the pump stopped (detected from the flow collapsing, or the `pumpOff` event), or else when the
//   flow went quiet; the samples keep the tail so the insights engine can measure the drip after stopping.
import { getMethod, stepsFor, round } from '../methods/index.js';

export const DEFAULTS = Object.freeze({
  // weight stability
  stableBandG: 0.3, stableWindowS: 0.6, gapS: 3,
  // dose / cup / tare
  minDoseG: 1, doseStaleS: 1.0, emptyG: 1.5, cupMinG: 15, cupJumpG: 5, cupSettleS: 0.8,
  tareBandG: 1.0, tareSettleS: 0.3, tareRetryS: 1.5, tareMaxTries: 3, retareOffsetG: 1.0, retareMax: 2,
  // auto-start
  startFlowGps: 0.2, startSustainS: 0.5, startGainG: 0.3, maxFlowGps: 30, bumpJumpG: 3, disturbS: 1.0, restFlowGps: 0.15,
  flowWindowS: 0.6, quietWindowS: 1.0, slopeLagS: 0.3,
  // espresso
  mainFlowGps: 0.8, mainGainG: 5, defaultStopLeadG: 2, nearTargetG: 3, quietFlowGps: 0.15, doneQuietS: 2,
  idleDoneS: 8, stallCueS: 5, minYieldG: 5, pumpOffRatio: 0.4, pumpOffMinPeakGps: 0.8, espressoMaxS: 120,
  // step plans
  stepTolG: 2, stepGraceS: 15, upcomingLeadS: 3, removeDropG: 15, planOverrunS: 180, pourOverTailS: 120, yieldSettleS: 5,
  hz: 10,
});

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Typical drip after the pump is stopped, in grams, from past espresso brews (newest first, at most `n`), or null when there
 * are fewer than `min` usable shots. Reads `brew.dripAfterStopG` (written by the session) or `brew.metrics.dripAfterStopG`.
 * Filter per profile / portafilter with the options. Clamped to 0.5-6 g.
 */
export function suggestEarlyStopG(history, { profileId, portafilter, n = 8, min = 2 } = {}) {
  const rows = (history || [])
    .filter((b) => b && !b.deleted && (b.method == null || b.method === 'espresso'))
    .filter((b) => profileId == null || b.profileId == null || b.profileId === profileId)
    .filter((b) => portafilter == null || (b.gear?.portafilter ?? b.portafilter) == null || (b.gear?.portafilter ?? b.portafilter) === portafilter)
    .sort((a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0));
  const vals = [];
  for (const b of rows) {
    const v = b.dripAfterStopG ?? b.metrics?.dripAfterStopG;
    if (Number.isFinite(v) && v >= 0 && v <= 10) vals.push(v);
    if (vals.length >= n) break;
  }
  if (vals.length < min) return null;
  return round(Math.min(6, Math.max(0.5, median(vals))), 1);
}

/** Resample raw `{t,g,f}` samples to `hz` (default 10) between t0 and tEnd (linear interpolation) for the Brew record. */
export function downsample(raw, t0, tEnd, hz = 10) {
  const n = Math.max(1, Math.floor((tEnd - t0) * hz + 1e-6) + 1);
  const weight = new Array(n);
  const flow = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t0 + k / hz;
    while (j < raw.length - 1 && raw[j + 1].t <= tk) j++;
    const a = raw[j];
    const b = raw[j + 1];
    let g = 0, f = 0;
    if (a) {
      if (!b || tk <= a.t) { g = a.g; f = a.f; } else {
        const u = (tk - a.t) / (b.t - a.t);
        g = a.g + (b.g - a.g) * u; f = a.f + (b.f - a.f) * u;
      }
    }
    weight[k] = round(g, 1);
    flow[k] = round(f, 2);
  }
  return { hz, t0: 0, channels: { weight, flow } };
}

export function createBrewSession({ method, recipe, history = [], settings = {}, config = {} } = {}) {
  const m = (typeof method === 'string' ? getMethod(method) : method) ?? getMethod(recipe?.method);
  if (!m) throw new Error('createBrewSession: unknown method');
  const rcp = recipe ?? JSON.parse(JSON.stringify(m.defaults));
  const cfg = { ...DEFAULTS, ...config };
  const opt = { autoTare: true, autoStart: true, autoStop: true, ...settings };
  const kind = m.kind;
  const steps = kind === 'espresso' ? [] : stepsFor(rcp, m);
  const targetYield = rcp.yield;
  const lastPourIdx = steps.reduce((acc, st, i) => (Number.isFinite(st.targetG) ? i : acc), -1);
  const planEndS = steps.length ? Math.max(...steps.map((st) => st.atS + (st.durationS || 0))) : 0;
  const learnedLead = kind === 'espresso' ? suggestEarlyStopG(history, { portafilter: rcp.portafilter }) : null;
  const stopLeadG = settings.stopLeadG ?? learnedLead ?? cfg.defaultStopLeadG;

  let ev = [], cues = [], cmds = [];
  let s;

  function fresh() {
    return {
      phase: 'idle', prepStep: null, t: null, g: 0, fl: 0, flSlow: 0,
      win: [], raw: [], lastStable: null, stableSince: null,
      disturbUntil: -Infinity, hadDisturbance: false, restG: 0, retares: 0, runStart: null,
      doseG: null, waterG: null, emptySince: null, sawEmpty: false, tare: null,
      startT: null, startSource: null, quietSince: null, done: null,
      esp: { phase: null, firstDropT: null, firstDropS: null, flowRun: null, mainRun: null, flowHist: [], pumpOffT: null, pumpOffG: null, stopCue: false, stallCue: false },
      eng: { started: false, i: 0, reached: [], reachedS: [], soon: [], log: [], yieldG: 0, leftPourEl: null, pourEndS: null, lastAtYieldT: null, planEndCue: false },
    };
  }
  s = fresh();

  const emit = (type, data) => ev.push({ type, t: s.t, ...data });
  const cue = (id, text, data) => cues.push({ id, text, t: s.t, ...data });
  const cmd = (c, data) => cmds.push({ cmd: c, t: s.t, ...data });
  const setPhase = (to) => { const from = s.phase; if (from !== to) { s.phase = to; emit('phase', { from, to }); } };

  // ---------- signal helpers ----------
  function slope(W) {
    const lo = s.t - W;
    const pts = [];
    for (let i = s.win.length - 1; i >= 0 && s.win[i].t >= lo; i--) pts.push(s.win[i]);
    if (pts.length < 3 || pts[0].t - pts[pts.length - 1].t < 0.6 * W) return null;
    let mt = 0, mg = 0;
    for (const p of pts) { mt += p.t; mg += p.g; }
    mt /= pts.length; mg /= pts.length;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.t - mt) * (p.g - mg); den += (p.t - mt) ** 2; }
    return den > 0 ? num / den : null;
  }
  const stableFor = (sec) => s.stableSince != null && s.t - s.stableSince >= sec;
  function gramsAt(tq) {
    const src = s.raw.length ? s.raw : s.win;
    let best = null;
    for (let i = src.length - 1; i >= 0; i--) { best = src[i]; if (src[i].t <= tq) break; }
    return best ? best.g : s.g;
  }

  function ingest({ t, grams, flow }) {
    if (!Number.isFinite(t) || !Number.isFinite(grams)) return false;
    if (s.t != null && t <= s.t) return false;
    const prevG = s.t != null ? s.g : null;
    const prevT = s.t;
    if (prevT != null && t - prevT > cfg.gapS) { s.win.length = 0; s.stableSince = null; s.runStart = null; s.quietSince = null; }
    s.t = t; s.g = grams;
    s.win.push({ t, g: grams, f: 0 });
    while (s.win.length && s.win[0].t < t - 2.5) s.win.shift();
    const fast = slope(cfg.flowWindowS);
    const slow = slope(cfg.quietWindowS);
    const fallback = Number.isFinite(flow) ? flow : 0;
    s.fl = fast ?? fallback;
    s.flSlow = slow ?? fallback;
    s.win[s.win.length - 1].f = s.fl;
    // sudden jump: a knock, a cup set down, a hand on the scale
    if (prevG != null && prevT != null && Math.abs(grams - prevG) >= cfg.bumpJumpG && t - prevT <= 0.5 && (s.phase === 'ready' || s.phase === 'prep')) {
      s.disturbUntil = t + cfg.disturbS; s.hadDisturbance = true; s.runStart = null;
      if (s.phase === 'ready') emit('disturbance', { deltaG: round(grams - prevG, 1) });
    }
    // stability of the weight (range within the recent window)
    const lo = t - cfg.stableWindowS;
    let min = Infinity, max = -Infinity, sum = 0, cnt = 0, first = null;
    for (const w of s.win) if (w.t >= lo) { min = Math.min(min, w.g); max = Math.max(max, w.g); sum += w.g; cnt++; first ??= w.t; }
    if (cnt >= 3 && t - first >= 0.75 * cfg.stableWindowS && max - min <= cfg.stableBandG) {
      s.stableSince ??= first;
      s.lastStable = { t, g: sum / cnt };
    } else s.stableSince = null;
    // quiet (flow ~ 0) tracking
    if (Math.abs(s.flSlow) <= cfg.quietFlowGps) s.quietSince ??= t; else s.quietSince = null;
    if (s.phase === 'ready' || s.phase === 'running') s.raw.push({ t, g: grams, f: s.fl });
    return true;
  }

  // ---------- prep ----------
  function requestTare(reason) {
    s.tare = { t: s.t, tries: 1, reason };
    if (s.phase === 'prep') s.prepStep = 'taring';
    if (opt.autoTare) { cmd('tare', { reason }); emit('tare:request', { reason }); }
  }
  function tareDone() {
    return s.t - s.tare.t >= cfg.tareSettleS && Math.abs(s.g) <= cfg.tareBandG && stableFor(cfg.tareSettleS);
  }
  function tickTare() {
    if (tareDone()) return true;
    if (opt.autoTare && s.t - s.tare.t > cfg.tareRetryS) {
      if (s.tare.tries < cfg.tareMaxTries) { s.tare.tries++; s.tare.t = s.t; cmd('tare', { reason: s.tare.reason, retry: true }); } else {
        cue('tare:failed', 'The scale did not tare. Tap tare');
        s.tare = null;
        if (s.phase === 'prep') { s.prepStep = 'cup'; s.sawEmpty = false; }
        return false;
      }
    }
    return false;
  }
  function toReady() {
    s.tare = null; s.prepStep = null;
    s.restG = s.g; s.runStart = null; s.hadDisturbance = false; s.retares = 0;
    s.raw = s.win.map((w) => ({ ...w }));
    setPhase('ready');
    emit('tared', { grams: round(s.g, 1) });
    cmd('timer:reset');
  }
  function afterTare() {
    if (m.captures?.includes('water') && s.waterG == null) { s.tare = null; s.prepStep = 'water'; emit('tared', { grams: round(s.g, 1) }); cue('water', 'Add the water'); } else toReady();
  }
  function afterDose() {
    s.sawEmpty = false; s.emptySince = null;
    if (m.tareAfterDose === 'now') {
      if (opt.autoTare) requestTare('dose'); else { s.prepStep = 'cup'; cue('tare:manual', 'Tare the scale'); }
    } else {
      s.prepStep = 'cup';
      cue('cup', kind === 'moka' ? 'Put the pot base on the scale' : 'Put the cup on the scale');
    }
  }
  function tickPrep() {
    if (s.prepStep === 'cup') {
      if (Math.abs(s.g) <= cfg.emptyG) { s.emptySince ??= s.t; if (s.t - s.emptySince >= 0.3) s.sawEmpty = true; } else s.emptySince = null;
      if (opt.autoTare && stableFor(cfg.cupSettleS) && s.lastStable.g >= cfg.cupMinG
        && (s.sawEmpty || Math.abs(s.lastStable.g - (s.doseG ?? 0)) >= cfg.cupJumpG)) {
        emit('cup', { grams: round(s.lastStable.g, 1) });
        requestTare('cup');
      }
    } else if (s.prepStep === 'taring') {
      if (tickTare()) afterTare();
    }
  }

  // ---------- ready ----------
  function tickReady() {
    if (kind === 'moka') return; // the timer is started by the user (heat on)
    if (s.tare) { if (tickTare()) { s.tare = null; s.restG = s.g; s.runStart = null; s.hadDisturbance = false; } return; }
    const disturbed = s.t < s.disturbUntil;
    if (!disturbed && Math.abs(s.fl) < cfg.restFlowGps) s.restG += 0.02 * (s.g - s.restG);
    if (s.hadDisturbance && !disturbed && stableFor(cfg.stableWindowS)) {
      s.hadDisturbance = false;
      if (opt.autoTare && s.retares < cfg.retareMax && Math.abs(s.lastStable.g - s.restG) >= cfg.retareOffsetG) {
        s.retares++; cue('retare', 'Scale moved. Taring again'); requestTare('offset'); return;
      }
    }
    if (!opt.autoStart) return;
    const rising = !disturbed && s.fl > cfg.startFlowGps && s.fl < cfg.maxFlowGps;
    if (!rising) { s.runStart = null; return; }
    s.runStart ??= s.t;
    if (s.t - s.runStart >= cfg.startSustainS && s.g - s.restG >= cfg.startGainG) {
      const t0 = Math.max(s.raw[0]?.t ?? 0, s.runStart - cfg.slopeLagS);
      startTimer('auto', t0);
    }
  }

  function startTimer(source, t0) {
    s.tare = null; s.runStart = null;
    s.startT = t0; s.startSource = source;
    setPhase('running');
    cmd('timer:start', { t0, source });
    emit('start', { source, t0 });
    if (kind === 'espresso') s.esp.phase = source === 'manual' ? 'waiting' : 'first-drops';
    tickRunning();
  }

  // ---------- running ----------
  function finish(reason, endT) {
    const el = s.t - s.startT;
    const timeS = round(Math.max(0, (endT ?? s.t) - s.startT), 1);
    let yieldG;
    if (kind === 'espresso') {
      const tail = s.win.filter((w) => w.t >= s.t - 0.5);
      yieldG = tail.length ? tail.reduce((a, w) => a + w.g, 0) / tail.length : s.g;
    } else if (kind === 'moka') yieldG = s.waterG ?? targetYield;
    else yieldG = s.eng.yieldG || s.g;
    s.done = { reason, t: s.t, endT: endT ?? s.t, timeS, elapsedS: round(el, 1), yieldG: round(yieldG, 1) };
    setPhase('done');
    cmd('timer:stop');
    emit('done', { reason, timeS, yieldG: s.done.yieldG });
    cue('done', 'Done');
  }

  function tickRunning() {
    if (s.phase !== 'running') return;
    const el = s.t - s.startT;
    const maxS = kind === 'espresso' ? cfg.espressoMaxS : planEndS + cfg.planOverrunS;
    if (el > maxS) { finish('timeout'); return; }
    if (kind === 'espresso') tickEspresso(el); else tickSteps(el);
  }

  function tickEspresso() {
    const e = s.esp;
    const gain = s.g - s.restG;
    if (s.fl > cfg.startFlowGps) e.flowRun ??= s.t; else e.flowRun = null;
    if (s.fl >= cfg.mainFlowGps) e.mainRun ??= s.t; else e.mainRun = null;
    const sustained = e.flowRun != null && s.t - e.flowRun >= cfg.startSustainS && gain >= cfg.startGainG;

    if (e.phase === 'waiting' && sustained) {
      e.firstDropT = Math.max(s.startT, e.flowRun - cfg.slopeLagS);
      e.firstDropS = round(e.firstDropT - s.startT, 1);
      e.phase = 'first-drops';
      emit('first-drops', { atS: e.firstDropS });
    }
    if (e.phase === 'first-drops' && ((e.mainRun != null && s.t - e.mainRun >= cfg.startSustainS) || gain >= cfg.mainGainG)) {
      e.phase = 'main-flow';
      emit('espresso:phase', { phase: 'main-flow' });
    }
    if (e.phase === 'waiting') return;

    // stop-the-pump cue, a little before the target so the drip after stopping lands on it
    if (!e.stopCue && s.g >= targetYield - stopLeadG) {
      e.stopCue = true;
      e.phase = 'finishing';
      emit('espresso:phase', { phase: 'finishing' });
      cue('espresso:stop', 'Stop the pump', { grams: round(s.g, 1), targetG: targetYield, leadG: stopLeadG });
    }

    // pump stop = flow collapsing from its recent peak (the 0.6 s slope lags, so back-date a little)
    e.flowHist.push({ t: s.t, f: s.fl });
    while (e.flowHist.length && e.flowHist[0].t < s.t - 3) e.flowHist.shift();
    const peak = Math.max(...e.flowHist.map((h) => h.f));
    if (e.pumpOffT == null && peak >= cfg.pumpOffMinPeakGps && s.fl < cfg.pumpOffRatio * peak && s.g >= cfg.minYieldG) {
      // the flow decays, so the pump stopped when it left its peak, not when it fell below the ratio: walk back to that point
      let h = e.flowHist.length - 1;
      while (h > 0 && e.flowHist[h].f < 0.85 * peak) h--;
      e.pumpOffT = e.flowHist[h].t - cfg.slopeLagS;
      e.pumpOffG = gramsAt(e.pumpOffT);
    } else if (e.pumpOffT != null && s.fl >= cfg.mainFlowGps) { e.pumpOffT = null; e.pumpOffG = null; }

    const quiet = s.quietSince != null ? s.t - s.quietSince : 0;
    const near = s.g >= targetYield - cfg.nearTargetG;
    if (quiet === 0) e.stallCue = false;
    if (opt.autoStop) {
      if (near && quiet >= cfg.doneQuietS) { finish('target', e.pumpOffT ?? s.quietSince); return; }
      if (s.g >= cfg.minYieldG && quiet >= cfg.idleDoneS) { finish('idle', e.pumpOffT ?? s.quietSince); return; }
    }
    if (!near && !e.stallCue && quiet >= cfg.stallCueS) {
      e.stallCue = true;
      cue('espresso:stall', 'Flow has stopped. Check the puck, or stop the pump', { grams: round(s.g, 1) });
    }
  }

  function startStep(i, el) {
    const st = steps[i];
    s.eng.log.push({ index: i, kind: st.kind, atS: st.atS, startS: round(el, 1) });
    emit('step', { index: i, step: st });
    cue(`step:${i}`, st.label, { kind: st.kind, index: i, targetG: st.targetG });
  }

  function tickSteps(el) {
    const E = s.eng;
    const n = steps.length;
    if (!n) return;
    if (!E.started) { E.started = true; startStep(0, el); }
    if (E.i <= lastPourIdx || (E.leftPourEl != null && el <= E.leftPourEl + cfg.yieldSettleS)) E.yieldG = Math.max(E.yieldG, s.g);
    // advance by time and weight
    for (;;) {
      const cur = steps[E.i];
      const next = steps[E.i + 1];
      if (!next) break;
      const curDone = !Number.isFinite(cur.targetG) || E.reached[E.i] || s.g >= cur.targetG - cfg.stepTolG;
      const ahead = Number.isFinite(next.targetG) && s.g >= next.targetG - cfg.stepTolG;
      if ((el >= next.atS && curDone) || el >= next.atS + cfg.stepGraceS || (ahead && curDone)) {
        E.i++;
        if (E.i === lastPourIdx + 1) E.leftPourEl = el;
        startStep(E.i, el);
      } else break;
    }
    const i = E.i;
    const cur = steps[i];
    const next = steps[i + 1];
    if (Number.isFinite(cur.targetG) && !E.reached[i] && s.g >= cur.targetG - cfg.stepTolG) {
      E.reached[i] = true; E.reachedS[i] = round(el, 1);
      if (i === lastPourIdx) E.pourEndS = E.reachedS[i];
      emit('step:reached', { index: i, atS: E.reachedS[i] });
      cue(`step:${i}:reached`, cur.kind === 'bloom' ? 'Bloom poured. Let it rest' : 'Stop pouring', { index: i });
    }
    if (next && !E.soon[i + 1] && el >= next.atS - cfg.upcomingLeadS) {
      E.soon[i + 1] = true;
      cue(`step:${i + 1}:soon`, `Next: ${next.label}`, { kind: next.kind, index: i + 1, inS: Math.max(0, round(next.atS - el, 1)) });
    }
    // dripper (or brewer) lifted off after the pour: weight drops far below what was poured
    if (i > lastPourIdx && lastPourIdx >= 0 && E.yieldG > 0) {
      if (s.g >= E.yieldG - cfg.stepTolG) E.lastAtYieldT = s.t;
      else if (E.yieldG - s.g >= cfg.removeDropG) { finish('removed', E.lastAtYieldT ?? s.t); return; }
    }
    // end of plan
    if (i === n - 1 && el >= cur.atS + (cur.durationS || 0)) {
      if (kind === 'pour') {
        if (!E.planEndCue) { E.planEndCue = true; cue('plan:end', 'Drawdown time reached. Lift the dripper when it stops dripping'); }
        if (el >= planEndS + cfg.pourOverTailS) finish('timeout');
      } else { finish('timer'); }
    }
  }

  // ---------- events ----------
  function stableGrams(ev0) {
    if (Number.isFinite(ev0.grams)) return ev0.grams;
    return s.lastStable && s.t != null && s.t - s.lastStable.t <= cfg.doseStaleS ? s.lastStable.g : null;
  }
  function dispatch(e) {
    const t = e.t ?? s.t ?? 0;
    if (s.t == null) s.t = t;
    switch (e.type) {
      case 'begin':
        if (s.phase === 'idle') { setPhase('prep'); s.prepStep = 'dose'; }
        break;
      case 'useAsDose': {
        if (s.phase !== 'prep' || s.prepStep !== 'dose') break;
        const g = stableGrams(e);
        if (g == null) { cue('dose:unstable', 'Hold still for a moment'); break; }
        if (g < cfg.minDoseG) { cue('dose:empty', 'Put the beans on the scale first'); break; }
        s.doseG = round(g, 1);
        emit('dose', { grams: s.doseG, source: 'scale' });
        afterDose();
        break;
      }
      case 'skipDose':
        if (s.phase !== 'prep' || s.prepStep !== 'dose') break;
        s.doseG = rcp.dose;
        emit('dose', { grams: s.doseG, source: 'recipe' });
        afterDose();
        break;
      case 'useAsWater': {
        if (s.phase !== 'prep' || s.prepStep !== 'water') break;
        const g = stableGrams(e);
        if (g == null) { cue('dose:unstable', 'Hold still for a moment'); break; }
        if (g < cfg.minDoseG) { cue('dose:empty', 'Add the water first'); break; }
        s.waterG = round(g, 1);
        emit('water', { grams: s.waterG });
        toReady();
        break;
      }
      case 'tare': // the user tared the scale (from the app or the scale itself)
        if (s.phase === 'prep' && s.prepStep === 'cup') { s.tare = { t: s.t, tries: 0, reason: 'user' }; s.prepStep = 'taring'; } else if (s.phase === 'ready') {
          s.tare = { t: s.t, tries: 0, reason: 'user' };
        }
        break;
      case 'start':
        if (s.phase === 'ready') startTimer('manual', s.t);
        break;
      case 'pumpOff':
        if (s.phase === 'running' && kind === 'espresso' && s.esp.pumpOffT == null) { s.esp.pumpOffT = s.t; s.esp.pumpOffG = s.g; }
        break;
      case 'finish':
        if (s.phase === 'running') finish('user', s.esp.pumpOffT ?? s.t);
        break;
      case 'settings':
        Object.assign(opt, e.settings);
        break;
      case 'reset': {
        const wasTimer = s.phase === 'running';
        const keepT = s.t;
        s = fresh();
        s.t = keepT;
        if (wasTimer) cmd('timer:stop');
        cmd('timer:reset');
        break;
      }
      default:
        break;
    }
    return flush();
  }

  function feed(sample) {
    if (ingest(sample)) {
      if (s.phase === 'prep') tickPrep();
      else if (s.phase === 'ready') tickReady();
      else if (s.phase === 'running') tickRunning();
    }
    return flush();
  }

  // ---------- output ----------
  function brewState() {
    if (!steps.length) return null;
    const E = s.eng;
    const i = Math.min(E.i, steps.length - 1);
    const cur = steps[i];
    const next = steps[i + 1] ?? null;
    const el = s.phase === 'running' ? s.t - s.startT : s.phase === 'done' ? s.done.elapsedS : 0;
    const running = s.phase === 'running';
    const upTo = Number.isFinite(cur.targetG) ? cur.targetG : null;
    return {
      index: running || s.phase === 'done' ? i : -1,
      count: steps.length,
      step: running ? cur : null,
      targetG: running ? upTo : steps[0]?.targetG ?? null,
      remainingG: running && upTo != null ? round(Math.max(0, upTo - s.g), 1) : null,
      reached: running ? !!E.reached[i] : false,
      nextCue: running && next ? { atS: next.atS, inS: round(Math.max(0, next.atS - el), 1), kind: next.kind, label: next.label, targetG: next.targetG ?? null } : null,
      countdownS: running ? round(Math.max(0, (next ? next.atS : planEndS) - el), 1) : null,
      planEndS,
    };
  }
  function snapshot() {
    const running = s.phase === 'running';
    const el = running ? s.t - s.startT : s.phase === 'done' ? s.done.elapsedS : 0;
    const finalTarget = kind === 'espresso' ? targetYield : lastPourIdx >= 0 ? steps[lastPourIdx].targetG : null;
    const progress = kind === 'espresso' || finalTarget ? Math.min(1, Math.max(0, s.g / (finalTarget || 1)))
      : planEndS ? Math.min(1, el / planEndS) : 0;
    const e = s.esp;
    return {
      phase: s.phase, prepStep: s.prepStep, methodId: m.id, kind,
      t: s.t, grams: round(s.g, 1), flow: round(Math.max(0, s.fl), 2),
      stable: s.stableSince != null, canUseAsDose: s.phase === 'prep' && (s.prepStep === 'dose' || s.prepStep === 'water') && s.lastStable != null && s.lastStable.g >= cfg.minDoseG && s.t - s.lastStable.t <= cfg.doseStaleS,
      doseG: s.doseG, waterG: s.waterG, targetYield, tareG: null,
      startT: s.startT, startSource: s.startSource, elapsedS: round(el, 1),
      progress: kind === 'moka' ? 0 : progress,
      espresso: kind === 'espresso' ? { phase: e.phase, firstDropS: e.firstDropS, stopLeadG, learnedLeadG: learnedLead, stopCueSent: e.stopCue, stopAtG: round(targetYield - stopLeadG, 1) } : null,
      brew: brewState(),
      done: s.done,
      settings: { ...opt },
    };
  }
  function flush() {
    const out = { state: snapshot(), events: ev, cues, commands: cmds };
    ev = []; cues = []; cmds = [];
    return out;
  }

  /**
   * The finished brew as Brew-record fields (docs/PRODUCT.md §6), ready for analyze() and the store. Null before the timer ran.
   * Espresso timing: `startSource: 'manual'` means the timer ran from pump start, so `timeS` includes the pump-to-first-drop lag
   * and `firstDropS` is set. `startSource: 'auto'` means the timer began at the first drops (the scale cannot see the pump), so
   * `timeS` excludes that lag and `firstDropS` is absent. Analysis must use `startSource` to tell the two apart.
   */
  function record() {
    if (s.startT == null) return null;
    const endT = s.done ? s.done.t : s.t;
    const dose = s.doseG ?? rcp.dose;
    const yld = s.done ? s.done.yieldG : (kind === 'moka' ? s.waterG : s.g);
    const timeS = s.done ? s.done.timeS : round(s.t - s.startT, 1);
    const out = {
      method: m.id,
      dose, yield: yld, targetYield, ratio: dose > 0 && yld > 0 ? round(yld / dose, 2) : null,
      timeS,
      startSource: s.startSource,
      doneReason: s.done?.reason ?? null,
      samples: downsample(s.raw, s.startT, endT, cfg.hz),
    };
    if (kind === 'espresso') {
      if (s.esp.firstDropS != null) out.firstDropS = s.esp.firstDropS;
      out.stopLeadG = stopLeadG;
      if (s.esp.pumpOffT != null && s.done) {
        out.stopS = round(s.esp.pumpOffT - s.startT, 1);
        out.dripAfterStopG = round(Math.max(0, yld - s.esp.pumpOffG), 1);
      }
    } else {
      out.stepLog = s.eng.log.map((l) => ({ ...l, reachedS: s.eng.reachedS[l.index] ?? null }));
      if (s.eng.pourEndS != null) out.pourEndS = s.eng.pourEndS;
      if (kind === 'moka') out.water = s.waterG;
    }
    return out;
  }

  return {
    feed,
    dispatch,
    record,
    get state() { return snapshot(); },
    get steps() { return steps.map((x) => ({ ...x })); },
    method: m,
    recipe: rcp,
  };
}
