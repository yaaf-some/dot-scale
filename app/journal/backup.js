// Backup: JSON and CSV export, and JSON import that merges by id (newest updatedAt wins). Pure, no DOM.
// Adapted from the old app's history.js (CSV formula guard, tolerant parsing) to the §6 record model.
import { legacyToRecords } from '../core/bootstrap.js';
import { ratioOf, stars } from './history.js';

export const EXPORT_FORMAT = 'dot-scale';
export const EXPORT_VERSION = 3;
/** Record types a backup carries. Sync tombstones and device prefs are never exported. */
export const BACKUP_TYPES = ['profile', 'gear', 'bean', 'recipe', 'brew'];
const MAX_SAMPLES = 40000; // ~1 h at 10 Hz; anything longer in a file is not a brew we made
const MAX_ID = 120;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function toExport(records, now = Date.now()) {
  const live = (records ?? []).filter((r) => r && !r.deleted && BACKUP_TYPES.includes(r.type));
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date(now).toISOString(), records: live };
}
export const exportJSON = (records, now) => JSON.stringify(toExport(records, now));

// ---------- import -----------------------------------------------------------------------------
function cleanBrew(r) {
  if (!finite(r.startedAt) || r.startedAt <= 0 || !finite(r.dose) || !finite(r.yield) || r.dose < 0 || r.yield < 0) return null;
  if (typeof r.method !== 'string' || !r.method) return null;
  const out = { ...r };
  const ch = r.samples?.channels;
  if (r.samples !== undefined) {
    const ok = ch && Array.isArray(ch.weight) && ch.weight.length <= MAX_SAMPLES && ch.weight.every(finite)
      && (ch.flow === undefined || (Array.isArray(ch.flow) && ch.flow.length <= MAX_SAMPLES));
    if (!ok) delete out.samples;
  }
  if (!finite(out.timeS)) out.timeS = 0;
  return out;
}

/** One record from a file → a usable record, or null. Unknown types are dropped. */
export function cleanRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.id !== 'string' || !r.id || r.id.length > MAX_ID || typeof r.type !== 'string') return null;
  if (!BACKUP_TYPES.includes(r.type) || !finite(r.updatedAt) || r.updatedAt <= 0) return null;
  if (r.deleted === true) return { id: r.id, type: r.type, updatedAt: r.updatedAt, deleted: true };
  return r.type === 'brew' ? cleanBrew(r) : { ...r };
}

/**
 * Parse a backup file's text into records. Accepts our export, a bare array of records, or the previous app's
 * history export (those brews are attributed to `profileId`). Throws an Error with a user-facing message on garbage.
 */
export function parseImport(text, { profileId } = {}) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file isn’t JSON. Choose a Dot Scale backup (.json).'); }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.records) && (!data.format || data.format === EXPORT_FORMAT)) list = data.records;
  else if (data && data.format === 'dot-scale-history' && Array.isArray(data.history)) {
    if (!profileId) throw new Error('Pick who these brews belong to first.');
    list = legacyToRecords({ history: data.history }, profileId).brews;
  } else throw new Error('That file isn’t a Dot Scale backup.');
  const valid = list.map(cleanRecord).filter(Boolean);
  if (list.length && !valid.length) throw new Error('No usable records in this file.');
  return valid;
}

/**
 * Decide what importing `incoming` does to `existing` (any records, tombstones included).
 * Same rule as sync: per id the newest updatedAt wins, and ties keep what's here. → { apply, added, updated, skipped }
 */
export function planImport(existing, incoming) {
  const have = new Map((existing ?? []).map((r) => [r.id, r]));
  const best = new Map();
  for (const r of incoming ?? []) if (!best.has(r.id) || r.updatedAt > best.get(r.id).updatedAt) best.set(r.id, r);
  const apply = [];
  let added = 0, updated = 0, skipped = 0;
  for (const r of best.values()) {
    const local = have.get(r.id);
    if (!local) { apply.push(r); added++; } else if (r.updatedAt > local.updatedAt) { apply.push(r); updated++; } else skipped++;
  }
  skipped += (incoming?.length ?? 0) - best.size; // duplicates inside the file
  return { apply, added, updated, skipped };
}

// ---------- CSV --------------------------------------------------------------------------------
export const CSV_COLUMNS = ['date', 'profile', 'method', 'bean', 'roaster', 'dose_g', 'yield_g', 'ratio', 'time_s', 'grind', 'temp_c', 'stars', 'balance', 'strength', 'notes'];

/** One CSV cell. Text that starts with = + - @ tab or CR gets a leading apostrophe so spreadsheets don't run it as a formula. */
export function csvCell(v) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCSV({ brews, beans = [], profiles = [] }) {
  const rows = [CSV_COLUMNS.join(',')];
  const sorted = [...(brews ?? [])].filter((b) => b && !b.deleted).sort((a, b) => a.startedAt - b.startedAt);
  for (const b of sorted) {
    const bean = beans.find((x) => x.id === b.beanId);
    const prof = profiles.find((p) => p.id === b.profileId);
    const g = b.grind ? [finite(b.grind.value) ? b.grind.value : '', b.grind.text ?? ''].filter((x) => x !== '').join(' ') : '';
    const ratio = ratioOf(b);
    rows.push([
      finite(b.startedAt) ? new Date(b.startedAt).toISOString() : '', prof?.name ?? '', b.method ?? '', bean?.name ?? '', bean?.roaster ?? '',
      b.dose, b.yield, ratio == null ? '' : Math.round(ratio * 100) / 100, b.timeS, g, b.tempC ?? '',
      stars(b) ?? '', finite(b.taste?.balance) ? b.taste.balance : '', finite(b.taste?.strength) ? b.taste.strength : '', b.notes ?? '',
    ].map(csvCell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
