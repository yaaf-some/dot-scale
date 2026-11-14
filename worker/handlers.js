// Household sync API (PRODUCT.md §7) as plain `(Request, deps) -> Response` functions: no framework, no Node APIs.
// `deps` = { storage, now, pepper, limits }. Tests inject their own; worker/index.js builds it from the Worker env.
//
// Security notes:
//  - The household code is a bearer secret. Only an HMAC of it (keyed with the SYNC_PEPPER secret) is stored; it is never logged.
//  - Rate limits are keyed by household hash (and, for wrong codes / household creation, by a hash of the caller IP).
//  - Errors are JSON { error, message }; `message` says what happened and what to do.

import { WORDS } from './words.js';
import { normalizeCode, isValidCodeFormat } from '../app/sync/code.js'; // shared with the browser client
import { byteLength, compare, stableStringify, validateRecord } from './records.js';

export const LIMITS = Object.freeze({
  maxRequestBytes: 1024 * 1024,   // 1 MB per request (spec)
  maxRecordBytes: 256 * 1024,     // one record; a 30 min brew at 10 Hz is ~200 KB
  maxChangesPerRequest: 15,       // ~3 D1 statements per record + ~6: keeps a request well under the Workers Free budget (50)
  maxRecords: 20000,              // per household (spec)
  pageRecords: 100,               // records per pull page
  pageBytes: 700 * 1024,          // soft cap on a response so it stays well under 1 MB
  syncPerMinute: 120,             // per household
  ipFailuresPer10Min: 10,         // wrong codes per caller IP
  createPerHourPerIp: 5,
});

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

// ---- codes -----------------------------------------------------------------------------------------------

/** Unbiased integer in [0, n) from WebCrypto (rejection sampling). */
export function randomInt(n) {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

export const CODE_WORDS = 4;
export const CODE_DIGITS = 4;
/** Entropy of a generated code: 4 words from 256 (32 bits) + 4 digits (13.3 bits) = 45.3 bits. */
export const CODE_ENTROPY_BITS = CODE_WORDS * Math.log2(WORDS.length) + CODE_DIGITS * Math.log2(10);

/** e.g. "maple-tiger-orbit-river-4271". Older 3-word codes (~37 bits) are still accepted, just no longer generated. */
export function generateCode(rand = randomInt) {
  const words = Array.from({ length: CODE_WORDS }, () => WORDS[rand(WORDS.length)]);
  return `${words.join('-')}-${String(rand(10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')}`;
}

export { normalizeCode, isValidCodeFormat };

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

/** HMAC-SHA256 so a leaked database alone can't be brute-forced offline if SYNC_PEPPER is set (optional). */
export async function hashCode(code, pepper = '') {
  const key = await crypto.subtle.importKey('raw', enc.encode('dot-scale/household/v1' + pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(code)));
}

async function ipKeyPart(request) {
  // Only CF-Connecting-IP: Cloudflare sets it and overwrites client-supplied values. X-Forwarded-For is attacker-controlled,
  // so it is never used. Without the header (local dev) everyone shares one bucket.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(ip))).slice(0, 32);
}

// ---- plumbing --------------------------------------------------------------------------------------------

const resolveDeps = (d) => ({ now: Date.now, pepper: '', ...d, limits: { ...LIMITS, ...(d.limits || {}) } });

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function errorResponse(e) {
  if (e instanceof HttpError) {
    const headers = {};
    if (e.extra.retryAfter) headers['Retry-After'] = String(e.extra.retryAfter);
    if (e.extra.allow) headers.Allow = e.extra.allow;
    return json(e.status, { error: e.code, message: e.message, ...(e.extra.retryAfter ? { retryAfter: e.extra.retryAfter } : {}) }, headers);
  }
  console.error('[sync] failure', e?.name || 'Error'); // class only: messages could carry request or SQL data
  return json(500, { error: 'internal', message: 'Something went wrong on the server. Your data is safe on this device; try again in a minute.' });
}

const notConfigured = () => new HttpError(503, 'sync_not_configured',
  "Sync isn't set up on this server yet. The site owner needs to create the D1 database and apply its migration (see docs/DEPLOY.md). The app keeps working on this device.");

/** The pepper is the HMAC key material for household hashes. Without a secret one the hashes are only as safe as this public code. */
export const MIN_PEPPER_LENGTH = 32;
const pepperMissing = () => new HttpError(503, 'sync_not_configured',
  `Sync isn't set up on this server yet: the secret SYNC_PEPPER is missing or shorter than ${MIN_PEPPER_LENGTH} characters. ` +
  'The site owner sets it once with `npx wrangler secret put SYNC_PEPPER` and a long random value (never in the repo); see docs/DEPLOY.md. The app keeps working on this device.');

/** Throws the 503 for a server that isn't fully set up (database bound and a strong enough pepper). */
function requireConfigured(d) {
  if (!d.storage) throw notConfigured();
  if (typeof d.pepper !== 'string' || d.pepper.length < MIN_PEPPER_LENGTH) throw pepperMissing();
}

const rateLimited = (seconds) => new HttpError(429, 'rate_limited',
  `Too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`, { retryAfter: seconds });

const methodNotAllowed = () => new HttpError(405, 'method_not_allowed', 'Use POST for this endpoint.', { allow: 'POST' });
const secondsToNext = (now, windowMs) => Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));

const tooLarge = (maxBytes) => new HttpError(413, 'too_large',
  `Request is over ${Math.round(maxBytes / 1024)} KB. Send fewer records per request (the app does this for you).`);

/** Cheap early refusal from the declared Content-Length, before any database work or reading. */
function checkDeclaredLength(request, maxBytes) {
  const len = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(len) && len > maxBytes) throw tooLarge(maxBytes);
}

/** Read and parse the JSON body, refusing anything over `maxBytes` without buffering it all. */
async function readJsonBody(request, maxBytes) {
  checkDeclaredLength(request, maxBytes);
  const chunks = []; let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw tooLarge(maxBytes); }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(all)); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object: { since, changes }.');
  }
  return body;
}

// ---- POST /api/household ---------------------------------------------------------------------------------

export async function handleHousehold(request, rawDeps) {
  try {
    if (request.method !== 'POST') throw methodNotAllowed();
    const d = resolveDeps(rawDeps);
    requireConfigured(d);
    const now = d.now();
    const hour = Math.floor(now / 3_600_000);
    const count = await d.storage.hit(`create:${await ipKeyPart(request)}`, hour, (hour + 2) * 3_600_000);
    if (count > d.limits.createPerHourPerIp) throw rateLimited(secondsToNext(now, 3_600_000));
    await d.storage.purgeExpired(now);

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      if (await d.storage.createHousehold(await hashCode(code, d.pepper), now)) return json(201, { code });
    }
    throw new HttpError(500, 'internal', 'Could not create a household. Try again.');
  } catch (e) { return errorResponse(e); }
}

// ---- POST /api/sync --------------------------------------------------------------------------------------

function bearerCode(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  const code = m ? normalizeCode(m[1]) : '';
  return isValidCodeFormat(code) ? code : null;
}

export async function handleSync(request, rawDeps) {
  try {
    if (request.method !== 'POST') throw methodNotAllowed();
    const d = resolveDeps(rawDeps);
    const L = d.limits;
    requireConfigured(d);
    const { storage } = d;

    const code = bearerCode(request);
    if (!code) throw new HttpError(401, 'missing_code', 'Send the household code as "Authorization: Bearer <code>". Create or join a household in Settings → Sync.');
    checkDeclaredLength(request, L.maxRequestBytes);

    const now = d.now();
    const hash = await hashCode(code, d.pepper);
    const ipKey = `fail:${await ipKeyPart(request)}`;
    const tenMin = Math.floor(now / 600_000);

    const { ipFails, rev: rev0 } = await storage.gate(hash, ipKey, tenMin);
    // Too many wrong codes from one caller: refuse everything (even a right code) so guesses get no answers.
    if (ipFails >= L.ipFailuresPer10Min) throw rateLimited(secondsToNext(now, 600_000));
    if (rev0 === null) {
      await storage.hit(ipKey, tenMin, (tenMin + 2) * 600_000);
      throw new HttpError(401, 'unknown_household', "That household code wasn't found. Check the spelling, or create a new household in Settings → Sync.");
    }
    const minute = Math.floor(now / 60_000);
    if ((await storage.hit(`rl:${hash}`, minute, (minute + 2) * 60_000)) > L.syncPerMinute) throw rateLimited(secondsToNext(now, 60_000));

    // Only now (authenticated, within the rate limit) read and parse the body.
    const body = await readJsonBody(request, L.maxRequestBytes);
    const since = body.since ?? 0;
    const changes = body.changes ?? [];
    const limit = body.limit ?? L.pageRecords;
    if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'invalid_since', '"since" must be a whole number >= 0 (the rev from your last sync, or 0).');
    if (!Array.isArray(changes)) throw new HttpError(400, 'invalid_changes', '"changes" must be an array of records.');
    if (changes.length > L.maxChangesPerRequest) {
      throw new HttpError(400, 'too_many_changes', `Send at most ${L.maxChangesPerRequest} records per request; split the push into chunks.`);
    }
    if (!Number.isSafeInteger(limit) || limit < 0) throw new HttpError(400, 'invalid_limit', '"limit" must be a whole number >= 0.');
    const pageLimit = Math.min(limit, L.pageRecords);

    const reset = since > rev0; // server data was lost/replaced: tell the client to re-push everything
    const effSince = reset ? 0 : since;

    // ---- validate + de-duplicate incoming records
    const rejected = [];
    const incoming = new Map();
    changes.forEach((raw, index) => {
      const v = validateRecord(raw, { now, maxBytes: L.maxRecordBytes });
      if (!v.ok) { rejected.push({ index, ...(typeof raw?.id === 'string' ? { id: raw.id.slice(0, 64) } : {}), reason: v.reason }); return; }
      const prev = incoming.get(v.record.id);
      if (!prev || compare(v.record, prev) > 0) incoming.set(v.record.id, v.record);
    });
    let list = [...incoming.values()];

    // ---- household record cap. Only checked when it could matter: every merged record reserves 2 revs, so rev0 / 2 is an
    // upper bound on the record count (and the extra queries below are skipped for any normal household).
    if (list.length && Math.floor(rev0 / 2) + list.length >= L.maxRecords) {
      const have = await storage.recordCount(hash);
      const existing = await storage.existingIds(hash, list.map((r) => r.id));
      let room = L.maxRecords - have;
      list = list.filter((r) => {
        if (existing.has(r.id)) return true;
        if (room > 0) { room--; return true; }
        rejected.push({ id: r.id, reason: `Household is full (${L.maxRecords} records). Delete old brews or export a backup.` });
        return false;
      });
    }

    // ---- merge (atomic in the database)
    let merged = null;
    if (list.length) {
      merged = await storage.merge(hash, list.map((r) => ({ id: r.id, type: r.type, updatedAt: r.updatedAt, deleted: r.deleted === true, body: stableStringify(r) })));
    }
    const n = list.length;
    const base = merged ? merged.rev - 2 * n : 0;
    const caughtUp = merged && effSince === base && merged.restamped.length === 0; // nothing else to pull

    // ---- pull: everything with rev > since (except what this request just wrote), paged and size-capped
    let cursor = effSince, more = false;
    const out = [];
    if (caughtUp) {
      cursor = merged.rev;
    } else if (pageLimit === 0) {
      more = Math.max(rev0, merged?.rev ?? 0) > effSince;
    } else {
      const rows = await storage.changesSince(hash, effSince, pageLimit + 1, merged ? [base, base + n] : [0, 0]);
      more = rows.length > pageLimit;
      if (more) rows.length = pageLimit;
      let bytes = 0;
      for (const row of rows) {
        const len = byteLength(row.body);
        if (out.length && bytes + len > L.pageBytes) { more = true; break; }
        out.push(JSON.parse(row.body)); bytes += len; cursor = row.rev;
      }
      // Exhausted: everything up to the household counter has been seen (reserved-but-unused revs are just gaps).
      if (!more) cursor = Math.max(cursor, rev0, merged?.rev ?? 0);
    }

    return json(200, { rev: cursor, changes: out, more, accepted: merged ? merged.own.length : 0, rejected, reset });
  } catch (e) { return errorResponse(e); }
}
