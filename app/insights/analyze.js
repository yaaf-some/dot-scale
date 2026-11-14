// Insights engine: pure, DOM-free. `analyze(brew, { method, gear, history, bean, steps, rules })`
// returns `{ metrics, verdict, tips, learn }` as specified in docs/PRODUCT.md §8.
//
// Inputs (all optional except `brew`):
//   brew     a Brew record (§6). `samples.channels.weight` (g, cumulative) and `.flow` (g/s) at `samples.hz`,
//            first sample at `samples.t0` seconds on the brew timer. Unknown channels are ignored.
//            Old brews with only totals (dose, yield, timeS, ...) still work.
//   method   'espresso' | 'pour-over' | 'french-press' | 'aeropress' | 'prestina' | 'moka' (default brew.method)
//   gear     extra gear info merged over brew.gear: { portafilter, basketG, grinderFinerIsHigher }.
//            Grind direction defaults to "lower number = finer" (most grinders); set grinderFinerIsHigher for others.
//   history  earlier Brew records. Only same method + same bean (+ same profile when known) before this brew count.
//   bean     the Bean record (for roastDate). `brew.roastDate` also works.
//   steps    plan Step[] for step adherence (else brew.steps). targetG is the CUMULATIVE weight on the scale
//            (scale under the whole brewer, tared), atS the planned start, durationS the pour length.
//   rules    override the RULES table (tests, experiments).
//
// Taste (brew.taste): { balance -2..2 (sour..bitter), strength -2..2, stars 1..5, spurts? } plus the optional
// additive booleans `sour` / `bitter`, which let a user flag both (that combination means channeling).

import { RULES, METHOD_FAMILY, LEARN } from './rules.js';

// ---------- small helpers ----------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const median = (a) => {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  const h = b.length >> 1;
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtG = (v) => String(r1(v));
const fmtTime = (s) => {
  if (s == null) return '?';
  return s < 120 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

function cleanArray(a) {
  if (!Array.isArray(a) || !a.length) return null;
  const out = new Array(a.length);
  let last = 0;
  for (let i = 0; i < a.length; i++) {
    const v = num(a[i]);
    if (v != null) last = v;
    out[i] = last;
  }
  return out;
}

function smooth(a, win) {
  if (win <= 1) return a.slice();
  const half = win >> 1;
  const pre = [0];
  for (const x of a) pre.push(pre[pre.length - 1] + x);
  return a.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(a.length - 1, i + half);
    return (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  });
}

function deriveFlow(w, hz) {
  const k = Math.max(1, Math.round(hz * 0.3));
  return w.map((_, i) => {
    const lo = Math.max(0, i - k);
    const hi = Math.min(w.length - 1, i + k);
    return hi === lo ? 0 : Math.max(0, ((w[hi] - w[lo]) * hz) / (hi - lo));
  });
}

// Weight/flow series, or null when a brew has no usable samples (old brews have totals only).
function buildSeries(brew, R) {
  const ch = brew?.samples?.channels;
  const hz = num(brew?.samples?.hz) > 0 ? brew.samples.hz : 10;
  const t0 = num(brew?.samples?.t0) ?? 0;
  const w = cleanArray(ch?.weight);
  if (!w || w.length < Math.ceil(hz * 3)) return null;
  let f = cleanArray(ch?.flow);
  if (!f || f.length !== w.length) f = deriveFlow(w, hz);
  const fs = smooth(f, Math.max(1, Math.round(hz * R.smoothS)));
  const n = w.length;
  return {
    hz, t0, w, fs, n,
    timeOf: (i) => t0 + i / hz,
    indexOf: (t) => clamp(Math.round((t - t0) * hz), 0, n - 1),
  };
}

// Time the weight first rises `g` above its starting value, or null.
function firstWeightGain(S, g) {
  for (let i = 0; i < S.n; i++) if (S.w[i] - S.w[0] >= g) return S.timeOf(i);
  return null;
}

// Time of the last sample with flow at/above `gps`, or null.
function lastFlowTime(S, gps) {
  for (let i = S.n - 1; i >= 0; i--) if (S.fs[i] >= gps) return S.timeOf(i);
  return null;
}

// Runs of flow >= gps, merged across gaps <= gapS. Used for pours and presses.
function segments(S, gps, gapS) {
  const out = [];
  let cur = null;
  for (let i = 0; i < S.n; i++) {
    if (S.fs[i] >= gps) {
      if (cur && (i - cur.i1) / S.hz <= gapS) cur.i1 = i;
      else out.push((cur = { i0: i, i1: i }));
    }
  }
  return out.map((s) => ({
    start: S.timeOf(s.i0),
    end: S.timeOf(s.i1),
    gained: S.w[s.i1] - S.w[s.i0],
  }));
}

// Flow statistics between two times. "Body" is the first part, "late" the rest.
function flowPhase(S, startS, endS, main) {
  if (endS - startS < main.minLengthS) return null;
  const i0 = S.indexOf(startS);
  const i1 = S.indexOf(endS);
  if (i1 - i0 < 2) return null;
  const mid = i0 + Math.floor((i1 - i0) * main.bodyFraction);
  const all = S.fs.slice(i0, i1 + 1);
  const body = S.fs.slice(i0, mid + 1);
  const late = S.fs.slice(mid + 1, i1 + 1);
  const med = median(body);
  const bm = mean(body);
  return {
    mainAvgFlow: ((S.w[i1] - S.w[i0]) * S.hz) / (i1 - i0),
    mainPeakFlow: Math.max(...all),
    flowCV: bm > 0 ? std(body) / bm : null,
    spikeRatio: med > 0 ? Math.max(...all) / med : null,
    lateRamp: late.length >= S.hz && bm > 0 ? mean(late) / bm : null,
  };
}

function beanAgeDays(brew, bean) {
  const rd = bean?.roastDate ?? brew?.roastDate;
  if (typeof rd !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(rd);
  if (!m) return null;
  const roast = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const at = num(brew?.startedAt) ?? Date.now();
  const d = Math.floor((at - roast) / 86400000);
  return d >= 0 ? d : null;
}

function readTaste(t) {
  if (!t || typeof t !== 'object') return { given: false };
  const balance = num(t.balance);
  const sour = t.sour ?? (balance != null && balance <= -1);
  const bitter = t.bitter ?? (balance != null && balance >= 1);
  return {
    given: true,
    balance,
    strength: num(t.strength),
    stars: num(t.stars),
    spurts: !!t.spurts,
    sour: !!sour,
    bitter: !!bitter,
  };
}

// ---------- metrics ----------------------------------------------------------------------------
function baseMetrics(brew, S, R) {
  const dose = num(brew.dose);
  const finalW = S ? S.w[S.n - 1] : null;
  const yieldG = num(brew.yield) ?? (finalW != null && finalW > 0 ? finalW : null);
  const stopFlow = R.espresso.main.stopFlowGps;
  const timeS = num(brew.timeS) ?? (S ? lastFlowTime(S, stopFlow) : null);
  const firstDropS = num(brew.firstDropS) ?? (S ? firstWeightGain(S, R.espresso.firstDrop.weightG) : null);
  return {
    dose,
    yield: yieldG,
    targetYield: num(brew.targetYield),
    ratio: dose > 0 && yieldG != null ? yieldG / dose : null,
    timeS,
    firstDropS,
    hasSamples: !!S,
  };
}

function classify(effT, T) {
  if (effT == null) return null;
  if (effT < T.fastBelowS) return 'fast';
  if (effT > T.slowAboveS) return 'slow';
  if (T.sweetFromS != null && effT >= T.sweetFromS && effT <= T.sweetToS) return 'sweet';
  return 'ok';
}

function espressoMetrics(brew, S, c) {
  const E = c.R.espresso;
  const b = baseMetrics(brew, S, c.R);
  const m = { method: c.method, ...b };

  // Time normalised to the target yield, when the shot was stopped clearly short or long.
  let eff = b.timeS;
  if (eff != null && b.yield > 0 && b.targetYield > 0 && Math.abs(b.yield - b.targetYield) / b.targetYield > E.projectIfOffByFraction) {
    eff = b.timeS * clamp(b.targetYield / b.yield, ...E.projectClamp);
  }
  m.effectiveTimeS = eff;
  m.timeStatus = classify(eff, E.time);
  m.inRange = m.timeStatus === 'sweet' || m.timeStatus === 'ok';
  m.avgFlow = b.timeS > 0 && b.yield != null ? b.yield / Math.max(1, b.timeS - (b.firstDropS ?? 0)) : null;

  Object.assign(m, { mainAvgFlow: null, mainPeakFlow: null, flowCV: null, spikeRatio: null, lateRamp: null, dripAfterStopG: null });
  if (S && b.firstDropS != null && b.timeS != null) {
    const ph = flowPhase(S, b.firstDropS + E.main.startAfterS, b.timeS - E.main.endTrimS, E.main);
    if (ph) Object.assign(m, ph);
    const stopIdx = S.indexOf(b.timeS);
    if ((S.n - 1 - stopIdx) / S.hz >= E.drip.minSecondsAfterStop) m.dripAfterStopG = Math.max(0, S.w[S.n - 1] - S.w[stopIdx]);
  }
  m.unstable =
    (m.flowCV != null && m.flowCV > E.stability.cvUnstable) || (m.spikeRatio != null && m.spikeRatio > E.stability.spikeRatio);
  m.beanAgeDays = beanAgeDays(brew, c.bean);
  return m;
}

function pourOverMetrics(brew, S, c) {
  const P = c.R.pourover;
  const b = baseMetrics(brew, S, c.R);
  const m = { method: c.method, ...b, effectiveTimeS: b.timeS };
  m.timeStatus = classify(b.timeS, P.time);
  m.inRange = m.timeStatus === 'ok';
  Object.assign(m, { pours: null, pourEndS: null, drawdownS: null, pourRateGps: null, steps: null, adherence: null });
  if (S) {
    const segs = segments(S, c.R.activeFlowGps, c.R.segmentGapS);
    if (segs.length) {
      const active = segs.reduce((s, x) => s + Math.max(x.end - x.start, 1 / S.hz), 0);
      const gained = segs.reduce((s, x) => s + x.gained, 0);
      m.pours = segs.length;
      m.pourEndS = segs[segs.length - 1].end;
      m.pourRateGps = gained / active;
      // Drawdown: from when the weight stops increasing to the end of the brew.
      if (b.timeS != null && b.timeS >= m.pourEndS) m.drawdownS = b.timeS - m.pourEndS;
    }
    const sa = stepAdherence(c.steps, S, P.steps);
    if (sa) Object.assign(m, sa);
  }
  return m;
}

// Compare when each cumulative target weight was reached with the plan.
function stepAdherence(steps, S, T) {
  const planned = (steps || []).filter((s) => num(s.targetG) > 0 && num(s.atS) != null);
  if (!planned.length) return null;
  const rows = planned.map((s) => {
    const plannedS = s.atS + (num(s.durationS) ?? 0);
    let actualS = null;
    for (let i = 0; i < S.n; i++) {
      if (S.w[i] - S.w[0] >= s.targetG - T.reachToleranceG) {
        actualS = S.timeOf(i);
        break;
      }
    }
    return { kind: s.kind, label: s.label, targetG: s.targetG, plannedS, actualS: r1(actualS), deltaS: actualS == null ? null : r1(actualS - plannedS) };
  });
  const hits = rows.filter((r) => r.deltaS != null && Math.abs(r.deltaS) <= T.toleranceS).length;
  return { steps: rows, adherence: r2(hits / rows.length) };
}

function immersionMetrics(brew, S, c) {
  const I = c.R.immersion;
  const b = baseMetrics(brew, S, c.R);
  const m = { method: c.method, ...b, effectiveTimeS: b.timeS };
  Object.assign(m, { pours: null, pourEndS: null, pourRateGps: null, steepS: null, steps: null, adherence: null });
  if (S) {
    const segs = segments(S, c.R.activeFlowGps, c.R.segmentGapS);
    if (segs.length) {
      m.pours = segs.length;
      m.pourEndS = segs[segs.length - 1].end;
      m.pourRateGps = segs.reduce((s, x) => s + x.gained, 0) / segs.reduce((s, x) => s + Math.max(x.end - x.start, 1 / S.hz), 0);
      // Steep = from when the last water went in to the end of the brew. It includes the press/plunge,
      // because the scale can't see the press (weight doesn't change while pressing onto a cup on the scale).
      if (b.timeS != null && b.timeS >= m.pourEndS) m.steepS = b.timeS - m.pourEndS;
    }
    const sa = stepAdherence(c.steps, S, I.steps);
    if (sa) Object.assign(m, sa);
  }
  const win = I.steep[c.method] ?? I.steep.aeropress;
  const ref = m.steepS ?? b.timeS;
  m.timeStatus = ref == null ? null : ref < win.shortBelowS ? 'short' : ref > win.longAboveS ? 'long' : 'ok';
  m.inRange = m.timeStatus === 'ok';
  return m;
}

function mokaMetrics(brew, S, c) {
  const M = c.R.moka;
  const b = baseMetrics(brew, S, c.R);
  const m = { method: c.method, ...b, effectiveTimeS: b.timeS, lateRamp: null };
  m.timeStatus = classify(b.timeS, M.time);
  m.inRange = m.timeStatus === 'ok';
  if (S && b.firstDropS != null && b.timeS != null) {
    const ph = flowPhase(S, b.firstDropS + c.R.espresso.main.startAfterS, b.timeS, c.R.espresso.main);
    if (ph) m.lateRamp = ph.lateRamp;
  }
  return m;
}

function computeMetrics(brew, c) {
  const S = buildSeries(brew, c.R);
  let m;
  switch (c.family) {
    case 'espresso': m = espressoMetrics(brew, S, c); break;
    case 'pourover': m = pourOverMetrics(brew, S, c); break;
    case 'immersion': m = immersionMetrics(brew, S, c); break;
    case 'moka': m = mokaMetrics(brew, S, c); break;
    default: m = { method: c.method, ...baseMetrics(brew, S, c.R), timeStatus: null, inRange: false };
  }
  return m;
}

function roundMetrics(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === 'number' ? r2(v) : v;
  return out;
}

// ---------- history ----------------------------------------------------------------------------
function relevantHistory(brew, history, method) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (h) =>
        h && !h.deleted && h !== brew &&
        !(brew.id != null && h.id === brew.id) &&
        (h.method ?? method) === method &&
        (h.beanId ?? null) === (brew.beanId ?? null) &&
        (!h.profileId || !brew.profileId || h.profileId === brew.profileId) &&
        (num(h.startedAt) == null || num(brew.startedAt) == null || h.startedAt < brew.startedAt),
    )
    .sort((a, b) => (num(a.startedAt) ?? 0) - (num(b.startedAt) ?? 0)); // stable: given order if no timestamps
}

function isGoodShot(m, taste, D) {
  return !!(m.inRange && taste.given && taste.stars != null && taste.stars >= D.minStars);
}

// For the UI: the id of the brew at which a bean became dialled in (2 consecutive in-range shots rated 4+), or null.
// `brews` = one bean's brews, oldest first.
export function findDialledIn(brews, { method = 'espresso', rules = RULES } = {}) {
  const family = METHOD_FAMILY[method] ?? 'espresso';
  const c = { method, family, R: rules, gear: {}, bean: null, steps: null };
  let run = 0;
  for (const b of brews || []) {
    const good = isGoodShot(computeMetrics(b, { ...c, bean: null }), readTaste(b.taste), rules.espresso.dialIn);
    run = good ? run + 1 : 0;
    if (run >= rules.espresso.dialIn.consecutive) return b.id ?? true;
  }
  return null;
}

// ---------- tips -------------------------------------------------------------------------------
function mkTip(o) {
  return { confidence: 0.6, ...o };
}

function grindWord(dir, steps) {
  return `${steps} ${dir === 'finer' ? 'finer' : 'coarser'}`;
}

function suggestValue(dir, steps, value, finerIsHigher) {
  if (value == null || typeof steps !== 'number') return '';
  const sign = (dir === 'finer') === !!finerIsHigher ? 1 : -1;
  return ` (try ${r1(value + sign * steps)})`;
}

function grindSteps(dev, E) {
  return dev >= E.farOffS ? E.grindStepsFar : E.grindStepsNear;
}

function espressoTips(brew, m, taste, c, hist) {
  const E = c.R.espresso;
  const P = c.R.priority;
  const tips = [];
  const status = m.timeStatus;
  const timeDir = status === 'fast' ? 'finer' : status === 'slow' ? 'coarser' : null;
  const tasteDir = taste.sour && !taste.bitter ? 'finer' : taste.bitter && !taste.sour ? 'coarser' : null;
  const both = taste.sour && taste.bitter;
  const naked = (c.gear.portafilter ?? brew.gear?.portafilter) === 'naked';
  const T = E.time;
  const eff = m.effectiveTimeS;
  const finerIsHigher = !!c.gear.grinderFinerIsHigher;
  const curVal = num(brew.grind?.value);
  const age = m.beanAgeDays;
  const fresh = age != null && age < E.beanAgeDays.tooFresh;
  const fdLate = m.firstDropS != null && m.firstDropS > E.firstDrop.lateAboveS;
  const fdEarly = m.firstDropS != null && m.firstDropS < E.firstDrop.earlyBelowS;
  const conflict = !!(timeDir && tasteDir && timeDir !== tasteDir);
  const fastButLate = timeDir === 'finer' && fdLate;
  const tasteWins = !!(timeDir && taste.stars >= E.dialIn.minStars && !taste.sour && !taste.bitter && !both);
  const puckSignals = [];
  if (m.spikeRatio != null && m.spikeRatio > E.stability.spikeRatio) puckSignals.push(`flow spiked to ${r1(m.mainPeakFlow)} g/s, about ${r1(m.spikeRatio)}x its usual level`);
  if (m.flowCV != null && m.flowCV > E.stability.cvUnstable) puckSignals.push(`flow was uneven (varied by ${Math.round(m.flowCV * 100)}%)`);
  if (taste.spurts) puckSignals.push('you saw spurts');
  if (both) puckSignals.push('it tasted both sour and bitter');
  if (conflict) puckSignals.push(`it tasted ${tasteDir === 'finer' ? 'sour' : 'bitter'} even though the shot ran ${status}`);
  if (fastButLate) puckSignals.push(`first drops took ${r1(m.firstDropS)} s and then it ran fast`);
  const puckPrep = puckSignals.length > 0;

  // Dialled in: this shot and the previous one are both in range and rated 4+.
  const prev = hist.prev;
  if (m.dialledIn) {
    tips.push(mkTip({
      id: 'dialled-in', variable: 'none', priority: P.dialledIn, confidence: 0.9, learnCard: LEARN.dialledIn,
      title: 'Dialled in: change nothing',
      change: 'Keep the same dose, grind and yield. Repeat it to lock it in.',
      why: `Two shots in a row were in range and rated ${E.dialIn.minStars}+ (${fmtTime(prev.m.timeS)} and ${fmtTime(m.timeS)}).`,
    }));
  }

  if (tasteWins) {
    tips.push(mkTip({
      id: 'taste-wins', variable: 'none', priority: P.tasteWins, confidence: 0.8, learnCard: LEARN.tasteVsTime,
      title: 'Taste beats the clock',
      change: `Keep this recipe. Note ${fmtTime(m.timeS)} as the time that works for these beans.`,
      why: `The shot ran ${status} (${fmtTime(eff)} against ${T.sweetFromS}-${T.sweetToS} s), but you rated it ${taste.stars} and it tasted balanced. Time ranges are starting points.`,
    }));
  }

  if (fresh && (!m.inRange || puckPrep) && !m.dialledIn) {
    tips.push(mkTip({
      id: 'fresh-beans', variable: 'beans', priority: P.freshBeans, confidence: 0.6, learnCard: LEARN.freshness,
      title: 'These beans are very fresh',
      change: `Don't chase this shot. Wait a few more days (they are ${plural(age, 'day')} off roast), then dial in.`,
      why: 'Freshly roasted beans release a lot of gas in the first days, which makes espresso flow erratic and hard to read. Rule of thumb: from about a week after roasting they settle.',
    }));
  }

  if (puckPrep && !tasteWins) {
    const conf = clamp(0.5 + 0.12 * puckSignals.length - (fresh ? 0.15 : 0), 0.4, 0.9);
    const first = naked ? ' With a naked portafilter, watch the first 10 s of the stream for jets.' : '';
    tips.push(mkTip({
      id: 'puck-prep', variable: 'puck', priority: P.puckPrep, confidence: r2(conf),
      learnCard: taste.spurts && naked ? LEARN.nakedSpurts : LEARN.channeling,
      title: 'Even out the puck before touching the grind',
      change: `Keep the grind and dose. Break up clumps (a WDT tool or needle), level the bed, and tamp level and firm.${first}`,
      why: `${puckSignals.join('; ')}. Uneven flow means water is finding weak spots in the puck, which a different grind won't fix.`.replace(/^./, (x) => x.toUpperCase()),
    }));
  }

  if (m.dose != null && m.dose < (num(c.gear.basketG) ?? E.basketDefaultG) - E.doseLowByG) {
    const basket = num(c.gear.basketG) ?? E.basketDefaultG;
    tips.push(mkTip({
      id: 'low-dose', variable: 'dose', priority: timeDir === 'finer' || fdEarly ? P.lowDose : P.targetMiss, confidence: 0.7, learnCard: LEARN.dose,
      title: 'The basket was under-filled',
      change: `Dose ${fmtG(basket)} g next time, then judge the grind.`,
      why: `${fmtG(m.dose)} g in a ${fmtG(basket)} g basket leaves a gap, so water splashes and digs and the shot runs fast and uneven.`,
    }));
  }

  // ----- grind from time / taste / history -----
  const dev = timeDir === 'finer' ? T.fastBelowS - eff : timeDir === 'coarser' ? eff - T.slowAboveS : 0;
  const streak = (() => {
    let n = 0;
    for (let i = hist.list.length - 1; i >= 0 && hist.list[i].m.timeStatus === status; i--) n++;
    return n;
  })();
  const stepsLabel = (n) => (typeof n === 'number' ? plural(n, 'step') : `${n} steps`);
  const after = puckPrep ? 'Once the puck is consistent: ' : '';

  if (timeDir && !tasteWins && !conflict && !fastButLate) {
    const gusher = timeDir === 'finer' && eff < T.gusherBelowS;
    const steps = gusher ? E.gusherSteps : grindSteps(dev, E);
    const agree = tasteDir === timeDir;
    const conf = clamp((agree ? 0.88 : 0.75) + (streak + 1 >= E.history.streakForConfidence ? 0.05 : 0) - (fresh ? 0.15 : 0), 0.3, 0.95);
    const reasons = [];
    reasons.push(timeDir === 'finer'
      ? `${fmtTime(m.timeS)} for ${fmtG(m.yield)} g is quick (aim for ${T.sweetFromS}-${T.sweetToS} s), so water had little time to dissolve the coffee`
      : `${fmtTime(m.timeS)} for ${fmtG(m.yield)} g is slow (aim for ${T.sweetFromS}-${T.sweetToS} s), so the water stayed in contact too long`);
    if (agree) reasons.push(`it tasted ${timeDir === 'finer' ? 'sour' : 'bitter'}, which agrees`);
    if (streak + 1 >= E.history.streakForConfidence) reasons.push(`this is the ${streak + 1}${streak + 1 === 3 ? 'rd' : 'th'} ${status} shot in a row on these beans`);
    if (timeDir === 'coarser' && fdLate) reasons.push(`first drops took ${r1(m.firstDropS)} s, which also points to a grind that is too fine`);
    if (timeDir === 'finer' && fdEarly) reasons.push(`first drops came after only ${r1(m.firstDropS)} s`);
    if (fresh) reasons.push(`beans are only ${plural(age, 'day')} old, so treat this as a rough guide`);
    const base = mkTip({
      id: `grind-${timeDir}`, variable: 'grind', priority: agree ? P.tasteAndTime : P.timeGrind, confidence: r2(conf),
      learnCard: gusher ? LEARN.stepSize : timeDir === 'finer' ? LEARN.fastSour : LEARN.slowBitter,
      title: timeDir === 'finer' ? (gusher ? 'Much too fast: grind finer' : 'Grind finer') : 'Grind coarser',
      change: `${after}Go ${grindWord(timeDir, stepsLabel(steps))}${suggestValue(timeDir, steps, curVal, finerIsHigher)}; same dose, same ${fmtG(m.targetYield ?? m.yield)} g yield.`,
      why: `${reasons.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()),
    });
    tips.push(base);

    // History: what did the last grind change do?
    const pr = hist.prev;
    if (pr && hist.finerSteps != null) {
      const went = hist.finerSteps > 0 ? 'finer' : hist.finerSteps < 0 ? 'coarser' : null;
      const tchg = eff - (pr.m.effectiveTimeS ?? eff);
      const exp = went === 'finer' ? 1 : -1;
      const prevDir = pr.m.timeStatus === 'fast' ? 'finer' : pr.m.timeStatus === 'slow' ? 'coarser' : null;
      const H = E.history;
      const times = `${fmtTime(pr.m.effectiveTimeS)} to ${fmtTime(eff)}`;
      if (went) {
        if (tchg * exp <= -H.meaningfulTimeChangeS) {
          tips.push(mkTip({
            id: 'history-other-change', variable: 'puck', priority: P.historyWrongWay, confidence: 0.6, learnCard: LEARN.oneChange,
            title: 'Grind and time moved opposite ways',
            change: 'Hold the grind. Repeat with the same dose, tamp and yield to see what else changed.',
            why: `You went ${went} but time ${tchg > 0 ? 'rose' : 'fell'} ${r1(Math.abs(tchg))} s (${times}). Dose, tamp or bean age probably changed too.`,
          }));
        } else if (went === timeDir) {
          if (tchg * exp >= H.meaningfulTimeChangeS) {
            tips.push(mkTip({
              id: 'history-keep-going', variable: 'grind', priority: P.historyKeepGoing, confidence: 0.85, learnCard: LEARN.grindFirst,
              title: 'That change worked: keep going',
              change: `${after}Go ${stepsLabel(grindSteps(dev, E))} ${timeDir} again${suggestValue(timeDir, grindSteps(dev, E), curVal, finerIsHigher)}.`,
              why: `You went ${went} last shot and time ${tchg > 0 ? 'rose' : 'fell'} ${r1(Math.abs(tchg))} s (${times}), but it is still ${status}.`,
            }));
          } else if (Math.abs(tchg) < H.noEffectBelowS) {
            tips.push(mkTip({
              id: 'history-no-effect', variable: 'grind', priority: P.historyNoEffect, confidence: 0.7, learnCard: LEARN.stepSize,
              title: 'Last step barely changed the time',
              change: `${after}Take a bigger step: ${stepsLabel(E.grindStepsFar)} ${timeDir}${suggestValue(timeDir, E.grindStepsFar, curVal, finerIsHigher)}.`,
              why: `You went ${went} but time moved only ${r1(Math.abs(tchg))} s (${times}). Steps on your grinder may be small.`,
            }));
          }
        } else if (prevDir === went) {
          tips.push(mkTip({
            id: 'history-overshoot', variable: 'grind', priority: P.historyOvershoot, confidence: 0.8, learnCard: LEARN.stepSize,
            title: 'Slight overshoot: go back half a step',
            change: `${after}Move about half a step back ${timeDir}${curVal != null && hist.prevValue != null ? `, between ${hist.prevValue} and ${curVal}` : ''}.`,
            why: `The previous shot was ${pr.m.timeStatus}; you went ${went} and now it is ${status} (${times}).`,
          }));
        }
      }
    }
  } else if (!timeDir && tasteDir && !both && m.timeStatus) {
    const nearFast = eff < T.sweetFromS;
    const nearSlow = eff > T.sweetToS;
    const Y = E.yieldAdjustG;
    const yNow = m.yield ?? m.targetYield;
    const sour = tasteDir === 'finer';
    if ((sour && nearFast) || (!sour && nearSlow)) {
      tips.push(mkTip({
        id: `grind-${tasteDir}-small`, variable: 'grind', priority: P.tasteRatio + 2, confidence: 0.6,
        learnCard: sour ? LEARN.fastSour : LEARN.slowBitter,
        title: sour ? 'Sour and on the quick side: grind slightly finer' : 'Bitter and on the slow side: grind slightly coarser',
        change: `${after}Go 1 step ${tasteDir}${suggestValue(tasteDir, 1, curVal, finerIsHigher)}; same dose and yield.`,
        why: `Time (${fmtTime(m.timeS)}) is in range but towards the ${sour ? 'fast' : 'slow'} end, and taste says ${sour ? 'under' : 'over'}-extracted.`,
      }));
    } else if (yNow != null && m.dose > 0) {
      const newY = sour ? yNow + Y : yNow - Y;
      tips.push(mkTip({
        id: sour ? 'ratio-longer' : 'ratio-shorter', variable: 'ratio', priority: P.tasteRatio, confidence: 0.65,
        learnCard: LEARN.sourBitter,
        title: sour ? 'Sour: run the shot a little longer' : 'Bitter: stop the shot a little sooner',
        change: `${after}Stop at about ${fmtG(newY)} g (1:${r1(newY / m.dose)}) with the same grind.`,
        why: `The time (${fmtTime(m.timeS)}) is fine, so the grind isn't the problem. ${sour ? 'More water through the puck dissolves more of the sweeter, rounder flavours' : 'Cutting the shot earlier leaves out the harsh late flavours'}.`,
      }));
    }
  } else if (!timeDir && !tasteDir && !both && taste.strength && m.yield != null && m.dose > 0 && m.timeStatus) {
    const weak = taste.strength < 0;
    const newY = weak ? m.yield - E.yieldAdjustG : m.yield + E.yieldAdjustG;
    tips.push(mkTip({
      id: weak ? 'strength-weak' : 'strength-strong', variable: 'ratio', priority: P.strength, confidence: 0.65, learnCard: LEARN.ratio,
      title: weak ? 'Too weak: use a shorter ratio' : 'Too strong: use a longer ratio',
      change: `${after}Stop at about ${fmtG(newY)} g (1:${r1(newY / m.dose)}) with the same grind.`,
      why: 'Strength is set by how much liquid you let through, so change the yield. Grind changes the speed, not the strength.',
    }));
  }

  // History: same grind but a very different time means preparation wasn't repeatable.
  if (prev && hist.finerSteps === 0 && m.timeS != null && prev.m.timeS != null && Math.abs(m.timeS - prev.m.timeS) >= E.history.sameGrindTimeSwingS && !puckPrep) {
    tips.push(mkTip({
      id: 'history-inconsistent', variable: 'puck', priority: P.timeGrind - 1, confidence: 0.6, learnCard: LEARN.puckPrep,
      title: 'Same grind, different time: make your prep repeatable',
      change: 'Weigh the dose to 0.1 g and use the same distribution and tamp every time.',
      why: `With the same grind setting the time went ${fmtTime(prev.m.timeS)} then ${fmtTime(m.timeS)}.`,
    }));
  }

  // First drops
  if (fdEarly && timeDir !== 'finer') {
    tips.push(mkTip({
      id: 'first-drops-early', variable: 'dose', priority: P.firstDrops, confidence: 0.45, learnCard: LEARN.firstDrops,
      title: `Coffee appeared after only ${r1(m.firstDropS)} s`,
      change: 'Check the basket is fully dosed and the puck is level. If it also tastes sour, go 1 step finer.',
      why: 'Under about 5 s usually means a coarse grind, a low dose or water racing around the puck.',
    }));
  } else if (fdLate && !timeDir && !puckPrep) {
    tips.push(mkTip({
      id: 'first-drops-late', variable: 'grind', priority: P.firstDrops, confidence: 0.45, learnCard: LEARN.firstDrops,
      title: `First drops took ${r1(m.firstDropS)} s`,
      change: `Try 1 step coarser${suggestValue('coarser', 1, curVal, finerIsHigher)}.`,
      why: 'Without preinfusion control, a wait over about 12 s usually means the puck is too fine or packed too hard, even if the total time is OK.',
    }));
  }

  // Late-shot flow
  if (m.lateRamp != null && m.lateRamp >= E.lateRamp.blondingRatio && !m.unstable) {
    tips.push(mkTip({
      id: 'blonding', variable: 'ratio', priority: P.blonding, confidence: 0.5, learnCard: LEARN.blonding,
      title: 'The end of the shot ran fast',
      change: `Stop a few grams sooner${m.yield ? `, around ${fmtG(m.yield - 3)} g` : ''}.`,
      why: `Flow in the last part was ${r1(m.lateRamp)}x the early flow, which usually means the coffee is spent and the cup gets thin.`,
    }));
  }

  // Beans past their best
  if (age != null && age > E.beanAgeDays.stale && timeDir === 'finer') {
    tips.push(mkTip({
      id: 'stale-beans', variable: 'beans', priority: P.staleBeans, confidence: 0.5, learnCard: LEARN.freshness,
      title: 'These beans are past their peak',
      change: 'Keep grinding finer for now; a fresher bag will be easier to hit.',
      why: `They are about ${Math.round(age / 7)} weeks off roast. Older beans usually run faster, so the grind has to follow.`,
    }));
  }

  // Stopping and target yield
  if (m.targetYield != null && m.yield != null) {
    const over = m.yield - m.targetYield;
    const drip = m.dripAfterStopG;
    if (over > E.yieldToleranceG || (drip != null && drip >= E.drip.noticeG)) {
      const early = Math.max(1, Math.round(drip ?? over));
      tips.push(mkTip({
        id: 'stop-early', variable: 'stop', priority: P.stopEarly, confidence: drip != null ? 0.7 : 0.5, learnCard: LEARN.stopEarly,
        title: 'Stop the pump a little earlier',
        change: `Stop about ${early} g before ${fmtG(m.targetYield)} g.`,
        why: drip != null ? `${fmtG(drip)} g kept dripping after the pump stopped${over > E.yieldToleranceG ? ` and you ended ${fmtG(over)} g over target` : ''}.` : `You ended ${fmtG(over)} g over target.`,
      }));
    } else if (over < -E.yieldToleranceG && !timeDir) {
      tips.push(mkTip({
        id: 'reach-target', variable: 'stop', priority: P.targetMiss, confidence: 0.5, learnCard: LEARN.ratio,
        title: 'Run to your target yield',
        change: `Let it run to about ${fmtG(m.targetYield)} g before stopping.`,
        why: `You stopped ${fmtG(-over)} g short, so the time and taste don't compare with the recipe.`,
      }));
    }
  }

  // Nothing to fix
  if (m.inRange && !puckPrep && !m.dialledIn && !tips.some((t) => t.priority >= P.timeGrind)) {
    if (!taste.given) {
      tips.push(mkTip({
        id: 'log-taste', variable: 'none', priority: P.logTaste, confidence: 0.5, learnCard: LEARN.sourBitter,
        title: 'Time is in range: now taste it',
        change: 'Tap sour, balanced or bitter and give it stars. Taste decides the next step.',
        why: 'The clock can only say so much. Taste tells us whether to adjust grind or yield.',
      }));
    } else if (!tasteDir && !taste.strength) {
      tips.push(mkTip({
        id: 'repeat', variable: 'none', priority: P.repeat, confidence: 0.5, learnCard: LEARN.dialledIn,
        title: 'Good shot: repeat it',
        change: 'Make the next one exactly the same: dose, grind, yield and tamp.',
        why: 'Two matching shots in range rated 4+ mark the bean as dialled in. Repeating shows if the result is reliable.',
      }));
    }
  }
  return tips;
}

function pourOverTips(brew, m, taste, c) {
  const Pv = c.R.pourover;
  const P = c.R.priority;
  const tips = [];
  const timeDir = m.timeStatus === 'fast' ? 'finer' : m.timeStatus === 'slow' ? 'coarser' : null;
  const slowDraw = m.drawdownS != null && m.drawdownS > Pv.drawdown.slowAboveS;
  const dir = timeDir ?? (slowDraw ? 'coarser' : null);
  const tasteDir = taste.sour && !taste.bitter ? 'finer' : taste.bitter && !taste.sour ? 'coarser' : null;
  const conflict = !!(dir && tasteDir && dir !== tasteDir);

  if (conflict || (taste.sour && taste.bitter)) {
    tips.push(mkTip({
      id: 'pour-technique', variable: 'technique', priority: P.technique, confidence: 0.6, learnCard: LEARN.pours,
      title: 'Even out your pours before changing the grind',
      change: 'Pour slowly in small circles, keep the water off the filter wall, and keep the bed level.',
      why: 'Taste and brew time disagree, or the cup was both sour and bitter. That usually means uneven extraction, which comes from pouring more than from grind.',
    }));
  } else if (dir) {
    const reasons = [];
    if (timeDir) reasons.push(`the brew took ${fmtTime(m.timeS)} (aim for about ${fmtTime(Pv.time.fastBelowS)}-${fmtTime(Pv.time.slowAboveS)})`);
    if (slowDraw) reasons.push(`drawdown took ${fmtTime(m.drawdownS)}, which suggests the bed is choked with fines`);
    if (tasteDir === dir) reasons.push(`it tasted ${dir === 'finer' ? 'sour' : 'bitter'}`);
    tips.push(mkTip({
      id: `grind-${dir}`, variable: 'grind', priority: P.timeGrind + (slowDraw ? 2 : 0), confidence: tasteDir === dir ? 0.85 : 0.7,
      learnCard: slowDraw && dir === 'coarser' ? LEARN.drawdown : dir === 'finer' ? LEARN.fastSour : LEARN.slowBitter,
      title: dir === 'finer' ? 'Grind finer' : 'Grind coarser',
      change: `Go 1 step ${dir}; keep the dose, water and pour plan.`,
      why: `${reasons.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()),
    }));
  } else if (tasteDir) {
    tips.push(mkTip({
      id: `grind-${tasteDir}-small`, variable: 'grind', priority: P.tasteRatio + 2, confidence: 0.6, learnCard: LEARN.sourBitter,
      title: tasteDir === 'finer' ? 'Sour: grind a little finer' : 'Bitter: grind a little coarser',
      change: `Go 1 step ${tasteDir}; keep everything else.`,
      why: `The time (${fmtTime(m.timeS)}) is on plan, so the grind is the simplest lever. Hotter water also extracts more, if you can adjust it.`,
    }));
  } else if (taste.strength && m.dose > 0) {
    const weak = taste.strength < 0;
    tips.push(mkTip({
      id: weak ? 'strength-weak' : 'strength-strong', variable: 'ratio', priority: P.strength, confidence: 0.65, learnCard: LEARN.ratio,
      title: weak ? 'Too weak: use a bit less water' : 'Too strong: use a bit more water',
      change: `Use about ${fmtG(weak ? m.yield - Pv.yieldAdjustG : m.yield + Pv.yieldAdjustG)} g water for ${fmtG(m.dose)} g coffee.`,
      why: 'Strength follows the ratio. Grind changes the speed and extraction, not the amount of water.',
    }));
  }

  if (m.adherence != null && m.adherence < Pv.steps.minAdherence) {
    const worst = [...m.steps].filter((s) => s.deltaS != null).sort((a, b) => Math.abs(b.deltaS) - Math.abs(a.deltaS))[0];
    tips.push(mkTip({
      id: 'follow-steps', variable: 'technique', priority: P.followSteps, confidence: 0.6, learnCard: LEARN.pours,
      title: 'Stick closer to the pour plan',
      change: worst ? `Reach each target weight within ${Pv.steps.toleranceS} s of plan. "${worst.label ?? worst.kind}" was ${r1(Math.abs(worst.deltaS))} s ${worst.deltaS > 0 ? 'late' : 'early'}.` : 'Reach each target weight on time.',
      why: `Only ${Math.round(m.adherence * 100)}% of the steps landed on time, so this brew can't be compared with the plan.`,
    }));
  } else if (m.pourRateGps != null && m.pourRateGps > Pv.pourRateFastGps) {
    tips.push(mkTip({
      id: 'pour-gently', variable: 'technique', priority: P.followSteps - 5, confidence: 0.45, learnCard: LEARN.pours,
      title: 'Pour a little more gently',
      change: 'Slow the pour toward 4-7 g/s and keep it in small circles.',
      why: `You poured at about ${r1(m.pourRateGps)} g/s. Fast pours stir the bed up and speed the drain.`,
    }));
  }

  if (m.timeStatus === 'ok' && !taste.given && !tips.length) {
    tips.push(mkTip({
      id: 'log-taste', variable: 'none', priority: P.logTaste, confidence: 0.5, learnCard: LEARN.sourBitter,
      title: 'On plan: now taste it',
      change: 'Tap sour, balanced or bitter and give it stars.',
      why: 'Taste tells us which way to nudge the next brew.',
    }));
  }
  return tips;
}

function immersionTips(brew, m, taste, c) {
  const I = c.R.immersion;
  const P = c.R.priority;
  const tips = [];
  const win = I.steep[c.method] ?? I.steep.aeropress;
  const ref = m.steepS ?? m.timeS;
  const timeDir = m.timeStatus === 'short' ? 'more' : m.timeStatus === 'long' ? 'less' : null;
  const tasteDir = taste.sour && !taste.bitter ? 'more' : taste.bitter && !taste.sour ? 'less' : null;
  const conflict = !!(timeDir && tasteDir && timeDir !== tasteDir);

  if (conflict || (taste.sour && taste.bitter)) {
    tips.push(mkTip({
      id: 'stir-evenly', variable: 'technique', priority: P.technique, confidence: 0.55, learnCard: LEARN.immersion,
      title: 'Saturate all the grounds evenly',
      change: 'Stir gently after pouring so no dry clumps float, then keep the steep time the same.',
      why: 'Taste and steep time disagree, or the cup was both sour and bitter. That points to uneven extraction rather than steep time.',
    }));
  } else if (timeDir || tasteDir) {
    const more = (timeDir ?? tasteDir) === 'more';
    const agree = timeDir && tasteDir === timeDir;
    const target = ref != null ? ref + (more ? I.steepStepS : -I.steepStepS) : null;
    tips.push(mkTip({
      id: more ? 'steep-longer' : 'steep-shorter', variable: 'time', priority: agree ? P.tasteAndTime : P.timeGrind, confidence: agree ? 0.85 : 0.65,
      learnCard: LEARN.immersion,
      title: more ? 'Steep a little longer' : 'Steep a little shorter',
      change: `${more ? 'Add' : 'Take off'} about ${I.steepStepS} s${target != null ? ` (aim for ${fmtTime(target)})` : ''}; keep grind and dose.`,
      why: `${timeDir ? `You steeped ${fmtTime(ref)} (usual window ${fmtTime(win.shortBelowS)}-${fmtTime(win.longAboveS)}). ` : ''}${tasteDir ? `It tasted ${more ? 'sour' : 'bitter'}. ` : ''}Steep time is the easiest lever in immersion.`.trim(),
    }));
  } else if (taste.strength && m.dose > 0) {
    const weak = taste.strength < 0;
    tips.push(mkTip({
      id: weak ? 'strength-weak' : 'strength-strong', variable: 'ratio', priority: P.strength, confidence: 0.65, learnCard: LEARN.ratio,
      title: weak ? 'Too weak: use a bit more coffee' : 'Too strong: use a bit less coffee',
      change: `Use about ${fmtG(m.dose * (weak ? 1.1 : 0.9))} g coffee with the same water.`,
      why: 'Strength follows the ratio. Steep time and grind change how much is extracted.',
    }));
  }
  if (m.timeStatus === 'ok' && !taste.given && !tips.length) {
    tips.push(mkTip({
      id: 'log-taste', variable: 'none', priority: P.logTaste, confidence: 0.5, learnCard: LEARN.sourBitter,
      title: 'Timing looks fine: now taste it',
      change: 'Tap sour, balanced or bitter and give it stars.',
      why: 'Taste tells us whether to steep longer or shorter next time.',
    }));
  }
  return tips;
}

function mokaTips(brew, m, taste, c) {
  const M = c.R.moka;
  const P = c.R.priority;
  const tips = [];
  const spurt = m.lateRamp != null && m.lateRamp >= M.lateRamp.spurtRatio;
  if (spurt || taste.bitter) {
    tips.push(mkTip({
      id: 'moka-stop', variable: 'stop', priority: P.timeGrind, confidence: spurt && taste.bitter ? 0.65 : 0.45, learnCard: LEARN.moka,
      title: 'Take it off the heat sooner',
      change: 'Remove the pot as soon as the stream turns pale and starts to sputter, and cool the base under cold water.',
      why: spurt ? `Flow near the end was ${r1(m.lateRamp)}x faster, which is the sputtering stage.` : 'Bitter moka is often over-heated or over-extracted at the end. (Rule of thumb.)',
    }));
  }
  if (m.timeStatus === 'fast' || m.timeStatus === 'slow') {
    const fast = m.timeStatus === 'fast';
    tips.push(mkTip({
      id: fast ? 'moka-heat-lower' : 'moka-heat-higher', variable: 'heat', priority: P.tasteRatio, confidence: 0.35, learnCard: LEARN.moka,
      title: fast ? 'Try gentler heat' : 'Try slightly more heat',
      change: fast ? 'Use medium-low heat with the lid open.' : 'Raise the heat a little, still with the lid open.',
      why: `It took ${fmtTime(m.timeS)}. This is a rough rule of thumb, so treat it as an experiment.`,
    }));
  }
  return tips;
}

function finalizeTips(tips, R) {
  const sorted = tips.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
  const seen = new Set();
  const out = [];
  for (const t of sorted) {
    if (t.variable !== 'none' && seen.has(t.variable)) continue; // one change per variable
    seen.add(t.variable);
    const { priority, ...rest } = t;
    out.push(rest);
    if (out.length >= R.maxTips) break;
  }
  return out;
}

// ---------- verdict ----------------------------------------------------------------------------
function verdictFor(m, c) {
  const y = m.yield != null ? `${fmtG(m.yield)} g` : null;
  if (m.timeS == null) return y ? `Saved ${y}; no timing was recorded.` : 'Not enough data to judge this brew.';
  const tail = `${y ? `${y} in ` : ''}${fmtTime(m.timeS)}.`;
  switch (c.family) {
    case 'espresso': {
      const label = { fast: 'Ran fast', slow: 'Ran slow', sweet: 'Right on target', ok: 'In range' }[m.timeStatus];
      if (m.unstable) return m.timeStatus === 'fast' || m.timeStatus === 'slow' ? `${label} and uneven: ${tail}` : `Time was fine but the flow was uneven: ${tail}`;
      return `${label}: ${tail}`;
    }
    case 'pourover': {
      if (m.timeStatus === 'ok' && m.drawdownS != null && m.drawdownS > c.R.pourover.drawdown.slowAboveS) return `Slow drawdown (${fmtTime(m.drawdownS)}): ${tail}`;
      return `${{ fast: 'Ran fast', slow: 'Ran slow', ok: 'On track' }[m.timeStatus]}: ${tail}`;
    }
    case 'immersion': {
      if (m.steepS != null) return `Steeped ${fmtTime(m.steepS)}${y ? `: ${y}` : ''}.`;
      return `${{ short: 'Short steep', long: 'Long steep', ok: 'Steep on track' }[m.timeStatus] ?? 'Brewed'}: ${tail}`;
    }
    case 'moka': return `Moka done: ${tail}`;
    default: return `Brewed ${tail}`;
  }
}

// ---------- entry point ------------------------------------------------------------------------
export function analyze(brew, ctx = {}) {
  brew = brew && typeof brew === 'object' ? brew : {};
  const R = ctx.rules ?? RULES;
  const method = ctx.method ?? brew.method ?? 'espresso';
  const family = METHOD_FAMILY[method] ?? null;
  const c = {
    method, family, R,
    gear: { ...(brew.gear || {}), ...(ctx.gear || {}) },
    bean: ctx.bean ?? null,
    steps: ctx.steps ?? ctx.recipe?.steps ?? brew.steps ?? null,
  };
  const m = computeMetrics(brew, c);
  const taste = readTaste(brew.taste);

  // History for this bean: previous shot, grind change between them, and recent statuses.
  const list = relevantHistory(brew, ctx.history, method).map((h) => {
    const hm = computeMetrics(h, { ...c, bean: null });
    if (hm.timeStatus == null && h.metrics?.timeStatus) Object.assign(hm, { timeStatus: h.metrics.timeStatus, inRange: !!h.metrics.inRange });
    return { brew: h, m: hm };
  });
  const prev = list.length ? list[list.length - 1] : null;
  const curVal = num(brew.grind?.value);
  const prevValue = num(prev?.brew.grind?.value);
  const finerSteps = curVal != null && prevValue != null ? (c.gear.grinderFinerIsHigher ? curVal - prevValue : prevValue - curVal) : null;
  const hist = { list, prev, prevValue, finerSteps };

  m.dialledIn = family === 'espresso' && !!prev && isGoodShot(m, taste, R.espresso.dialIn) && isGoodShot(prev.m, readTaste(prev.brew.taste), R.espresso.dialIn);

  let tips = [];
  switch (family) {
    case 'espresso': tips = espressoTips(brew, m, taste, c, hist); break;
    case 'pourover': tips = pourOverTips(brew, m, taste, c); break;
    case 'immersion': tips = immersionTips(brew, m, taste, c); break;
    case 'moka': tips = mokaTips(brew, m, taste, c); break;
  }
  tips = finalizeTips(tips, R);
  const learn = [...new Set(tips.map((t) => t.learnCard).filter(Boolean))];
  return { metrics: roundMetrics(m), verdict: verdictFor(m, c), tips, learn };
}
