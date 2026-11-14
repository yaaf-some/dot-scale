// Sync client against a fake fetch backed by the real worker handlers and storage on in-memory SQLite, a fake store and fake timers. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, routeFetch } from './helpers/world.mjs';
import { handleHousehold, handleSync } from '../worker/handlers.js';
import { createD1Storage } from '../worker/storage.js';
import { compare } from '../worker/records.js';
import { createStore } from '../app/core/store.js';
import { memoryAdapter } from '../app/core/store-adapters.js';
import { syncStoreAdapter } from '../app/sync/store-adapter.js';
import { createSyncClient, chunkRecords, formatStatus, SyncError, normalizeCode } from '../app/sync/client.js';

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
/** Wait for a condition instead of guessing a tick count (WebCrypto runs on a real thread pool, so timing varies under load). */
async function until(cond, what = 'condition', ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 1)); }
}
/** Wait until the client is idle. WebCrypto runs on a real thread pool, so fixed tick counts are not enough. */
async function quiesce(idle) { for (let i = 0; i < 4; i++) { await tick(); await idle?.(); } }
const rec = (id, updatedAt, extra = {}) => ({ id, type: 'brew', updatedAt, ...extra });

function makeStore() {
  const recs = new Map(), local = new Map(), subs = new Set(), applied = [];
  let seq = 0;
  return {
    recs, applied,
    put(r) { recs.set(r.id, r); local.set(r.id, ++seq); subs.forEach((f) => f()); }, // a local (user) write
    async changesSince(c) { return { cursor: seq, records: [...recs.values()].filter((r) => local.get(r.id) > c) }; },
    async applyRemote(list) { // LWW; remote writes are not local changes and don't notify
      applied.push(list);
      for (const r of list) { const cur = recs.get(r.id); if (!cur || compare(r, cur) > 0) recs.set(r.id, r); }
    },
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}

function makeTimers(clock, idle) {
  let id = 0; const q = new Map();
  return {
    setTimeout(f, ms) { q.set(++id, { f, due: clock.t + ms }); return id; },
    clearTimeout(i) { q.delete(i); },
    pending: () => [...q.values()].map((x) => x.due - clock.t).sort((a, b) => a - b),
    async advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, x]) => x.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        q.delete(next[0]); clock.t = Math.max(clock.t, next[1].due); next[1].f(); await quiesce(idle);
      }
      clock.t = target;
    },
  };
}

function makeEnv(online = true) {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }), nav = { onLine: online };
  return {
    win, doc, nav,
    setOnline(v) { nav.onLine = v; win.dispatchEvent(new Event(v ? 'online' : 'offline')); },
    setVisible(v) { doc.visibilityState = v ? 'visible' : 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

const memStorage = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

/** A server (real handlers + real D1 adapter on in-memory SQLite) plus devices that reach it through a flaky "network". */
function world({ limits } = {}) {
  const server = makeServer({ limits });
  const clock = server.clock;
  const net = { down: false, requests: [] };
  const routed = routeFetch(server, { onRequest: (path, init) => net.requests.push({ path, bytes: new TextEncoder().encode(init.body || '').length, body: init.body }) });
  const fetch = async (url, init) => { if (net.down) throw new TypeError('Failed to fetch'); return routed(url, init); };
  const d1 = server.d1;
  const db = {
    outage(on) { d1.failNext = on; },
    deleteHouseholds() { d1.raw.exec('DELETE FROM households'); },
    loseRecords() { d1.raw.exec('DELETE FROM records; UPDATE households SET rev = 0'); },
  };
  function device(opts = {}) {
    const store = opts.store ?? makeStore(), env = opts.env ?? makeEnv(), timers = makeTimers(clock, () => client.whenIdle()), storage = opts.storage ?? memStorage();
    const client = createSyncClient({ store, fetch: opts.fetch ?? fetch, storage, now: () => clock.t, timers, win: env.win, doc: env.doc, nav: env.nav, random: () => 1, ...opts.client });
    return { store, env, timers, storage, client };
  }
  return { clock, d1, db, net, device, fetch };
}

test('formatStatus: the labels the UI shows', () => {
  const t = 1_000_000_000;
  assert.equal(formatStatus({ state: 'off' }, t), 'Sync off');
  assert.equal(formatStatus({ state: 'unavailable' }, t), 'Sync not set up');
  assert.equal(formatStatus({ state: 'syncing' }, t), 'Syncing…');
  assert.equal(formatStatus({ state: 'synced', lastSyncedAt: t - 10_000 }, t), 'Synced just now');
  assert.equal(formatStatus({ state: 'synced', lastSyncedAt: t - 120_000 }, t), 'Synced 2 min ago');
  assert.equal(formatStatus({ state: 'synced', lastSyncedAt: t - 3 * 3_600_000 }, t), 'Synced 3 h ago');
  assert.equal(formatStatus({ state: 'offline' }, t), 'Offline');
  assert.equal(formatStatus({ state: 'offline', lastSyncedAt: t - 300_000 }, t), 'Offline · last synced 5 min ago');
  assert.equal(formatStatus({ state: 'error', error: {} }, t), 'Sync problem');
  assert.equal(normalizeCode('  Maple Tiger_ORBIT-42 '), 'maple-tiger-orbit-42');
});

test('chunkRecords: respects byte and count caps; flags records too big to ever sync', () => {
  const big = (id, n) => rec(id, 1, { samples: { weight: new Array(n).fill(12.34567) } });
  const recs = Array.from({ length: 30 }, (_, i) => big(`brew-${String(i).padStart(4, '0')}`, 4000)); // ~28 KB each
  const { chunks, oversize } = chunkRecords([...recs, big('brew-huge1', 60000)], { maxBytes: 100_000, maxRecords: 100 });
  assert.equal(oversize.length, 1);
  assert.equal(oversize[0].id, 'brew-huge1');
  assert.equal(chunks.flat().length, 30);
  for (const c of chunks) assert.ok(Buffer.byteLength(JSON.stringify(c)) < 100_000 + 200);
  assert.ok(chunks.length >= 8);
  const few = chunkRecords(Array.from({ length: 25 }, (_, i) => rec(`brew-${String(i).padStart(4, '0')}`, 1)), { maxRecords: 10 });
  assert.deepEqual(few.chunks.map((c) => c.length), [10, 10, 5]);
  assert.deepEqual(chunkRecords([]).chunks, []);
});

test('constructor demands the store interface', () => {
  assert.throws(() => createSyncClient({}), /changesSince/);
});

test('no sync service at all (static host / local dev): app keeps working, status says "Sync not set up"', async () => {
  const w = world();
  const calls = [];
  const noApi = async (url) => { calls.push(url); return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }); };
  const d = w.device({ fetch: noApi });
  d.client.start();
  await d.client.probe(); // what Settings → Sync does when opened
  assert.equal(d.client.getStatus().state, 'unavailable');
  assert.equal(d.client.getStatus().label, 'Sync not set up');
  await assert.rejects(d.client.createHousehold(), (e) => e instanceof SyncError && e.code === 'no_endpoint');
  assert.equal(d.client.hasHousehold(), false);
  d.store.put(rec('brew-0001', 1)); // local writes must not blow up
  await w.clock && d.timers.advance(5000);
  assert.ok(d.store.recs.has('brew-0001'));
});

test('D1 not bound (503): "Sync not set up", create fails with advice, nothing stored', async () => {
  const unconfigured = { storage: null };
  const fetch = async (url, init) => {
    const path = new URL(url, 'https://app.example.test').pathname;
    const req = new Request(new URL(url, 'https://app.example.test'), init);
    return path === '/api/household' ? handleHousehold(req, unconfigured) : handleSync(req, unconfigured);
  };
  const w = world();
  const d = w.device({ fetch });
  d.client.start(); await d.client.probe(); // what Settings → Sync does when opened
  assert.equal(d.client.getStatus().label, 'Sync not set up');
  await assert.rejects(d.client.createHousehold(), (e) => e.code === 'not_configured' && /D1/.test(e.message));
  assert.equal(d.storage.m.size, 0, 'nothing persisted');
});

test('SYNC_PEPPER missing (503): "Sync not set up" with the owner advice, create fails, nothing stored', async () => {
  const w = world();
  const noPepper = { storage: createD1Storage(w.d1), pepper: '' };
  const fetch = async (url, init) => {
    const u = new URL(url, 'https://app.example.test');
    const req = new Request(u, init);
    return u.pathname === '/api/household' ? handleHousehold(req, noPepper) : handleSync(req, noPepper);
  };
  const d = w.device({ fetch });
  d.client.start(); await d.client.probe(); // what Settings → Sync does when opened
  assert.equal(d.client.getStatus().label, 'Sync not set up');
  assert.match(d.client.getStatus().error.message, /SYNC_PEPPER/);
  await assert.rejects(d.client.createHousehold(), (e) => e.code === 'not_configured' && /wrangler secret put SYNC_PEPPER/.test(e.message));
  assert.equal(d.storage.m.size, 0, 'nothing persisted');
  assert.equal(w.d1.sql('SELECT COUNT(*) n FROM households')[0].n, 0);
});

test('start() without a household makes no network request at all', async () => {
  const w = world();
  const d = w.device();
  d.client.start();
  await d.timers.advance(5000);
  d.env.setVisible(true); d.env.setOnline(true);
  await d.timers.advance(5000);
  assert.equal(w.net.requests.length, 0);
  assert.equal(d.client.getStatus().state, 'off');
});

test('probe: a configured server answers "available" without creating anything or touching the database', async () => {
  const w = world();
  const d = w.device();
  assert.equal(await d.client.probe(), true);
  assert.equal(w.d1.queries, 0, 'the probe never touches the database');
  assert.equal(w.d1.sql('SELECT COUNT(*) n FROM households')[0].n, 0);
  d.client.start(); await d.client.probe(); // what Settings → Sync does when opened
  assert.equal(d.client.getStatus().state, 'off');
});

test('a saved household whose endpoint disappears backs off to a slow retry instead of hammering', async () => {
  const w = world();
  const a = w.device();
  a.client.start();
  const { code } = await a.client.createHousehold();
  a.client.stop();
  const calls = [];
  const down = async (url) => { calls.push(url); return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }); };
  const b = w.device({ fetch: down, storage: a.storage });
  b.client.start(); await b.timers.advance(0);
  assert.equal(b.client.getStatus().state, 'unavailable');
  await b.timers.advance(9 * 60_000);
  assert.equal(calls.length, 1, 'no retries for 9 minutes');
  b.env.setVisible(true); await b.timers.advance(0);
  assert.equal(calls.length, 1, 'visibility changes respect the slow retry');
  await b.timers.advance(2 * 60_000);
  assert.equal(calls.length, 2);
  assert.equal(code, b.client.getHouseholdCode());
});

test('create → join → edits flow both ways; two devices converge (incl. LWW conflict and delete)', async () => {
  const w = world();
  const A = w.device(), B = w.device();
  A.store.put(rec('brew-0001', 100, { v: 'a1' })); A.store.put(rec('brew-0002', 100, { v: 'a2' }));
  A.client.start(); B.client.start();
  const { code, sync } = await A.client.createHousehold();
  assert.match(code, /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  assert.equal(sync.ok, true);
  assert.equal(A.client.getStatus().state, 'synced');

  B.store.put(rec('brew-0003', 150, { v: 'b3' })); // existing local data on the joining device
  await B.client.joinHousehold(code.toUpperCase());
  assert.deepEqual([...B.store.recs.keys()].sort(), ['brew-0001', 'brew-0002', 'brew-0003']);
  assert.equal(B.client.getStatus().label, 'Synced just now');

  // A sees B's record when it comes back to the foreground
  A.env.setVisible(true); await A.timers.advance(0);
  assert.ok(A.store.recs.has('brew-0003'));

  // Conflict: both edit brew-0001 offline-ish; B's edit is newer
  w.clock.t += 1000;
  A.store.put(rec('brew-0001', w.clock.t, { v: 'a-edit' }));
  B.store.put(rec('brew-0001', w.clock.t + 500, { v: 'b-edit' }));
  B.store.put({ id: 'brew-0002', type: 'brew', updatedAt: w.clock.t + 600, deleted: true });
  await A.timers.advance(2000); await B.timers.advance(2000); // both push; B's newer edit wins on the server
  await A.client.syncNow(); // A learns the outcome at its next sync (e.g. when it is foregrounded)
  for (const d of [A, B]) {
    assert.equal(d.store.recs.get('brew-0001').v, 'b-edit');
    assert.equal(d.store.recs.get('brew-0002').deleted, true);
  }
  assert.deepEqual([...A.store.recs.values()].map((r) => r.id).sort(), [...B.store.recs.values()].map((r) => r.id).sort());
});

test('join: bad format never hits the network; unknown code is refused and not saved', async () => {
  const w = world();
  const d = w.device();
  await assert.rejects(d.client.joinHousehold('hello'), (e) => e.code === 'invalid_code' && /maple-tiger-orbit-river-4271/.test(e.message) && /four words/.test(e.message));
  assert.equal(w.net.requests.length, 0);
  await assert.rejects(d.client.joinHousehold('maple-tiger-orbit-0000'), (e) => e.code === 'unauthorized' && /Settings/.test(e.message));
  assert.equal(d.client.hasHousehold(), false);
  assert.equal(d.storage.m.size, 0);
  w.net.down = true;
  await assert.rejects(d.client.joinHousehold('maple-tiger-orbit-0000'), (e) => e.code === 'offline');
});

test('offline: local work continues, status shows Offline, retries back off exponentially, recovers and resets', async () => {
  const w = world();
  const d = w.device();
  d.client.start();
  await d.client.createHousehold();
  w.net.down = true;
  d.store.put(rec('brew-0001', 1));
  await d.timers.advance(1500); // debounce fires, fetch throws
  assert.equal(d.client.getStatus().state, 'offline');
  assert.match(d.client.getStatus().label, /^Offline/);
  const reqs = () => w.net.requests.length;
  const before = reqs();
  // random()=1 → delays are exactly 2s, 4s, 8s, 16s...
  assert.deepEqual(d.timers.pending(), [2000]);
  await d.timers.advance(2000); assert.deepEqual(d.timers.pending(), [4000]);
  await d.timers.advance(4000); assert.deepEqual(d.timers.pending(), [8000]);
  await d.timers.advance(8000); assert.deepEqual(d.timers.pending(), [16000]);
  assert.equal(reqs(), before, 'nothing reached the server');
  // more edits while backing off must not hammer: they ride the existing retry timer
  d.store.put(rec('brew-0002', 2)); await d.timers.advance(1500);
  assert.deepEqual(d.timers.pending().length, 1);
  w.net.down = false;
  await d.timers.advance(16000);
  assert.equal(d.client.getStatus().state, 'synced');
  const other = w.device(); await other.client.joinHousehold(d.client.getHouseholdCode());
  assert.deepEqual([...other.store.recs.keys()].sort(), ['brew-0001', 'brew-0002']);
  // backoff reset: next failure starts again at 2 s
  w.net.down = true; d.store.put(rec('brew-0003', 3)); await d.timers.advance(1500);
  assert.deepEqual(d.timers.pending(), [2000]);
});

test('backoff is capped', async () => {
  const w = world();
  const d = w.device({ client: { backoffMaxMs: 10_000 } });
  d.client.start(); await d.client.createHousehold();
  w.net.down = true; d.store.put(rec('brew-0001', 1)); await d.timers.advance(1500);
  for (let i = 0; i < 8; i++) { const [next] = d.timers.pending(); assert.ok(next <= 10_000); await d.timers.advance(next); }
});

test('the browser coming back online syncs immediately, even in the middle of a backoff', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  d.env.setOnline(false);
  assert.equal(d.client.getStatus().state, 'offline');
  const n = w.net.requests.length;
  d.store.put(rec('brew-0001', 1)); await d.timers.advance(2000);
  assert.equal(w.net.requests.length, n, 'no requests while navigator says offline');
  d.env.setOnline(true); await d.timers.advance(0);
  assert.equal(d.client.getStatus().state, 'synced');
  assert.ok(w.net.requests.length > n);

  w.net.down = true; d.store.put(rec('brew-0002', 2)); await d.timers.advance(1500); // now in backoff
  assert.ok(d.timers.pending()[0] > 0);
  w.net.down = false; d.env.setOnline(true); await d.timers.advance(0);
  assert.equal(d.client.getStatus().state, 'synced');
});

test('server errors (5xx) retry with backoff and show "Sync problem"; recovers when storage returns', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  w.db.outage(true);
  d.store.put(rec('brew-0001', 1)); await d.timers.advance(1500);
  const s = d.client.getStatus();
  assert.equal(s.state, 'error'); assert.equal(s.label, 'Sync problem');
  assert.equal(s.error.code, 'server'); assert.ok(s.retryAt > 0);
  w.db.outage(false);
  await d.timers.advance(2000);
  assert.equal(d.client.getStatus().state, 'synced');
});

test('429 honours Retry-After and a later success clears it', async () => {
  const w = world({ limits: { syncPerMinute: 2 } });
  const d = w.device();
  d.client.start();
  await d.client.createHousehold(); // 1 request
  d.store.put(rec('brew-0001', 1)); await d.timers.advance(1500); // 2nd request ok
  d.store.put(rec('brew-0002', 2)); await d.timers.advance(1500); // 3rd: limited
  assert.equal(d.client.getStatus().error.code, 'rate_limited');
  const wait = d.timers.pending()[0];
  assert.ok(wait >= 1000 && wait <= 60_000);
  await d.timers.advance(60_000);
  assert.equal(d.client.getStatus().state, 'synced');
});

test('unauthorized (household gone / wrong code) stops retrying until the user acts', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  w.db.deleteHouseholds(); // household deleted server-side
  d.store.put(rec('brew-0001', 1)); await d.timers.advance(1500);
  assert.equal(d.client.getStatus().state, 'error');
  assert.equal(d.client.getStatus().error.fatal, true);
  assert.equal(d.client.getStatus().label, 'Sync stopped');
  assert.deepEqual(d.timers.pending(), []);
  const n = w.net.requests.length;
  d.store.put(rec('brew-0002', 2)); await d.timers.advance(5000); d.env.setVisible(true); await d.timers.advance(0);
  assert.equal(w.net.requests.length, n, 'no more requests');
  d.client.leaveHousehold();
  assert.equal(d.client.getStatus().state, 'off');
  assert.equal(d.client.getHouseholdCode(), null);
  assert.ok(d.store.recs.has('brew-0002'), 'local data is kept');
});

test('store changes are debounced into one sync that carries every change', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  const n = w.net.requests.length;
  d.store.put(rec('brew-0001', 1)); await d.timers.advance(500);
  d.store.put(rec('brew-0002', 2)); await d.timers.advance(500);
  d.store.put(rec('brew-0003', 3)); await d.timers.advance(1400);
  assert.equal(w.net.requests.length, n, 'still waiting for quiet');
  await d.timers.advance(200);
  assert.equal(w.net.requests.length, n + 1);
  assert.equal(JSON.parse(w.net.requests.at(-1).body).changes.length, 3);
});

test('continuous edits still sync within the max wait (debounce cannot starve sync)', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  const n = w.net.requests.length;
  for (let i = 0; i < 20; i++) { d.store.put(rec(`brew-${String(i).padStart(4, '0')}`, i + 1)); await d.timers.advance(1000); }
  assert.ok(w.net.requests.length > n, 'synced at least once during the 20 s burst');
  assert.ok(w.net.requests.length <= n + 2);
});

test('remote merges do not echo back as local changes, and an idle sync sends no records', async () => {
  const w = world();
  const A = w.device(), B = w.device();
  A.client.start(); B.client.start();
  A.store.put(rec('brew-0001', 1));
  const { code } = await A.client.createHousehold();
  await B.client.joinHousehold(code);
  assert.equal(B.store.applied.length, 1);
  const n = w.net.requests.length;
  await B.timers.advance(5000); // applyRemote must not have scheduled another sync
  assert.equal(w.net.requests.length, n);
  await B.client.syncNow();
  const last = JSON.parse(w.net.requests.at(-1).body);
  assert.deepEqual(last.changes, []);
  assert.equal(B.store.applied.length, 1);
});

test('big pushes are chunked: every request stays small, nothing is lost, oversize records are skipped once', async () => {
  const w = world();
  const d = w.device({ client: { chunkBytes: 100_000 } });
  const brew = (i, n) => rec(`brew-${String(i).padStart(4, '0')}`, 10 + i, { samples: { hz: 10, channels: { weight: new Array(n).fill(12.3456), flow: new Array(n).fill(1.234) } } });
  for (let i = 0; i < 40; i++) d.store.put(brew(i, 3000)); // ~45 KB each, ~1.8 MB total
  d.store.put(brew(99, 30_000)); // ~450 KB: can never sync
  d.client.start();
  const { code } = await d.client.createHousehold();
  const pushes = w.net.requests.filter((r) => r.path === '/api/sync' && (JSON.parse(r.body).changes || []).length);
  assert.ok(pushes.length >= 20, `chunks: ${pushes.length}`);
  assert.ok(Math.max(...pushes.map((r) => r.bytes)) < 200_000, 'every request far below the 1 MB limit');
  assert.equal(d.client.getStatus().skipped, 1);
  const other = w.device(); await other.client.joinHousehold(code);
  assert.equal(other.store.recs.size, 40);
  const sent = w.net.requests.length;
  await d.client.syncNow();
  const again = w.net.requests.slice(sent).map((r) => (JSON.parse(r.body).changes || []).length);
  assert.deepEqual(again, [0], 'the oversize record is not retried');
});

test('records the server rejects are remembered and not re-sent until they change', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  d.store.put({ id: 'bad', type: 'brew', updatedAt: 5 }); // id too short for the server
  d.store.put(rec('brew-0001', 6));
  await d.timers.advance(1500);
  assert.equal(d.client.getStatus().skipped, 1);
  assert.equal(d.client.getStatus().state, 'synced');
  const n = w.net.requests.length;
  await d.client.syncNow();
  assert.deepEqual(JSON.parse(w.net.requests[n].body).changes, []);
  const other = w.device(); await other.client.joinHousehold(d.client.getHouseholdCode());
  assert.deepEqual([...other.store.recs.keys()], ['brew-0001']);
});

test('pull is paged until caught up', async () => {
  const w = world({ limits: { pageRecords: 4 } });
  const A = w.device(), B = w.device();
  for (let i = 0; i < 11; i++) A.store.put(rec(`brew-${String(i).padStart(4, '0')}`, 10 + i));
  await A.client.createHousehold();
  const { code } = { code: A.client.getHouseholdCode() };
  await B.client.joinHousehold(code);
  assert.equal(B.store.recs.size, 11);
  assert.equal(B.store.applied.length, 3);
});

test('state survives a restart: same household, resumes from the saved rev (no full re-pull)', async () => {
  const w = world();
  const A = w.device();
  A.store.put(rec('brew-0001', 1)); A.store.put(rec('brew-0002', 2));
  A.client.start(); await A.client.createHousehold();
  A.client.stop();
  const again = w.device({ store: A.store, storage: A.storage });
  assert.equal(again.client.getHouseholdCode(), A.client.getHouseholdCode());
  assert.equal(again.client.getStatus().state, 'idle');
  w.net.requests.length = 0;
  again.client.start(); await again.timers.advance(0);
  const body = JSON.parse(w.net.requests[0].body);
  assert.equal(body.since, w.d1.sql('SELECT rev FROM households')[0].rev, 'resumes from the saved server rev');
  assert.ok(body.since > 0);
  assert.deepEqual(body.changes, [], 'already-pushed records are not pushed again');
  assert.equal(again.client.getStatus().state, 'synced');
});

test('server lost its data: the client notices (reset) and re-pushes everything', async () => {
  const w = world();
  const A = w.device();
  for (let i = 0; i < 5; i++) A.store.put(rec(`brew-000${i}`, 10 + i));
  A.client.start(); const { code } = await A.client.createHousehold();
  w.db.loseRecords(); // records gone and counter back to 0; the household remains
  A.env.setVisible(true); await A.timers.advance(0);
  assert.equal(A.client.getStatus().state, 'synced');
  const B = w.device(); await B.client.joinHousehold(code);
  assert.equal(B.store.recs.size, 5, 'server repopulated from the device');
});

test('syncNow while a sync runs does not start a parallel one', async () => {
  const w = world();
  const d = w.device();
  d.client.start(); await d.client.createHousehold();
  let inflight = 0, maxInflight = 0;
  const slow = async (u, i) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setImmediate(r)); try { return await w.fetch(u, i); } finally { inflight--; } };
  const e = w.device({ fetch: slow, storage: d.storage, store: d.store });
  await Promise.all([e.client.syncNow(), e.client.syncNow(), e.client.syncNow()]);
  await settle();
  assert.equal(maxInflight, 1);
});

test('a store that breaks the contract yields a status error, not a crash', async () => {
  const w = world();
  const store = makeStore(); store.changesSince = async () => [];
  const d = w.device({ store });
  d.client.start(); await d.client.createHousehold();
  assert.equal(d.client.getStatus().state, 'error');
  assert.equal(d.client.getStatus().error.code, 'store');
});

test('status listeners get updates; the household code never appears in a status object or console output', async () => {
  const w = world();
  const logs = []; const orig = {}; for (const k of ['log', 'warn', 'error', 'info', 'debug']) { orig[k] = console[k]; console[k] = (...a) => logs.push(a.join(' ')); }
  const d = w.device(); const seen = [];
  d.client.onStatus((s) => seen.push(s));
  let code;
  try {
    d.client.start(); ({ code } = await d.client.createHousehold());
    w.net.down = true; d.store.put(rec('brew-0001', 1)); await d.timers.advance(1500);
  } finally { Object.assign(console, orig); }
  assert.deepEqual([...new Set(seen.map((s) => s.state))].slice(0, 4), ['off', 'idle', 'syncing', 'synced']);
  assert.ok(seen.some((s) => s.state === 'offline'));
  assert.ok(!JSON.stringify(seen).includes(code));
  assert.ok(!logs.join('\n').includes(code));
});

test('joining another household while a pull is being merged does not corrupt the new household state', async () => {
  const w = world();
  const seed1 = w.device(), seed2 = w.device();
  for (let i = 0; i < 12; i++) seed1.store.put(rec(`brew-${String(i).padStart(4, '0')}`, 100 + i)); // household 1: high rev
  seed2.store.put(rec('brew-9999', 500));                                                         // household 2: tiny
  const code1 = (await seed1.client.createHousehold()).code, code2 = (await seed2.client.createHousehold()).code;
  const rev2 = w.d1.sql('SELECT rev FROM households ORDER BY created_at DESC, rev ASC LIMIT 1')[0].rev;

  const store = makeStore();
  let entered, release; const inMerge = new Promise((r) => { entered = r; }); const gate = new Promise((r) => { release = r; });
  const realApply = store.applyRemote.bind(store);
  store.applyRemote = async (list) => { entered(); await gate; return realApply(list); }; // hang inside the merge
  const D = w.device({ store });
  D.client.start();
  const joining1 = D.client.joinHousehold(code1);
  await inMerge;                                   // household 1's records are being merged right now
  const joining2 = D.client.joinHousehold(code2);  // the user switches household meanwhile
  await until(() => D.client.getHouseholdCode() === code2, 'the switch to household 2');
  release();
  await Promise.all([joining1, joining2]);
  w.net.requests.length = 0;
  await D.client.syncNow();
  const saved = JSON.parse(D.storage.getItem('dot.sync'));
  assert.equal(saved.code, code2);
  assert.equal(JSON.parse(w.net.requests[0].body).since, 0, "household 2's first sync starts from 0, not household 1's rev");
  assert.equal(saved.since, rev2, "state holds household 2's rev, not household 1's");
  assert.equal(D.client.getStatus().state, 'synced');
});

test('a debounce armed while a sync is failing cannot bypass Retry-After', async () => {
  const w = world({ limits: { syncPerMinute: 1 } });
  let hold = null, reached = false;
  const D = w.device({ fetch: async (u, i) => { if (hold) { reached = true; await hold.promise; } return w.fetch(u, i); } });
  D.client.start();
  await D.client.createHousehold();                      // uses the single request allowed this minute
  let release;
  reached = false;
  hold = { promise: new Promise((r) => { release = r; }) };
  D.store.put(rec('brew-0001', 1));
  const syncing = D.client.syncNow();                     // request in flight (will be refused with 429)
  await until(() => reached, 'the request to be in flight');
  D.store.put(rec('brew-0002', 2));                       // an edit arms a 1.5 s debounce meanwhile
  hold = null; release();
  await syncing;
  assert.equal(D.client.getStatus().error?.code, 'rate_limited');
  const before = w.net.requests.length;
  await D.timers.advance(5000);
  assert.equal(w.net.requests.length, before, 'no request before Retry-After has passed');
  assert.ok(D.timers.pending()[0] > 0);
  await D.timers.advance(61_000);
  assert.ok(w.net.requests.length > before, 'retries after Retry-After');
  assert.equal(D.client.getStatus().state, 'synced');
});

test('two real app stores converge through the store adapter, the client and the Worker (edit, delete, no echo)', async () => {
  const w = world();
  const mk = () => {
    const real = createStore(memoryAdapter(), { now: () => w.clock.t });
    return { real, ...w.device({ store: syncStoreAdapter(real) }) };
  };
  const A = mk(), B = mk();
  A.client.start(); B.client.start();
  const beanA = await A.real.put({ type: 'bean', name: 'Guji', roaster: 'Example Roasters' });
  w.clock.t += 10;
  await A.real.put({ type: 'profile', name: 'Yaaf' });
  const { code } = await A.client.createHousehold();
  await B.client.joinHousehold(code);
  assert.deepEqual((await B.real.list('bean')).map((x) => x.name), ['Guji']);
  assert.deepEqual((await B.real.list('profile')).map((x) => x.name), ['Yaaf']);

  w.clock.t += 1000;                                    // B edits; its debounce pushes it
  await B.real.update(beanA.id, { notes: 'fruity' });
  await B.timers.advance(1500);
  await A.client.syncNow();                             // A learns of it at its next sync
  assert.equal((await A.real.get(beanA.id)).notes, 'fruity');

  w.clock.t += 1000;                                    // A deletes; B sees the tombstone
  await A.real.delete(beanA.id);
  await A.timers.advance(1500);
  await B.client.syncNow();
  assert.equal(await B.real.get(beanA.id), undefined);
  assert.equal((await B.real.list('bean', { includeDeleted: true }))[0].deleted, true);

  // nothing bounces back and forth: a sync with no local changes pushes no records, and merging doesn't schedule more syncs
  const before = w.net.requests.length;
  await A.timers.advance(10_000); await B.timers.advance(10_000);
  assert.equal(w.net.requests.length, before, 'no background chatter after convergence');
  await B.client.syncNow();
  assert.deepEqual(JSON.parse(w.net.requests.at(-1).body).changes, []);
});

test('joining or leaving a household tells the store to forget what came from the old one', async () => {
  const w = world();
  const seed = w.device(); await seed.client.createHousehold();
  const code = seed.client.getHouseholdCode();
  let resets = 0;
  const store = makeStore(); store.reset = () => { resets++; };
  const d = w.device({ store });
  await d.client.joinHousehold(code);
  assert.equal(resets, 1);
  d.client.leaveHousehold();
  assert.equal(resets, 2);
  await d.client.createHousehold();
  assert.equal(resets, 3);
});

test('probe() is remembered for 30 s, can be forced, and a network blip is not remembered', async () => {
  const w = world();
  const d = w.device();
  assert.equal(await d.client.probe(), true);
  assert.equal(await d.client.probe(), true);
  assert.equal(w.net.requests.length, 1, 'the second call is served from memory');
  w.clock.t += 31_000;
  await d.client.probe();
  assert.equal(w.net.requests.length, 2, 'asked again after 30 s');
  await d.client.probe({ force: true });
  assert.equal(w.net.requests.length, 3, 'force asks again');
  w.net.down = true;
  assert.equal(await d.client.probe({ force: true }), false);
  w.net.down = false;
  assert.equal(await d.client.probe(), true, 'a failed network attempt is not cached as an answer');
});
