// Household sync client (PRODUCT.md §7). Pure ES module: no DOM needed at import time; everything the
// environment provides (fetch, timers, storage, window/document events, the record store) is injectable.
//
// What this needs from the store (see docs/SYNC.md "Store contract"):
//   store.changesSince(cursor) -> Promise<{ cursor: number, records: Record[] }>
//       records changed *locally* (incl. tombstones) after `cursor` (0 = everything); `cursor` is opaque and
//       monotonic, passed back next time. Changes written by applyRemote() must NOT appear here (no echo).
//   store.applyRemote(records) -> Promise<void>
//       merge server records using last-writer-wins on updatedAt (ties: id); idempotent.
//   store.onChange(cb) -> unsubscribe   (optional; fire on local writes. Otherwise call client.notifyChange())

import { normalizeCode, isValidCodeFormat } from './code.js';

export const MAX_RECORD_BYTES = 256 * 1024; // mirrors worker/handlers.js LIMITS.maxRecordBytes

export class SyncError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'SyncError'; this.code = code; Object.assign(this, extra); }
}

export const utf8Length = (s) => new TextEncoder().encode(s).length;

export { normalizeCode, isValidCodeFormat };

/**
 * Split records into request-sized chunks so a push never nears the server's 1 MB limit
 * (brew records carry sample arrays). Records over `maxRecordBytes` can't be synced: returned in `oversize`.
 */
export function chunkRecords(records, { maxBytes = 256 * 1024, maxRecords = 15, maxRecordBytes = MAX_RECORD_BYTES } = {}) {
  const chunks = [], oversize = [];
  let cur = [], bytes = 0;
  for (const r of records) {
    const size = utf8Length(JSON.stringify(r));
    if (size > maxRecordBytes) { oversize.push(r); continue; }
    if (cur.length && (bytes + size > maxBytes || cur.length >= maxRecords)) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return { chunks, oversize };
}

/** "Synced 2 min ago" etc. Pure: call it again later with a new `now` to refresh the text. */
export function formatStatus(s, now = Date.now()) {
  const ago = () => {
    const sec = Math.max(0, Math.round((now - s.lastSyncedAt) / 1000));
    if (sec < 45) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  switch (s.state) {
    case 'off': return 'Sync off';
    case 'unavailable': return 'Sync not set up';
    case 'idle': return 'Not synced yet';
    case 'syncing': return 'Syncing…';
    case 'offline': return s.lastSyncedAt ? `Offline · last synced ${ago()}` : 'Offline';
    case 'error': return s.error?.fatal ? 'Sync stopped' : 'Sync problem';
    case 'synced': return `Synced ${ago()}`;
    default: return '';
  }
}

const STORAGE_KEY = 'dot.sync';
const blankState = () => ({ code: null, since: 0, pushCursor: 0, lastSyncedAt: null, rejected: {} });

function defaultStorage() {
  const mem = new Map();
  try {
    const ls = globalThis.localStorage;
    if (ls) { ls.setItem('dot.sync.probe', '1'); ls.removeItem('dot.sync.probe'); return ls; }
  } catch { /* private mode / blocked: fall through */ }
  return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
}

export function createSyncClient({
  store,
  endpoint = '/api',
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  storage = defaultStorage(),
  now = Date.now,
  timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t) },
  win = globalThis.window ?? null,
  doc = globalThis.document ?? null,
  nav = globalThis.navigator ?? null,
  random = Math.random,
  debounceMs = 1500,
  maxWaitMs = 15000, // under constant edits, still sync at least this often
  chunkBytes = 256 * 1024,
  chunkSize = 15, // the server accepts at most 15 records per request (LIMITS.maxChangesPerRequest)
  backoffBaseMs = 2000,
  backoffMaxMs = 5 * 60 * 1000,
  unavailableRetryMs = 10 * 60 * 1000,
  pollMs = 0, // optional background poll (off by default: each poll costs a few D1 queries)
} = {}) {
  if (!store || typeof store.changesSince !== 'function' || typeof store.applyRemote !== 'function') {
    throw new TypeError('createSyncClient needs a store with changesSince() and applyRemote()');
  }

  // ---- persisted state (household code + cursors) --------------------------------------------------------
  let persisted = load();
  function load() {
    try {
      const p = JSON.parse(storage.getItem(STORAGE_KEY));
      if (p && typeof p === 'object' && (p.code === null || isValidCodeFormat(p.code))) return { ...blankState(), ...p, rejected: p.rejected && typeof p.rejected === 'object' ? p.rejected : {} };
    } catch { /* corrupt or unavailable */ }
    return blankState();
  }
  function save() { try { storage.setItem(STORAGE_KEY, JSON.stringify(persisted)); } catch { /* keep working in memory */ } }

  // ---- status ----------------------------------------------------------------------------------------------
  const listeners = new Set();
  let status = { state: persisted.code ? 'idle' : 'off', lastSyncedAt: persisted.lastSyncedAt, retryAt: null, error: null, skipped: Object.keys(persisted.rejected).length };
  const isOnline = () => nav?.onLine !== false;
  function setStatus(patch) {
    status = { ...status, ...patch };
    const snap = getStatus();
    for (const cb of [...listeners]) { try { cb(snap); } catch { /* a bad listener must not break sync */ } }
  }
  const getStatus = () => ({ ...status, label: formatStatus(status, now()) });
  function onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  // ---- scheduling ------------------------------------------------------------------------------------------
  let timer = null, timerDue = 0, blockedUntil = 0, attempts = 0, fatal = false;
  let running = null, dirty = false, started = false, applying = false, gen = 0;
  const cleanups = [];

  // `kind` of the pending timer: 'debounce' (a burst of local edits, may be pushed back) or 'run' (retry/immediate).
  let timerKind = null, burstStart = 0;
  function schedule(ms, { force = false, manual = false } = {}) {
    if (!started || !persisted.code) return;
    if (fatal && !manual) return;
    const delay = force ? ms : Math.max(ms, blockedUntil - now());
    const due = now() + delay;
    if (timer && timerDue <= due) return;
    arm(delay, 'run');
  }
  function arm(delay, kind) {
    if (timer) timers.clearTimeout(timer);
    timerDue = now() + delay; timerKind = kind;
    timer = timers.setTimeout(() => { timer = null; timerKind = null; burstStart = 0; run(); }, delay);
  }
  /** Trailing debounce for local edits: wait for `debounceMs` of quiet, but never longer than `maxWaitMs` overall. */
  function scheduleDebounced() {
    if (!started || !persisted.code || (fatal)) return;
    const t = now();
    if (!burstStart) burstStart = t;
    const wanted = Math.min(debounceMs, Math.max(0, burstStart + maxWaitMs - t));
    const delay = Math.max(wanted, blockedUntil - t);
    if (timer && timerKind === 'run') return; // a retry or immediate run is already pending; edits ride along with it
    arm(delay, 'debounce');
  }
  function clearTimer() { if (timer) timers.clearTimeout(timer); timer = null; timerKind = null; burstStart = 0; }

  function run() {
    if (running) { dirty = true; return running; }
    running = doSync().finally(() => { running = null; if (dirty) { dirty = false; schedule(0); } });
    return running;
  }

  // ---- network ---------------------------------------------------------------------------------------------
  async function request(path, body, code) {
    let res;
    try {
      res = await fetchImpl(endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(code ? { Authorization: `Bearer ${code}` } : {}) },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
      });
    } catch {
      throw new SyncError('offline', "Can't reach the sync server. Your data is safe on this device and will sync when you're back online.");
    }
    let data = null;
    if ((res.headers?.get?.('content-type') || '').includes('json')) { try { data = await res.json(); } catch { data = null; } }
    const msg = (fallback) => (data && typeof data.message === 'string' ? data.message : fallback);
    if (res.ok) {
      if (!data) throw new SyncError('no_endpoint', "Sync isn't available here (no sync service answered). The app keeps working on this device.");
      return data;
    }
    if (res.status === 404 || res.status === 405 || !data) {
      throw new SyncError('no_endpoint', "Sync isn't available here (no sync service answered). The app keeps working on this device.");
    }
    if (res.status === 503 && data.error === 'sync_not_configured') throw new SyncError('not_configured', msg("Sync isn't set up on this server yet."));
    if (res.status === 401) throw new SyncError('unauthorized', msg("That household code wasn't found."), { fatal: true });
    if (res.status === 429) {
      const ra = Number(data.retryAfter ?? res.headers.get('retry-after')) || 30;
      throw new SyncError('rate_limited', msg('Too many requests. Wait a moment.'), { retryAfter: ra });
    }
    if (res.status === 409) throw new SyncError('busy', msg('Another device is syncing right now.'), { retryAfter: Number(data.retryAfter) || 1 });
    throw new SyncError('server', msg(`Sync server error (${res.status}).`));
  }

  // ---- one sync cycle: push local changes in chunks, then pull until caught up ----------------------------
  function rememberRejected(sent, rejected) {
    for (const x of rejected || []) {
      const r = Number.isInteger(x.index) ? sent[x.index] : sent.find((s) => s.id === x.id);
      if (r) persisted.rejected[r.id] = r.updatedAt;
    }
    const ids = Object.keys(persisted.rejected);
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete persisted.rejected[id];
  }

  async function exchange(changes, g) {
    const res = await request('/sync', { since: persisted.since, changes }, persisted.code);
    if (g !== gen) throw new SyncError('aborted', 'Household changed during sync.'); // user joined/left meanwhile
    if (!Array.isArray(res.changes) || !Number.isSafeInteger(res.rev)) throw new SyncError('server', 'Unexpected response from the sync server; will retry.');
    if (res.changes.length) {
      applying = true; // ignore store-change events caused by our own merge
      try { await store.applyRemote(res.changes); } finally { applying = false; }
      if (g !== gen) throw new SyncError('aborted', 'Household changed during sync.'); // switched while merging: don't touch the new state
    }
    rememberRejected(changes, res.rejected);
    persisted.since = res.rev;
    save();
    return res;
  }

  async function syncCycle() {
    const g = gen;
    let restarted = false;
    for (;;) {
      const local = await store.changesSince(persisted.pushCursor);
      if (!local || !Array.isArray(local.records) || !Number.isFinite(local.cursor)) {
        throw new SyncError('store', 'The local store returned an unexpected result; sync was skipped.');
      }
      const fresh = local.records.filter((r) => persisted.rejected[r.id] !== r.updatedAt);
      const { chunks, oversize } = chunkRecords(fresh, { maxBytes: chunkBytes, maxRecords: chunkSize });
      for (const r of oversize) persisted.rejected[r.id] = r.updatedAt; // too big to ever sync: don't retry

      let res, sawReset = false;
      for (const chunk of chunks.length ? chunks : [[]]) {
        res = await exchange(chunk, g);
        sawReset ||= res.reset === true;
      }
      for (let pages = 0; res.more; pages++) {
        const before = persisted.since;
        res = await exchange([], g);
        sawReset ||= res.reset === true;
        if (res.more && (res.rev <= before || pages > 5000)) throw new SyncError('server', 'Sync server is not making progress; will retry.');
      }
      if (sawReset && !restarted) { // server lost its data: send everything we have again
        restarted = true; persisted.pushCursor = 0; save(); continue;
      }
      if (g !== gen) throw new SyncError('aborted', 'Household changed during sync.');
      persisted.pushCursor = local.cursor;
      save();
      return;
    }
  }

  async function doSync() {
    if (!persisted.code) { setStatus({ state: 'off' }); return { ok: false, reason: 'off' }; }
    if (!isOnline()) { setStatus({ state: 'offline' }); return { ok: false, reason: 'offline' }; }
    setStatus({ state: 'syncing', error: null, retryAt: null });
    try {
      await syncCycle();
      attempts = 0; blockedUntil = 0; fatal = false;
      persisted.lastSyncedAt = now(); save();
      setStatus({ state: 'synced', lastSyncedAt: persisted.lastSyncedAt, error: null, retryAt: null, skipped: Object.keys(persisted.rejected).length });
      if (pollMs) schedule(pollMs);
      return { ok: true };
    } catch (e) {
      return fail(e instanceof SyncError ? e : new SyncError('unexpected', 'Sync failed unexpectedly; will retry.'));
    }
  }

  function backoff() {
    const base = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempts++);
    return Math.round(base * (0.5 + random() * 0.5)); // jitter so devices don't retry in lockstep
  }

  function fail(err) {
    if (err.code === 'aborted') return { ok: false, reason: 'aborted' };
    const error = { code: err.code, message: err.message, fatal: !!err.fatal };
    if (err.code === 'unauthorized') { // the code is wrong or the household is gone: needs the user, don't retry
      fatal = true;
      setStatus({ state: 'error', error, retryAt: null });
      return { ok: false, reason: err.code, error };
    }
    let delay, patch;
    switch (err.code) {
      case 'no_endpoint': case 'not_configured': // endpoint may appear after a deploy; check back rarely
        delay = unavailableRetryMs; patch = { state: 'unavailable', error }; break;
      case 'offline':
        delay = backoff(); patch = { state: 'offline', error: null }; break;
      case 'busy': // another device is mid-sync: a transient, not a problem worth showing
        delay = Math.max(err.retryAfter * 1000, 0) + Math.round(random() * 500);
        patch = { state: status.lastSyncedAt ? 'synced' : 'idle', error: null }; break;
      case 'rate_limited':
        delay = Math.max(err.retryAfter * 1000, backoff()); patch = { state: 'error', error }; break;
      default:
        delay = backoff(); patch = { state: 'error', error };
    }
    blockedUntil = now() + delay;
    setStatus({ ...patch, retryAt: blockedUntil });
    clearTimer(); // a debounce armed earlier must not fire before the backoff / Retry-After is over
    schedule(delay, { force: true });
    return { ok: false, reason: err.code, error };
  }

  // ---- public flows ----------------------------------------------------------------------------------------
  function adopt(code) {
    gen++;
    clearTimer();
    persisted = { ...blankState(), code };
    save();
    attempts = 0; blockedUntil = 0; fatal = false;
    setStatus({ state: 'idle', lastSyncedAt: null, error: null, retryAt: null, skipped: 0 });
  }

  function syncNow() {
    if (!persisted.code) return Promise.resolve({ ok: false, reason: 'off' });
    fatal = false; blockedUntil = 0; attempts = 0; clearTimer();
    return run();
  }

  /** Create a household on the server and start syncing it. Throws SyncError if that isn't possible. */
  async function createHousehold() {
    const data = await request('/household', {});
    if (!data || !isValidCodeFormat(data.code)) throw new SyncError('server', 'The server sent back an unexpected response. Try again.');
    adopt(data.code);
    const result = await syncNow();
    return { code: data.code, sync: result };
  }

  /** Join an existing household by code. Verifies the code first; throws SyncError (with advice) if not valid. */
  async function joinHousehold(input) {
    const code = normalizeCode(input);
    if (!isValidCodeFormat(code)) {
      throw new SyncError('invalid_code', 'Household codes look like maple-tiger-orbit-river-4271: four words and four digits (older codes have three words). Check what you typed.');
    }
    await request('/sync', { since: 0, changes: [], limit: 0 }, code); // throws SyncError if unknown/offline/not set up
    adopt(code);
    const result = await syncNow();
    return { code, sync: result };
  }

  /** Stop syncing this household on this device. Local data stays. */
  function leaveHousehold() {
    gen++;
    clearTimer();
    persisted = blankState();
    try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    attempts = 0; blockedUntil = 0; fatal = false;
    setStatus({ state: 'off', lastSyncedAt: null, error: null, retryAt: null, skipped: 0 });
  }

  /**
   * Is a sync service there and configured? Sends no code, so the server answers before touching the database.
   * Sets the "Sync not set up" status when it isn't; never throws. Resolves to true if sync can be used.
   */
  async function probe() {
    try {
      await request('/sync', {});
      return true;
    } catch (e) {
      if (e.code === 'no_endpoint' || e.code === 'not_configured') {
        if (!persisted.code) setStatus({ state: 'unavailable', error: { code: e.code, message: e.message, fatal: false } });
        return false;
      }
      const available = e.code === 'unauthorized'; // 401 "missing code" proves the service is there
      if (available && !persisted.code && status.state === 'unavailable') setStatus({ state: 'off', error: null });
      return available;
    }
  }

  function notifyChange() { if (!applying) scheduleDebounced(); }

  function start() {
    if (started) return api;
    started = true;
    const on = (target, type, fn) => { if (target?.addEventListener) { target.addEventListener(type, fn); cleanups.push(() => target.removeEventListener(type, fn)); } };
    on(win, 'online', () => { attempts = 0; blockedUntil = 0; schedule(0, { force: true }); });
    on(win, 'offline', () => { if (persisted.code) setStatus({ state: 'offline' }); });
    on(doc, 'visibilitychange', () => { if (doc.visibilityState !== 'hidden') schedule(0); });
    if (typeof store.onChange === 'function') {
      const off = store.onChange(notifyChange);
      if (typeof off === 'function') cleanups.push(off);
    }
    if (persisted.code) schedule(0, { force: true });
    else setStatus({ state: 'off' }); // no request until the user opens Settings → Sync (which calls probe())
    return api;
  }

  function stop() {
    started = false;
    clearTimer();
    while (cleanups.length) cleanups.pop()();
  }

  const api = {
    start, stop, syncNow, probe, notifyChange, createHousehold, joinHousehold, leaveHousehold,
    getStatus, onStatus,
    getHouseholdCode: () => persisted.code,
    hasHousehold: () => !!persisted.code,
    /** Resolves when no sync is in flight (handy for tests and "sync, then close" flows). */
    whenIdle: () => (running ?? Promise.resolve()).then(() => undefined),
  };
  return api;
}
