// Brew history: shape, migration, merge, export. Pure ES module, no DOM.
//
// Stored under localStorage `dot.history` as an array, oldest first.
// v1 entries (before this module): { at, dose, out, time }
// v2 entries add:                   id, target?, samples?, notes?, updated?
//   samples: [[t, w, f], ...]  seconds, grams, g/s, rounded to 0.1, at most MAX_SAMPLES points
//   notes:   { bean?, grind?, rating? (1–5), text? }
// v1 entries are a valid subset, so migration only adds an `id` and cleans up types.

export const MAX_ENTRIES = 200;
export const MAX_SAMPLES = 150;
export const EXPORT_FORMAT = 'dot-scale-history';
export const EXPORT_VERSION = 2;

const r1 = (n) => Math.round(n * 10) / 10;
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Deterministic id for an entry, so the same brew from two browsers de-duplicates. */
export function entryId(e) {
  return `${e.at}-${r1(e.dose)}-${r1(e.out)}`;
}

function cleanNotes(n) {
  if (!n || typeof n !== 'object') return undefined;
  const out = {};
  for (const k of ['bean', 'grind', 'text']) {
    if (typeof n[k] === 'string' && n[k].trim()) out[k] = n[k].trim().slice(0, 500);
  }
  const rating = Math.round(num(n.rating));
  if (rating >= 1 && rating <= 5) out.rating = rating;
  return Object.keys(out).length ? out : undefined;
}

function cleanSamples(s) {
  if (!Array.isArray(s)) return undefined;
  const out = [];
  for (const p of s) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const t = num(p[0]), w = num(p[1]), f = p.length > 2 ? num(p[2]) : 0;
    if ([t, w, f].every(Number.isFinite)) out.push([r1(t), r1(w), r1(f)]);
  }
  return out.length >= 2 ? out.slice(0, MAX_SAMPLES * 2) : undefined;
}

/** Normalise one entry of any known version; returns null if it isn't a usable brew. */
export function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const at = typeof e.at === 'string' ? Date.parse(e.at) : num(e.at);
  const dose = num(e.dose), out = num(e.out), time = num(e.time ?? 0);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(dose) || !Number.isFinite(out)) return null;
  const entry = { id: typeof e.id === 'string' && e.id ? e.id : '', at, dose, out, time: Number.isFinite(time) ? time : 0 };
  if (!entry.id) entry.id = entryId(entry);
  const target = num(e.target);
  if (Number.isFinite(target) && target > 0) entry.target = target;
  const samples = cleanSamples(e.samples);
  if (samples) entry.samples = samples;
  const notes = cleanNotes(e.notes);
  if (notes) entry.notes = notes;
  const updated = num(e.updated);
  if (Number.isFinite(updated) && updated > 0) entry.updated = updated;
  return entry;
}

/** Migrate whatever is in storage to the current shape: valid entries only, oldest first, capped. */
export function migrate(list) {
  if (!Array.isArray(list)) return [];
  return mergeHistory([], list);
}

/** Combine two entries with the same id: newest edit wins, missing fields filled from the other. */
function combine(a, b) {
  const [newer, older] = (b.updated || 0) > (a.updated || 0) ? [b, a] : [a, b];
  const out = { ...older, ...newer };
  // Notes cleared by a later edit stay cleared; an unedited copy keeps the other side's notes.
  if (!newer.notes && newer.updated) delete out.notes;
  return out;
}

/** Merge `incoming` into `existing`, de-duplicated by id. Returns a new sorted, capped array. */
export function mergeHistory(existing, incoming, max = MAX_ENTRIES) {
  const byId = new Map();
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    const e = normalizeEntry(raw);
    if (!e) continue;
    byId.set(e.id, byId.has(e.id) ? combine(byId.get(e.id), e) : e);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-max);
}

/**
 * Downsample a pour series [{t, w, f}] to at most `max` points spread evenly in time.
 * Always keeps the first and last point.
 */
export function downsample(series, max = MAX_SAMPLES) {
  const s = (series || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.w));
  if (s.length < 2) return [];
  const pick = (p) => [r1(p.t), r1(p.w), r1(Number.isFinite(p.f) ? p.f : 0)];
  if (s.length <= max) return s.map(pick);
  const out = [];
  const t0 = s[0].t, span = s[s.length - 1].t - t0;
  let i = 0;
  for (let k = 0; k < max; k++) {
    const tk = t0 + (span * k) / (max - 1);
    while (i < s.length - 1 && s[i + 1].t <= tk) i++;
    // pick the nearer of s[i] and s[i+1]
    const j = i < s.length - 1 && Math.abs(s[i + 1].t - tk) < Math.abs(s[i].t - tk) ? i + 1 : i;
    if (!out.length || out[out.length - 1] !== s[j]) out.push(s[j]);
  }
  if (out[out.length - 1] !== s[s.length - 1]) out[out.length - 1] = s[s.length - 1];
  return out.map(pick);
}

/** Samples [[t,w,f]] back to the series shape the chart draws. */
export function samplesToSeries(samples) {
  return (samples || []).map(([t, w, f]) => ({ t, w, f: f ?? 0 }));
}

export function toExport(list, now = Date.now()) {
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date(now).toISOString(), history: list };
}

/** Parse an export file's text. Accepts our export object or a bare array. Throws on garbage. */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.history) ? data.history : null;
  if (!list) throw new Error('No brew history found in this file');
  if (!Array.isArray(data) && data.format && data.format !== EXPORT_FORMAT) throw new Error('Not a Dot Scale history export');
  const valid = list.map(normalizeEntry).filter(Boolean);
  if (list.length && !valid.length) throw new Error('No valid brews in this file');
  return valid;
}

export const CSV_COLUMNS = ['date', 'dose_g', 'out_g', 'ratio', 'time_s', 'target_g', 'bean', 'grind', 'rating', 'notes'];

function csvCell(v) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  // Stop spreadsheets from treating free text as a formula.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(list) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of list) {
    const n = e.notes || {};
    rows.push([
      new Date(e.at).toISOString(), e.dose, e.out, e.dose > 0 ? r1(e.out / e.dose) : '', e.time, e.target ?? '',
      n.bean ?? '', n.grind ?? '', n.rating ?? '', n.text ?? '',
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
