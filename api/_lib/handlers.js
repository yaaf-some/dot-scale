// Household sync API (PRODUCT.md §7). Handlers are built by factories so tests can inject a fake Redis.
// Security notes:
//  - The household code is a bearer secret. Only an HMAC of it is stored/used in keys; it is never logged.
//  - Rate limits are keyed by household hash (and, for failed codes, by a hash of the caller IP).
//  - Errors are JSON { error, message } where `message` says what happened and what to do.

import { createHmac, createHash, randomBytes, randomInt } from 'node:crypto';
import { createRedis, redisConfigFromEnv, RedisError } from './redis.js';
import { WORDS } from './words.js';
import { byteLength, compare, validateRecord } from './records.js';

export const LIMITS = Object.freeze({
  maxRequestBytes: 1024 * 1024,   // 1 MB per request (spec)
  maxRecordBytes: 256 * 1024,     // one record; a 30 min brew at 10 Hz is ~200 KB
  maxChangesPerRequest: 500,
  maxRecords: 20000,              // per household (spec)
  pageRecords: 200,               // records per pull page
  pageBytes: 700 * 1024,          // soft cap on a response so it stays well under 1 MB
  syncPerMinute: 120,             // per household
  ipFailuresPer10Min: 10,         // wrong codes per caller IP
  createPerHourPerIp: 5,
  lockMs: 8000,
  writeBatchBytes: 400 * 1024,    // keep each Redis request small (Upstash caps request size)
});

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

// ---- codes -----------------------------------------------------------------------------------------------

/** e.g. "maple-tiger-orbit-4271": 3 words from 256 (24 bits) + 4 digits (13.3 bits) ≈ 37 bits. */
export function generateCode(rand = randomInt) {
  const w = () => WORDS[rand(WORDS.length)];
  return `${w()}-${w()}-${w()}-${String(rand(10000)).padStart(4, '0')}`;
}

export function normalizeCode(input) {
  return String(input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/;
export const isValidCodeFormat = (c) => typeof c === 'string' && c.length <= 64 && CODE_RE.test(c);

/** HMAC so a leaked database alone can't be brute-forced offline if SYNC_PEPPER is set (optional). */
export function hashCode(code, pepper = '') {
  return createHmac('sha256', 'dot-scale/household/v1' + pepper).update(code).digest('hex');
}

const ipHash = (req) => {
  const h = req.headers || {};
  const raw = String(h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
};

const keys = (h) => ({
  meta: `dot:hh:${h}:meta`, rev: `dot:hh:${h}:rev`, recs: `dot:hh:${h}:recs`, revs: `dot:hh:${h}:revs`, lock: `dot:hh:${h}:lock`,
  rl: (win) => `dot:rl:${h}:${win}`,
});

// ---- plumbing --------------------------------------------------------------------------------------------

/** Dependencies come from env at request time unless injected (tests). */
export function envDeps(env = process.env) {
  const cfg = redisConfigFromEnv(env);
  return { redis: cfg ? createRedis(cfg) : null, now: Date.now, pepper: env.SYNC_PEPPER || '', limits: LIMITS };
}
const resolveDeps = (d) => ({ now: Date.now, pepper: '', ...d, limits: { ...LIMITS, ...(d.limits || {}) } });

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function sendError(res, e) {
  if (e instanceof HttpError) {
    const headers = e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
    if (e.extra.allow) headers.Allow = e.extra.allow;
    return send(res, e.status, { error: e.code, message: e.message, ...(e.extra.retryAfter ? { retryAfter: e.extra.retryAfter } : {}) }, headers);
  }
  // Log only the error class/status, never messages that could carry request data.
  console.error('[sync] failure', e?.name || 'Error', e instanceof RedisError ? e.status : '');
  if (e instanceof RedisError) {
    return send(res, 502, { error: 'storage_unavailable', message: "Sync storage didn't respond. Try again in a minute; your data is safe on this device." });
  }
  return send(res, 500, { error: 'internal', message: 'Something went wrong on the server. Try again in a minute.' });
}

const notConfigured = () => new HttpError(503, 'sync_not_configured',
  "Sync isn't set up on this server yet. The site owner needs to add the Upstash Redis integration in Vercel (see docs/SYNC.md). The app keeps working on this device.");

const rateLimited = (seconds) => new HttpError(429, 'rate_limited',
  `Too many requests. Wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`, { retryAfter: seconds });

async function readJsonBody(req, maxBytes) {
  const tooLarge = () => new HttpError(413, 'too_large',
    `Request is over ${Math.round(maxBytes / 1024)} KB. Send fewer records per request (the app does this for you).`);
  const len = Number(req.headers?.['content-length']);
  if (Number.isFinite(len) && len > maxBytes) throw tooLarge();

  let raw = req.body;
  if (raw === undefined) { // plain Node request: read the stream ourselves, with a cap
    const chunks = []; let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > maxBytes) throw tooLarge();
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (byteLength(raw) > maxBytes) throw tooLarge();
    try { raw = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'); }
  } else if (raw && typeof raw === 'object') {
    if (byteLength(JSON.stringify(raw)) > maxBytes) throw tooLarge();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object: { since, changes }.');
  }
  return raw;
}

const methodNotAllowed = () => new HttpError(405, 'method_not_allowed', 'Use POST for this endpoint.', { allow: 'POST' });
const secondsToNext = (now, windowMs) => Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));

// ---- POST /api/household ---------------------------------------------------------------------------------

export function createHouseholdHandler(getDeps = envDeps) {
  return async function household(req, res) {
    try {
      if (req.method !== 'POST') throw methodNotAllowed();
      const d = resolveDeps(getDeps());
      if (!d.redis) throw notConfigured();
      const now = d.now();
      const win = Math.floor(now / 3_600_000);
      const key = `dot:ip:${ipHash(req)}:create:${win}`;
      const [, count] = await d.redis.pipeline([['SET', key, '0', 'EX', '7200', 'NX'], ['INCR', key]]);
      if (Number(count) > d.limits.createPerHourPerIp) throw rateLimited(secondsToNext(now, 3_600_000));

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const ok = await d.redis.command(['SET', keys(hashCode(code, d.pepper)).meta, JSON.stringify({ createdAt: now }), 'NX']);
        if (ok === 'OK') return send(res, 201, { code });
      }
      throw new HttpError(500, 'internal', 'Could not create a household. Try again.');
    } catch (e) { sendError(res, e); }
  };
}

// ---- POST /api/sync --------------------------------------------------------------------------------------

function bearerCode(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers?.authorization || ''));
  const code = m ? normalizeCode(m[1]) : '';
  return isValidCodeFormat(code) ? code : null;
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Run [HSET, ZADD] groups in several small pipelines, in order. */
async function writeBatches(redis, groups, maxBytes) {
  let batch = [], bytes = 0;
  const flush = async () => { if (batch.length) { await redis.pipeline(batch); batch = []; bytes = 0; } };
  for (const g of groups) {
    const size = byteLength(JSON.stringify(g));
    if (bytes + size > maxBytes) await flush();
    batch.push(...g); bytes += size;
  }
  await flush();
}

export function createSyncHandler(getDeps = envDeps) {
  return async function sync(req, res) {
    try {
      if (req.method !== 'POST') throw methodNotAllowed();
      const d = resolveDeps(getDeps());
      const L = d.limits;
      if (!d.redis) throw notConfigured();
      const { redis } = d;

      const code = bearerCode(req);
      if (!code) {
        throw new HttpError(401, 'missing_code', 'Send the household code as "Authorization: Bearer <code>". Create or join a household in Settings → Sync.');
      }
      const body = await readJsonBody(req, L.maxRequestBytes);

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

      const now = d.now();
      const h = hashCode(code, d.pepper);
      const K = keys(h);
      const rlKey = K.rl(Math.floor(now / 60_000));
      const ipKey = `dot:ip:${ipHash(req)}:fail`;

      // One round trip: rate-limit counters, does the household exist, current rev.
      const [, rlCount, , ipFails, exists, counterRaw] = await redis.pipeline([
        ['SET', rlKey, '0', 'EX', '120', 'NX'], ['INCR', rlKey],
        ['SET', ipKey, '0', 'EX', '600', 'NX'], ['GET', ipKey],
        ['EXISTS', K.meta], ['GET', K.rev],
      ]);
      // Too many wrong codes from one caller: refuse everything (even a right code) so guesses get no answers.
      if (Number(ipFails) >= L.ipFailuresPer10Min) throw rateLimited(600);
      if (!Number(exists)) {
        await redis.command(['INCR', ipKey]);
        throw new HttpError(401, 'unknown_household', "That household code wasn't found. Check the spelling, or create a new household in Settings → Sync.");
      }
      if (Number(rlCount) > L.syncPerMinute) throw rateLimited(secondsToNext(now, 60_000));

      const counter = Number(counterRaw) || 0;
      const reset = since > counter; // server data was lost/replaced: tell the client to re-push everything
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

      // ---- merge under a per-household lock (read-modify-write must not interleave)
      const own = new Set();
      let writtenRev = 0, caughtUp = false; // caughtUp: the caller had everything before this write, so nothing else to pull
      if (incoming.size) {
        const token = randomBytes(12).toString('hex');
        const got = await redis.command(['SET', K.lock, token, 'PX', String(L.lockMs), 'NX']);
        if (got !== 'OK') throw new HttpError(409, 'busy', 'Another device is syncing right now. Try again in a moment.', { retryAfter: 1 });
        try {
          const list = [...incoming.values()];
          const [existingRaw, count, prevRaw] = await redis.pipeline([['HMGET', K.recs, ...list.map((r) => r.id)], ['HLEN', K.recs], ['GET', K.rev]]);
          let size = Number(count);
          const winners = [], restamp = []; // restamp: server copy beat the pushed one; re-stamp its rev so every device re-pulls it
          list.forEach((r, i) => {
            const ex = existingRaw[i] ? parseJson(existingRaw[i]) : null;
            if (!ex || typeof ex !== 'object') {
              if (size >= L.maxRecords) { rejected.push({ id: r.id, reason: `Household is full (${L.maxRecords} records). Delete old brews or export a backup.` }); return; }
              size++; winners.push(r); return;
            }
            const c = compare(r, ex);
            if (c > 0) winners.push(r);
            else if (c < 0) restamp.push(r.id);
          });
          const n = winners.length + restamp.length;
          if (n) {
            const last = Number(await redis.command(['INCRBY', K.rev, String(n)]));
            let rev = last - n + 1;
            const groups = [];
            for (const r of winners) { groups.push([['HSET', K.recs, r.id, JSON.stringify(r)], ['ZADD', K.revs, String(rev++), r.id]]); own.add(r.id); }
            for (const id of restamp) groups.push([['ZADD', K.revs, String(rev++), id]]);
            await writeBatches(redis, groups, L.writeBatchBytes);
            writtenRev = last;
            caughtUp = restamp.length === 0 && effSince === (Number(prevRaw) || 0);
          }
        } finally {
          try { if ((await redis.command(['GET', K.lock])) === token) await redis.command(['DEL', K.lock]); } catch { /* lock expires by itself */ }
        }
      }

      // ---- pull: everything with rev > since, paged and size-capped
      let cursor = effSince, more = false;
      const out = [];
      if (caughtUp) {
        cursor = writtenRev; // everything after `since` is what this request just wrote
      } else if (pageLimit === 0) {
        more = counter > effSince || writtenRev > effSince;
      } else {
        const flat = await redis.command(['ZRANGEBYSCORE', K.revs, `(${effSince}`, '+inf', 'WITHSCORES', 'LIMIT', '0', String(pageLimit + 1)]);
        const pairs = [];
        for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], Number(flat[i + 1])]);
        more = pairs.length > pageLimit;
        if (more) pairs.length = pageLimit;
        let bytes = 0, stopped = false;
        for (let i = 0; i < pairs.length && !stopped; i += 20) {
          const slice = pairs.slice(i, i + 20);
          const raws = await redis.command(['HMGET', K.recs, ...slice.map((p) => p[0])]);
          for (let j = 0; j < slice.length; j++) {
            const [id, rev] = slice[j];
            if (!own.has(id) && raws[j]) {
              const len = byteLength(raws[j]);
              if (out.length && bytes + len > L.pageBytes) { stopped = true; more = true; break; }
              const rec = parseJson(raws[j]);
              if (rec) { out.push(rec); bytes += len; }
            }
            cursor = rev;
          }
        }
        if (!more) cursor = Math.max(cursor, writtenRev);
      }

      return send(res, 200, { rev: cursor, changes: out, more, accepted: own.size, rejected, reset });
    } catch (e) { sendError(res, e); }
  };
}
