// First-run work: seed profiles and gear, then migrate the pre-redesign localStorage keys into the store.
// legacyToRecords() is pure so it can be unit-tested; runFirstRun() does the I/O and is idempotent.
import { seedRecords, SEED_IDS } from './seeds.js';

const SEEDED = 'seeded.v1';
const MIGRATED = 'migrated.v1';

/** Resample an old [t, w, f][] curve (seconds, grams, g/s) to PRODUCT.md §6's 10 Hz channels. */
export function resampleCurve(points, hz = 10) {
  const pts = (points ?? []).filter((p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return undefined;
  const t0 = pts[0][0];
  const n = Math.floor((pts[pts.length - 1][0] - t0) * hz) + 1;
  const weight = [], flow = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / hz;
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    const [ta, wa, fa] = pts[j], [tb, wb, fb] = pts[j + 1];
    const k = tb === ta ? 0 : Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
    weight.push(+(wa + (wb - wa) * k).toFixed(1));
    flow.push(+(fa + (fb - fa) * k).toFixed(1));
  }
  return { hz, t0, channels: { weight, flow } };
}

/**
 * Old localStorage shape: recipe {dose, ratio}, autoStart, beep, history [{at, dose, out, time, ...}].
 * The old app was a generic scale utility whose defaults were a 15 g : 240 g pour-over, so migrated records are
 * tagged method 'pour-over' and legacy:true. Brew ids are deterministic so importing the same history twice is a no-op.
 */
export function legacyToRecords({ recipe, autoStart, beep, history }, profileId, now = Date.now()) {
  const out = { recipes: [], brews: [], prefs: {} };
  if (typeof autoStart === 'boolean') out.prefs.autoStart = autoStart;
  if (typeof beep === 'boolean') out.prefs.beep = beep;
  if (recipe && recipe.dose > 0 && recipe.ratio > 0) {
    out.recipes.push({
      id: 'legacy-recipe', type: 'recipe', profileId, method: 'pour-over', name: 'Previous recipe',
      dose: recipe.dose, yield: Math.round(recipe.dose * recipe.ratio), ratio: recipe.ratio, legacy: true, updatedAt: now,
    });
  }
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || !(h.dose > 0) || !(h.out > 0) || !Number.isFinite(h.at)) continue;
    const samples = resampleCurve(h.samples);
    const brew = {
      id: `legacy-brew-${h.at}-${h.dose}-${h.out}`, type: 'brew', profileId, method: 'pour-over', legacy: true,
      gear: {}, startedAt: h.at, dose: h.dose, yield: h.out, targetYield: h.target ?? h.out,
      ratio: +(h.out / h.dose).toFixed(2), timeS: h.time ?? 0, metrics: {}, insights: {},
      updatedAt: Number.isFinite(h.updated) ? h.updated : h.at,
    };
    if (samples) brew.samples = { hz: samples.hz, t0: samples.t0, channels: samples.channels };
    if (h.notes && typeof h.notes === 'object') brew.notes = [h.notes.bean, h.notes.grind, h.notes.text].filter(Boolean).join(' · ') || undefined;
    else if (typeof h.notes === 'string') brew.notes = h.notes;
    if (!brew.notes) delete brew.notes;
    out.brews.push(brew);
  }
  return out;
}

function readLegacy(ls) {
  const get = (k) => { try { const v = ls?.getItem('dot.' + k); return v === null || v === undefined ? undefined : JSON.parse(v); } catch { return undefined; } };
  return { recipe: get('recipe'), autoStart: get('autoStart'), beep: get('beep'), history: get('history') };
}

export async function runFirstRun(store, { localStorage = globalThis.localStorage } = {}) {
  const result = { seeded: false, migrated: false };
  if (!(await store.getMeta(SEEDED))) {
    for (const rec of seedRecords()) {
      // putMany via adapter keeps the fixed updatedAt:1 (store.put would stamp "now").
      if (!(await store.adapter.get(rec.id))) await store.adapter.put(rec);
    }
    await store.setMeta(SEEDED, true);
    result.seeded = true;
  }
  if (!(await store.getMeta(MIGRATED))) {
    const legacy = readLegacy(localStorage);
    const owner = (await store.get(SEED_IDS.yaaf)) ? SEED_IDS.yaaf : (await store.list('profile')).at(-1)?.id;
    const { recipes, brews, prefs } = legacyToRecords(legacy, owner);
    // adapter.put keeps each record's own updatedAt (a brew keeps the time it was made).
    for (const r of [...recipes, ...brews]) if (!(await store.adapter.get(r.id))) await store.adapter.put(r);
    for (const [k, v] of Object.entries(prefs)) await store.prefs.set(k, v);
    // The old keys are left in place on purpose: harmless, and the previous deploy still reads them if someone rolls back.
    await store.setMeta(MIGRATED, true);
    result.migrated = !!(recipes.length || brews.length || Object.keys(prefs).length);
  }
  return result;
}
