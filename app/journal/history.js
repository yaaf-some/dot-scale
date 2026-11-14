// Journal logic: grouping, filters, curves, sparklines and the per-bean dial-in trail. Pure, no DOM (tested in test/journal.test.mjs).
// Brew records follow docs/PRODUCT.md §6. Old-app brews (`legacy: true`) and brews without `samples` are first-class: every
// function here copes with a missing curve, taste, bean or grind.
import { analyze, findDialledIn } from '../insights/analyze.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;

// ---------- days, rows, filters ----------------------------------------------------------------
const p2 = (n) => String(n).padStart(2, '0');
/** Local calendar day, "YYYY-MM-DD". */
export const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

export function dayLabel(key, now = Date.now()) {
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86400000)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (y !== new Date(now).getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

const byNewest = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0);

/** Live brews grouped by local day, newest day first, newest brew first inside a day. → [{ key, label, brews }] */
export function groupByDay(brews, now = Date.now()) {
  const days = new Map();
  for (const b of [...(brews ?? [])].filter((x) => x && !x.deleted && finite(x.startedAt)).sort(byNewest)) {
    const k = dayKey(b.startedAt);
    if (!days.has(k)) days.set(k, { key: k, label: dayLabel(k, now), brews: [] });
    days.get(k).brews.push(b);
  }
  return [...days.values()];
}

export const NO_BEAN = 'none';

/** filters: { profileId, method, beanId }, each optional; '' / 'all' / undefined = any. beanId NO_BEAN = brews without a bean. */
export function filterBrews(brews, { profileId, method, beanId } = {}) {
  const any = (v) => !v || v === 'all';
  return (brews ?? []).filter((b) => b && !b.deleted
    && (any(profileId) || b.profileId === profileId)
    && (any(method) || b.method === method)
    && (any(beanId) || (beanId === NO_BEAN ? !b.beanId : b.beanId === beanId)));
}

/** Which methods / beans actually appear in `brews`, so the filter menus only offer choices that match something. */
export function filterChoices(brews) {
  const methods = [], beanIds = [];
  let noBean = false;
  for (const b of brews ?? []) {
    if (!b || b.deleted) continue;
    if (b.method && !methods.includes(b.method)) methods.push(b.method);
    if (b.beanId) { if (!beanIds.includes(b.beanId)) beanIds.push(b.beanId); } else noBean = true;
  }
  return { methods, beanIds, noBean };
}

export const stars = (b) => { const s = b?.taste?.stars; return Number.isInteger(s) && s >= 1 && s <= 5 ? s : null; };

export function ratioOf(b) {
  if (finite(b?.ratio) && b.ratio > 0) return b.ratio;
  return b?.dose > 0 && finite(b?.yield) ? b.yield / b.dose : null;
}
export const ratioText = (b) => { const r = ratioOf(b); return r == null ? '' : `1:${r1(r).toFixed(1).replace(/\.0$/, '')}`; };

export const beanOf = (beans, b) => (b?.beanId ? (beans ?? []).find((x) => x.id === b.beanId) : undefined);

// ---------- curves -----------------------------------------------------------------------------
function carry(a) {
  let last = 0;
  return a.map((v) => (finite(v) ? (last = v) : last));
}

function deriveFlow(w, hz) {
  const k = Math.max(1, Math.round(hz * 0.3));
  return w.map((_, i) => {
    const lo = Math.max(0, i - k), hi = Math.min(w.length - 1, i + k);
    return hi === lo ? 0 : Math.max(0, ((w[hi] - w[lo]) * hz) / (hi - lo));
  });
}

/** The brew's curve as { hz, t0, weight[], flow[], duration }, or null when it has none (old-app brews, manual entries). */
export function curveOf(brew) {
  const s = brew?.samples;
  const w = s?.channels?.weight;
  if (!Array.isArray(w) || w.length < 2) return null;
  const hz = finite(s.hz) && s.hz > 0 ? s.hz : 10;
  const t0 = finite(s.t0) ? s.t0 : 0;
  const weight = carry(w);
  const f = s.channels.flow;
  const flow = Array.isArray(f) && f.length === w.length ? carry(f) : deriveFlow(weight, hz);
  return { hz, t0, weight, flow, duration: (weight.length - 1) / hz };
}

/** At most `max` evenly spaced values, keeping the first and last. */
export function thin(arr, max) {
  if (arr.length <= max) return arr.slice();
  return Array.from({ length: max }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (max - 1))]);
}

/** SVG path data for a small weight sparkline in a w×h box, or '' without a curve. */
export function sparkPath(brew, { w = 72, h = 24, pad = 2, max = 40 } = {}) {
  const c = curveOf(brew);
  if (!c) return '';
  const pts = thin(c.weight, max);
  const top = Math.max(1, ...pts);
  return pts.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / (pts.length - 1);
    const y = h - pad - (Math.max(0, v) / top) * (h - 2 * pad);
    return `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`;
  }).join('');
}

// ---------- dial-in trail ----------------------------------------------------------------------
/** How the grind changed between two shots. Convention follows the insights engine: a lower number is finer unless gear.grinderFinerIsHigher. */
export function grindChange(prev, cur, finerIsHigher = false) {
  const a = prev?.grind, b = cur?.grind;
  if (finite(a?.value) && finite(b?.value)) {
    const delta = r1(b.value - a.value);
    if (delta === 0) return { kind: 'same', delta: 0, label: 'Same grind' };
    const finer = finerIsHigher ? delta > 0 : delta < 0;
    return { kind: finer ? 'finer' : 'coarser', delta, label: `${finer ? 'Finer' : 'Coarser'} by ${Math.abs(delta)}` };
  }
  const ta = (a?.text ?? '').trim(), tb = (b?.text ?? '').trim();
  if (ta && tb) return ta.toLowerCase() === tb.toLowerCase() ? { kind: 'same', delta: null, label: 'Same grind' } : { kind: 'changed', delta: null, label: 'Grind changed' };
  return null;
}

export const grindText = (b) => {
  const g = b?.grind;
  if (!g) return '';
  const v = finite(g.value) ? String(g.value) : '';
  return [v, (g.text ?? '').trim()].filter(Boolean).join(' · ');
};

/**
 * The sequence of shots for ONE bean and method, oldest first, each with what changed and what came of it.
 * Insight fields are recomputed with analyze() so engine improvements apply to old brews.
 * → { method, shots: [{ brew, id, startedAt, grind, change, timeS, yield, ratio, status, inRange, stars, balance, verdict, dialledIn }],
 *     dialledInId, dialledIn: boolean }
 */
export function buildTrail(brews, { bean, method, analyzeFn = analyze } = {}) {
  const list = (brews ?? []).filter((b) => b && !b.deleted && (!method || b.method === method)).sort((a, b) => -byNewest(a, b));
  const m = method ?? list[0]?.method ?? 'espresso';
  let dialledInId = null;
  try { dialledInId = findDialledIn(list, { method: m }); } catch { /* an odd record must not break the page */ }
  if (dialledInId === true) dialledInId = null;
  const shots = list.map((brew, i) => {
    let a = null;
    try { a = analyzeFn(brew, { method: m, bean, history: list.slice(0, i) }); } catch { /* shown without insights */ }
    const finerIsHigher = !!brew.gear?.grinderFinerIsHigher;
    return {
      brew, id: brew.id, startedAt: brew.startedAt, grind: grindText(brew),
      change: i ? grindChange(list[i - 1], brew, finerIsHigher) : null,
      timeS: finite(brew.timeS) ? brew.timeS : null, yield: finite(brew.yield) ? brew.yield : null, ratio: ratioOf(brew),
      status: a?.metrics?.timeStatus ?? null, inRange: !!a?.metrics?.inRange,
      effectiveTimeS: finite(a?.metrics?.effectiveTimeS) ? a.metrics.effectiveTimeS : null,
      stars: stars(brew), balance: finite(brew.taste?.balance) ? brew.taste.balance : null,
      verdict: a?.verdict ?? '', dialledIn: brew.id === dialledInId,
    };
  });
  return { method: m, shots, dialledInId, dialledIn: !!dialledInId };
}

/** Group one profile's brews by bean+method → [{ beanId, method, brews (oldest first) }], most recently brewed first. Brews without a bean are left out. */
export function groupByBean(brews) {
  const groups = new Map();
  for (const b of [...(brews ?? [])].filter((x) => x && !x.deleted && x.beanId).sort(byNewest)) {
    const k = `${b.beanId}|${b.method}`;
    if (!groups.has(k)) groups.set(k, { beanId: b.beanId, method: b.method, brews: [] });
    groups.get(k).brews.unshift(b);
  }
  return [...groups.values()];
}
