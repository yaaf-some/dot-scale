// Record envelope validation and last-writer-wins comparison (PRODUCT.md §6, §7).
// Pure functions, no I/O, no Node-only APIs (runs in a Cloudflare Worker).

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // a wrong device clock must not win forever

const encoder = new TextEncoder();
export function byteLength(s) { return encoder.encode(s).length; }

/** JSON with sorted keys, so equal content always compares equal regardless of key order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Last-writer-wins order. Returns >0 if `a` should win over `b`, <0 if `b` wins, 0 if identical.
 * Order: updatedAt, then id (matters when comparing records of different ids), then canonical JSON
 * so two edits of the same record with the same updatedAt still resolve deterministically.
 */
export function compare(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1;
  if (a.id !== b.id) return a.id > b.id ? 1 : -1;
  return compareUtf8(stableStringify(a), stableStringify(b));
}

/** Order strings by their UTF-8 bytes, which is exactly how SQLite compares TEXT (BINARY collation) in worker/storage.js.
 *  Plain `<` on JS strings compares UTF-16 code units and disagrees for characters outside the BMP. */
export function compareUtf8(x, y) {
  if (x === y) return 0;
  const bx = encoder.encode(x), by = encoder.encode(y);
  const n = Math.min(bx.length, by.length);
  for (let i = 0; i < n; i++) if (bx[i] !== by[i]) return bx[i] > by[i] ? 1 : -1;
  return bx.length === by.length ? 0 : bx.length > by.length ? 1 : -1;
}

/** A tombstone only needs its envelope; dropping the rest frees space (brew samples are large). */
export function compactTombstone(r) {
  return r.deleted === true ? { id: r.id, type: r.type, updatedAt: r.updatedAt, deleted: true } : r;
}

/**
 * Validate one record. Returns { ok: true, record } (tombstones compacted) or { ok: false, reason }.
 * `reason` says what to fix; it never echoes record contents.
 */
export function validateRecord(r, { now, maxBytes }) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'Record must be an object.' };
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return { ok: false, reason: 'id must be a string of 8-64 letters, digits, "-" or "_" (a uuid).' };
  if (typeof r.type !== 'string' || !TYPE_RE.test(r.type)) return { ok: false, reason: 'type must be a lowercase word such as "brew".' };
  if (!Number.isSafeInteger(r.updatedAt) || r.updatedAt <= 0) return { ok: false, reason: 'updatedAt must be a positive integer (ms since epoch).' };
  if (r.updatedAt > now + MAX_FUTURE_MS) return { ok: false, reason: 'updatedAt is more than a day in the future; check the device clock.' };
  if (r.deleted !== undefined && r.deleted !== true) return { ok: false, reason: 'deleted must be true or absent.' };
  let size;
  try { size = byteLength(JSON.stringify(r)); } catch { return { ok: false, reason: 'Record is not JSON-serialisable.' }; }
  if (size > maxBytes) return { ok: false, reason: `Record is ${size} bytes; the limit is ${maxBytes}.` };
  return { ok: true, record: compactTombstone(r), bytes: size };
}
