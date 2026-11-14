// Worker handlers + the real D1 adapter/migration, run on in-memory SQLite (see test/helpers/d1-sqlite.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeServer, call, T0 } from './helpers/world.mjs';
import { generateCode, hashCode, handleHousehold, handleSync, LIMITS } from '../worker/handlers.js';
import { compare } from '../worker/records.js';
import { WORDS } from '../worker/words.js';
import worker from '../worker/index.js';

const rec = (id, updatedAt, extra = {}) => ({ id, type: 'brew', updatedAt, ...extra });
const post = (s, code, body, opts = {}) => call(s.sync, { headers: { authorization: `Bearer ${code}` }, body, ...opts });
async function newHousehold(s, ip) { const r = await call(s.household, { ip, path: '/api/household' }); assert.equal(r.status, 201); return r.json.code; }

test('words list has 256 distinct lowercase words; codes look right and are not repeated', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.match(c, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 1990, 'codes should essentially never collide');
});

test('worker entry: routes /api/*, 404s unknown API paths, falls through to assets, 503 JSON without a D1 binding', async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (r) => { seen.push(new URL(r.url).pathname); return new Response('asset'); } } };
  const r1 = await worker.fetch(new Request('https://x.test/api/nope', { method: 'POST' }), env);
  assert.equal(r1.status, 404);
  assert.equal((await r1.json()).error, 'not_found');
  assert.equal(await (await worker.fetch(new Request('https://x.test/index.html'), env)).text(), 'asset');
  assert.deepEqual(seen, ['/index.html']);
  for (const path of ['/api/household', '/api/sync']) {
    const r = await worker.fetch(new Request('https://x.test' + path, { method: 'POST', headers: { authorization: 'Bearer maple-tiger-orbit-1234' }, body: '{}' }), env);
    assert.equal(r.status, 503, path);
    const j = await r.json();
    assert.equal(j.error, 'sync_not_configured');
    assert.match(j.message, /D1/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('worker entry end to end with a D1 binding', async () => {
  const s = makeServer();
  const env = { DB: s.d1, SYNC_PEPPER: 'pep' };
  const c = await worker.fetch(new Request('https://x.test/api/household', { method: 'POST' }), env);
  assert.equal(c.status, 201);
  const { code } = await c.json();
  const r = await worker.fetch(new Request('https://x.test/api/sync', { method: 'POST', headers: { authorization: `Bearer ${code}` }, body: JSON.stringify({ since: 0, changes: [rec('brew-0001', 5)] }) }), env);
  assert.equal((await r.json()).accepted, 1);
  assert.equal(s.d1.sql('SELECT hash FROM households')[0].hash, await hashCode(code, 'pep'), 'pepper from the env is used');
});

test('migration + schema: applies cleanly and has the expected tables and index', () => {
  const s = makeServer();
  const names = s.d1.sql("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
  assert.deepEqual(names, ['households', 'rate_limits', 'records', 'records_by_rev']);
  assert.ok(readdirSync(new URL('../migrations/', import.meta.url)).every((f) => /^\d{4}_.+\.sql$/.test(f)), 'wrangler applies migrations in filename order');
});

test('household: POST only; creation stores only a hash of the code', async () => {
  const s = makeServer({ pepper: 'pep' });
  const get = await call(s.household, { method: 'GET', path: '/api/household' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  const code = await newHousehold(s);
  const dump = JSON.stringify(['households', 'records', 'rate_limits'].map((t) => s.d1.sql(`SELECT * FROM ${t}`)));
  assert.ok(!dump.includes(code), 'code must not appear anywhere in the database');
  assert.equal(s.d1.sql('SELECT hash FROM households')[0].hash, await hashCode(code, 'pep'));
  assert.notEqual(await hashCode(code, 'pep'), await hashCode(code, ''));
  const probe = await post(s, code, { since: 0, changes: [] });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.json, { rev: 0, changes: [], more: false, accepted: 0, rejected: [], reset: false });
});

test('household: creation is rate limited per caller IP and the window resets', async () => {
  const s = makeServer();
  for (let i = 0; i < LIMITS.createPerHourPerIp; i++) await newHousehold(s, '198.51.100.1');
  const r = await call(s.household, { ip: '198.51.100.1', path: '/api/household' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.equal(r.json.error, 'rate_limited');
  assert.equal((await call(s.household, { ip: '198.51.100.2', path: '/api/household' })).status, 201);
  s.clock.t += 3_600_000;
  assert.equal((await call(s.household, { ip: '198.51.100.1', path: '/api/household' })).status, 201);
});

test('auth: missing, malformed and unknown codes are rejected with actionable messages', async () => {
  const s = makeServer();
  assert.equal((await call(s.sync, { method: 'GET' })).status, 405);
  const none = await call(s.sync, { body: { since: 0, changes: [] } });
  assert.equal(none.status, 401); assert.equal(none.json.error, 'missing_code');
  assert.equal((await post(s, 'x', { since: 0 })).status, 401);
  assert.equal((await call(s.sync, { headers: { authorization: 'Basic abc' }, body: {} })).status, 401);
  const unknown = await post(s, 'maple-tiger-orbit-0000', { since: 0, changes: [] });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error, 'unknown_household');
  assert.match(unknown.json.message, /Settings/);
  assert.equal((await post(s, await newHousehold(s), { since: 0, changes: [] })).status, 200);
});

test('auth: repeated wrong codes from one IP are throttled; even a right code then gets no answer', async () => {
  const s = makeServer();
  const good = await newHousehold(s, '192.0.2.50');
  for (let i = 0; i < LIMITS.ipFailuresPer10Min; i++) {
    assert.equal((await post(s, `wrong-guess-here-${1000 + i}`, { since: 0 }, { ip: '192.0.2.99' })).status, 401);
  }
  assert.equal((await post(s, good, { since: 0 }, { ip: '192.0.2.99' })).status, 429);
  assert.equal((await post(s, good, { since: 0 }, { ip: '192.0.2.50' })).status, 200, 'other callers are fine');
  s.clock.t += 1_201_000;
  assert.equal((await post(s, good, { since: 0 }, { ip: '192.0.2.99' })).status, 200, 'block expires');
});

test('rate limit: per household hash regardless of IP, with Retry-After', async () => {
  const s = makeServer({ limits: { syncPerMinute: 3 } });
  const a = await newHousehold(s), b = await newHousehold(s);
  for (let i = 0; i < 3; i++) assert.equal((await post(s, a, { since: 0 }, { ip: `10.0.0.${i}` })).status, 200);
  const limited = await post(s, a, { since: 0 }, { ip: '10.0.0.200' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await post(s, b, { since: 0 })).status, 200, 'other households unaffected');
  s.clock.t += 60_000;
  assert.equal((await post(s, a, { since: 0 })).status, 200, 'next minute window');
});

test('merge: new records stored; revs strictly increase; others see them, the pusher does not get an echo', async () => {
  const s = makeServer();
  const code = await newHousehold(s);
  const r1 = await post(s, code, { since: 0, changes: [rec('brew-0001', 100), rec('brew-0002', 200, { dose: 16 })] });
  assert.equal(r1.json.accepted, 2);
  assert.deepEqual(r1.json.changes, [], 'own pushes are not echoed back');
  const r2 = await post(s, code, { since: r1.json.rev, changes: [rec('brew-0003', 300)] });
  assert.ok(r2.json.rev > r1.json.rev);
  const other = await post(s, code, { since: 0, changes: [] });
  assert.deepEqual(other.json.changes.map((r) => r.id), ['brew-0001', 'brew-0002', 'brew-0003']);
  assert.equal(other.json.changes[1].dose, 16);
  assert.equal(other.json.rev, r2.json.rev);
  const none = await post(s, code, { since: other.json.rev, changes: [] });
  assert.deepEqual(none.json.changes, []);
  assert.equal(none.json.rev, other.json.rev);
  const revs = s.d1.sql('SELECT rev FROM records ORDER BY rev').map((r) => r.rev);
  assert.equal(new Set(revs).size, revs.length, 'every record has its own rev');
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
});

test('merge: a caught-up device pushing does not trigger a pull query; a device that is behind does pull', async () => {
  const s = makeServer();
  const code = await newHousehold(s);
  const pulls = () => s.d1.log.filter((q) => /ORDER BY rev\s+LIMIT/.test(q)).length;
  const first = await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const other = await post(s, code, { since: 0, changes: [] }); // a pull-only sync leaves the device caught up too
  assert.equal(other.json.rev, first.json.rev);
  s.d1.log.length = 0;
  const r = await post(s, code, { since: first.json.rev, changes: [rec('brew-0002', 2)] });
  assert.equal(r.json.more, false);
  assert.ok(r.json.rev > first.json.rev);
  assert.equal(pulls(), 0, 'caught-up push needs no pull query');
  await post(s, code, { since: r.json.rev, changes: [rec('brew-0003', 3)] }); // device A pushes
  s.d1.log.length = 0;
  const behind = await post(s, code, { since: r.json.rev, changes: [rec('brew-0004', 4)] }); // device B is behind by that push
  assert.deepEqual(behind.json.changes.map((x) => x.id), ['brew-0003']);
  assert.equal(pulls(), 1);
});

test('merge: last writer wins on updatedAt; the loser gets the winning copy back', async () => {
  const s = makeServer();
  const code = await newHousehold(s);
  const a = await post(s, code, { since: 0, changes: [rec('brew-0001', 500, { notes: 'phone' })] });
  const stale = await post(s, code, { since: a.json.rev, changes: [rec('brew-0001', 400, { notes: 'ipad-old' })] });
  assert.equal(stale.json.accepted, 0);
  assert.equal(stale.json.changes.length, 1, 'winning server copy is returned even though it is older than `since`');
  assert.equal(stale.json.changes[0].notes, 'phone');
  const fresh = await post(s, code, { since: stale.json.rev, changes: [rec('brew-0001', 600, { notes: 'ipad-new' })] });
  assert.equal(fresh.json.accepted, 1);
  const read = await post(s, code, { since: 0, changes: [] });
  assert.equal(read.json.changes.length, 1);
  assert.equal(read.json.changes[0].notes, 'ipad-new');
});

test('merge: identical push is a no-op; equal updatedAt resolves the same way whichever arrives first', async () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const s = makeServer();
    const code = await newHousehold(s);
    const v = { a: rec('brew-0001', 700, { notes: 'a' }), b: rec('brew-0001', 700, { notes: 'b' }) };
    await post(s, code, { since: 0, changes: [v[order[0]]] });
    await post(s, code, { since: 0, changes: [v[order[1]]] });
    const read = await post(s, code, { since: 0, changes: [] });
    assert.equal(read.json.changes[0].notes, compare(v.a, v.b) > 0 ? 'a' : 'b');
  }
  const s = makeServer(); const code = await newHousehold(s);
  const one = await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const again = await post(s, code, { since: one.json.rev, changes: [rec('brew-0001', 1)] });
  assert.equal(again.json.accepted, 0);
  assert.deepEqual(again.json.changes, []);
  assert.equal(compare({ id: 'b', updatedAt: 5 }, { id: 'a', updatedAt: 5 }), 1, 'ties between ids break by id');
});

test('merge: duplicates inside one request collapse to the winner', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  const r = await post(s, code, { since: 0, changes: [rec('brew-0001', 5, { n: 'old' }), rec('brew-0001', 9, { n: 'new' }), rec('brew-0001', 7, { n: 'mid' })] });
  assert.equal(r.json.accepted, 1);
  assert.equal((await post(s, code, { since: 0, changes: [] })).json.changes[0].n, 'new');
});

test('tombstones: kept, compacted to the envelope, and subject to LWW', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 100, { samples: { weight: new Array(500).fill(1) } })] });
  await post(s, code, { since: 0, changes: [rec('brew-0001', 200, { deleted: true, samples: { weight: [1, 2, 3] }, notes: 'secret' })] });
  let read = await post(s, code, { since: 0, changes: [] });
  assert.deepEqual(read.json.changes, [{ id: 'brew-0001', type: 'brew', updatedAt: 200, deleted: true }]);
  assert.equal(s.d1.sql('SELECT deleted FROM records')[0].deleted, 1);
  const old = await post(s, code, { since: read.json.rev, changes: [rec('brew-0001', 150, { notes: 'late' })] });
  assert.equal(old.json.accepted, 0);
  assert.equal(old.json.changes[0].deleted, true, 'an older offline edit must not undelete');
  await post(s, code, { since: old.json.rev, changes: [rec('brew-0001', 300, { notes: 'back' })] });
  read = await post(s, code, { since: 0, changes: [] });
  assert.equal(read.json.changes[0].deleted, undefined);
  assert.equal(read.json.changes[0].notes, 'back');
  assert.equal(s.d1.sql('SELECT deleted FROM records')[0].deleted, 0);
  await post(s, code, { since: read.json.rev, changes: [{ id: 'brew-0002', type: 'brew', updatedAt: 50, deleted: true }] });
  read = await post(s, code, { since: 0, changes: [] });
  assert.ok(read.json.changes.some((r) => r.id === 'brew-0002' && r.deleted), 'a delete of something never seen still leaves a tombstone');
});

test('households are isolated from each other', async () => {
  const s = makeServer();
  const a = await newHousehold(s), b = await newHousehold(s);
  await post(s, a, { since: 0, changes: [rec('brew-0001', 1, { v: 'A' })] });
  await post(s, b, { since: 0, changes: [rec('brew-0001', 9, { v: 'B' })] });
  assert.equal((await post(s, a, { since: 0 })).json.changes[0].v, 'A');
  assert.equal((await post(s, b, { since: 0 })).json.changes[0].v, 'B');
});

test('two devices converge through the server', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  const A = [rec('brew-0001', 100, { v: 'A1' }), rec('brew-0002', 300, { v: 'A2' })];
  const B = [rec('brew-0001', 200, { v: 'B1' }), rec('brew-0002', 250, { v: 'B2' }), rec('brew-0003', 10, { v: 'B3' })];
  const merge = (local, incoming) => { const m = new Map(local.map((r) => [r.id, r])); for (const r of incoming) { const c = m.get(r.id); if (!c || compare(r, c) > 0) m.set(r.id, r); } return [...m.values()].sort((x, y) => (x.id < y.id ? -1 : 1)); };
  const ra = await post(s, code, { since: 0, changes: A });
  const rb = await post(s, code, { since: 0, changes: B });
  const ra2 = await post(s, code, { since: ra.json.rev, changes: [] });
  const bothA = merge(merge(A, rb.json.changes), ra2.json.changes);
  const bothB = merge(B, rb.json.changes);
  assert.deepEqual(bothA, bothB);
  assert.deepEqual(bothA.map((r) => r.v), ['B1', 'A2', 'B3']);
});

test('concurrent pushes to one household never lose an update or reuse a rev', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  const pushes = [];
  for (let d = 0; d < 6; d++) {
    for (let k = 0; k < 5; k++) pushes.push(post(s, code, { since: 0, changes: [1, 2, 3, 4].map((i) => rec(`brew-000${i}`, 1000 + d * 10 + k + i, { by: `${d}.${k}` })) }));
  }
  const results = await Promise.all(pushes);
  assert.ok(results.every((r) => r.status === 200));
  const rows = s.d1.sql('SELECT id, updated_at, rev FROM records ORDER BY id');
  assert.deepEqual(rows.map((r) => r.updated_at), [1000 + 50 + 4 + 1, 1000 + 50 + 4 + 2, 1000 + 50 + 4 + 3, 1000 + 50 + 4 + 4], 'newest write wins per record');
  assert.equal(new Set(rows.map((r) => r.rev)).size, rows.length);
  assert.ok(Math.max(...rows.map((r) => r.rev)) <= s.d1.sql('SELECT rev FROM households')[0].rev);
});

test('pull is paged: `more` and a cursor that resumes without gaps or repeats', async () => {
  const s = makeServer({ limits: { pageRecords: 3 } });
  const code = await newHousehold(s);
  const ids = Array.from({ length: 8 }, (_, i) => `brew-${String(i).padStart(4, '0')}`);
  for (let i = 0; i < 8; i += 4) await post(s, code, { since: 0, changes: ids.slice(i, i + 4).map((id, j) => rec(id, 1000 + i + j)) });
  const got = []; let since = 0, pages = 0;
  for (;;) {
    const r = await post(s, code, { since, changes: [] });
    got.push(...r.json.changes.map((x) => x.id)); since = r.json.rev; pages++;
    if (!r.json.more) break;
    assert.ok(pages < 10);
  }
  assert.deepEqual(got, ids);
  assert.equal(pages, 3);
});

test('pull response stays under the byte budget (large records are split across pages)', async () => {
  const s = makeServer({ limits: { pageBytes: 50_000 } });
  const code = await newHousehold(s);
  const big = (i) => rec(`brew-${i}000`, 100 + i, { samples: { weight: new Array(5000).fill(12.34) } }); // ~30 KB each
  await post(s, code, { since: 0, changes: [0, 1, 2, 3].map(big) });
  let since = 0; const ids = []; let pages = 0;
  for (;;) {
    const r = await post(s, code, { since, changes: [] });
    assert.ok(r.text.length < 90_000);
    ids.push(...r.json.changes.map((x) => x.id)); since = r.json.rev; pages++;
    if (!r.json.more) break;
  }
  assert.equal(ids.length, 4);
  assert.ok(pages >= 2);
});

test('limits: 1 MB request cap (declared and actual), per-record cap, records per request', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  const declared = await post(s, code, { since: 0, changes: [] }, { headers: { authorization: `Bearer ${code}`, 'content-length': String(2 * 1024 * 1024) } }).catch((e) => ({ status: 'threw', e }));
  if (declared.status !== 'threw') assert.equal(declared.status, 413); // (some runtimes refuse to send a lying Content-Length at all)
  const huge = await post(s, code, JSON.stringify({ since: 0, changes: [{ pad: 'x'.repeat(1024 * 1024 + 10) }] }));
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error, 'too_large');
  const oneBig = await post(s, code, { since: 0, changes: [rec('brew-0001', 5, { pad: 'x'.repeat(LIMITS.maxRecordBytes) }), rec('brew-0002', 5)] });
  assert.equal(oneBig.status, 200);
  assert.equal(oneBig.json.accepted, 1);
  assert.equal(oneBig.json.rejected[0].id, 'brew-0001');
  assert.match(oneBig.json.rejected[0].reason, /limit/);
  const many = await post(s, code, { since: 0, changes: Array.from({ length: LIMITS.maxChangesPerRequest + 1 }, (_, i) => rec(`brew-${i}xxxx`, 5)) });
  assert.equal(many.status, 400);
  assert.equal(many.json.error, 'too_many_changes');
});

test('limits: household record cap (new records rejected, updates to existing still accepted)', async () => {
  const s = makeServer({ limits: { maxRecords: 3 } });
  const code = await newHousehold(s);
  const r = await post(s, code, { since: 0, changes: [1, 2, 3, 4, 5].map((i) => rec(`brew-000${i}`, i)) });
  assert.equal(r.json.accepted, 3);
  assert.equal(r.json.rejected.length, 2);
  assert.match(r.json.rejected[0].reason, /full/);
  assert.equal(s.d1.sql('SELECT COUNT(*) n FROM records')[0].n, 3);
  const upd = await post(s, code, { since: r.json.rev, changes: [rec('brew-0001', 99, { notes: 'edit' })] });
  assert.equal(upd.json.accepted, 1);
});

test('validation: strict envelope checks report what to fix and never store the bad record', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  const bad = [
    null, 'str', [], {},
    { id: 'short', type: 'brew', updatedAt: 5 },
    { id: 'brew-0001', type: 'Brew!', updatedAt: 5 },
    { id: 'brew-0002', type: 'brew', updatedAt: '5' },
    { id: 'brew-0003', type: 'brew', updatedAt: 1.5 },
    { id: 'brew-0004', type: 'brew', updatedAt: -1 },
    { id: 'brew-0005', type: 'brew', updatedAt: T0 + 3 * 86_400_000 },
    { id: 'brew-0006', type: 'brew', updatedAt: 5, deleted: false },
    { id: 'brew-0007', type: 'brew', updatedAt: 5, deleted: 'yes' },
  ];
  const r1 = await post(s, code, { since: 0, changes: bad.slice(0, 10) });
  const r2 = await post(s, code, { since: 0, changes: [...bad.slice(10), rec('brew-0099', 5)] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.rejected.length + r2.json.rejected.length, bad.length);
  assert.equal(r1.json.accepted + r2.json.accepted, 1);
  assert.ok([...r1.json.rejected, ...r2.json.rejected].every((x) => typeof x.reason === 'string' && x.reason.length > 10));
  assert.equal(s.d1.sql('SELECT COUNT(*) n FROM records')[0].n, 1);

  for (const body of ['{nope', '[]', 'null', JSON.stringify({ since: -1 }), JSON.stringify({ since: 'a' }), JSON.stringify({ since: 1.5 }),
    JSON.stringify({ changes: 'x' }), JSON.stringify({ limit: -2 })]) {
    const x = await post(s, code, body);
    assert.equal(x.status, 400, body);
    assert.ok(x.json.error && x.json.message, body);
  }
});

test('since beyond the server rev signals reset (data was lost) and returns data from 0', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const r = await post(s, code, { since: 500, changes: [] });
  assert.equal(r.json.reset, true);
  assert.equal(r.json.changes.length, 1);
  assert.ok(r.json.rev > 0);
});

test('limit:0 probes the household without returning data', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const r = await post(s, code, { since: 0, changes: [], limit: 0 });
  assert.deepEqual(r.json.changes, []);
  assert.equal(r.json.more, true);
});

test('D1 budget: even the worst request keeps >= 10 statements of margin under the Workers Free limit of 50', async () => {
  const run = async (limits) => {
    const s = makeServer({ limits }); const code = await newHousehold(s);
    const changes = (u) => Array.from({ length: LIMITS.maxChangesPerRequest }, (_, i) => rec(`brew-${String(i).padStart(4, '0')}`, u + i));
    const used = {};
    s.d1.queries = 0; const push = await post(s, code, { since: 0, changes: changes(100) });
    assert.equal(push.json.accepted, LIMITS.maxChangesPerRequest); used.push = s.d1.queries;
    s.d1.queries = 0; await post(s, code, { since: 0, changes: changes(1) }); used.conflictingPush = s.d1.queries; // every record loses -> restamp path
    s.d1.queries = 0; await post(s, code, { since: 0, changes: [] }); used.pull = s.d1.queries;
    return used;
  };
  for (const [label, limits] of [['normal', undefined], ['near the record cap (extra count/exists queries)', { maxRecords: LIMITS.maxChangesPerRequest }]]) {
    const used = await run(limits);
    for (const [k, n] of Object.entries(used)) assert.ok(n <= 40, `${label}: ${k} used ${n} statements`);
  }
});

test('record-cap queries are skipped for normal households (rev/2 bounds the record count)', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  s.d1.log.length = 0;
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  assert.ok(!s.d1.log.some((q) => /COUNT\(\*\)/.test(q)), 'no COUNT(*) on a small household');
  const lim = makeServer({ limits: { maxRecords: 4 } }); const c2 = await newHousehold(lim);
  await post(lim, c2, { since: 0, changes: [1, 2, 3, 4, 5, 6].map((i) => rec(`brew-000${i}`, i)) });
  assert.equal(lim.d1.sql('SELECT COUNT(*) n FROM records')[0].n, 4, 'but the cap still holds when it matters');
});

test('tie-break: JS compare() and the SQL upsert agree, including characters outside the BMP', async () => {
  // Same id and updatedAt, differing only by U+FFFF (BMP, UTF-16 unit 0xFFFF) vs U+1F600 (astral, surrogate 0xD83D...).
  // UTF-16 code-unit order puts the astral one first; UTF-8 byte order (what SQLite BINARY uses) puts it last.
  const bmp = rec('brew-0001', 500, { notes: '\uffff' }), astral = rec('brew-0001', 500, { notes: '\u{1F600}' });
  assert.equal(compare(astral, bmp), 1, 'UTF-8 byte order: U+1F600 > U+FFFF');
  for (const order of [[bmp, astral], [astral, bmp]]) {
    const s = makeServer(); const code = await newHousehold(s);
    await post(s, code, { since: 0, changes: [order[0]] });
    await post(s, code, { since: 0, changes: [order[1]] });
    assert.equal((await post(s, code, { since: 0 })).json.changes[0].notes, '\u{1F600}', 'same winner whichever arrives first');
  }
  const s = makeServer(); const code = await newHousehold(s);
  const same = await post(s, code, { since: 0, changes: [bmp, astral] }); // in one request: JS de-duplication must agree too
  assert.equal(same.json.accepted, 1);
  assert.equal((await post(s, code, { since: 0 })).json.changes[0].notes, '\u{1F600}');
});

test('the caller IP comes only from CF-Connecting-IP: a rotating X-Forwarded-For does not dodge the wrong-code limit', async () => {
  const s = makeServer();
  for (let i = 0; i < LIMITS.ipFailuresPer10Min; i++) {
    const r = await call(s.sync, { ip: '192.0.2.77', headers: { authorization: `Bearer wrong-guess-here-${2000 + i}`, 'x-forwarded-for': `10.9.8.${i}` }, body: { since: 0 } });
    assert.equal(r.status, 401);
  }
  const blocked = await call(s.sync, { ip: '192.0.2.77', headers: { authorization: 'Bearer wrong-guess-here-9999', 'x-forwarded-for': '10.1.1.1' }, body: { since: 0 } });
  assert.equal(blocked.status, 429, 'same CF-Connecting-IP stays limited however X-Forwarded-For changes');
});

test('authentication and rate limits come before reading the body', async () => {
  const mk = (server, auth) => new Request('https://x.test/api/sync', { method: 'POST', headers: { authorization: auth, 'CF-Connecting-IP': '203.0.113.9' }, body: '{"since":0}' });
  const s = makeServer(); const code = await newHousehold(s);
  for (const auth of ['Bearer maple-tiger-orbit-0000', 'Bearer nonsense']) { // unknown household, malformed code
    const req = mk(s, auth);
    assert.equal((await s.sync(req)).status, 401);
    assert.equal(req.bodyUsed, false, `body of an unauthenticated request must not be read (${auth})`);
  }
  const ok = mk(s, `Bearer ${code}`);
  assert.equal((await s.sync(ok)).status, 200);
  assert.equal(ok.bodyUsed, true, 'an authenticated request reads it');
  const lim = makeServer({ limits: { syncPerMinute: 1 } }); const c2 = await newHousehold(lim);
  assert.equal((await lim.sync(mk(lim, `Bearer ${c2}`))).status, 200);
  const limited = mk(lim, `Bearer ${c2}`);
  assert.equal((await lim.sync(limited)).status, 429);
  assert.equal(limited.bodyUsed, false, 'a rate-limited request does not read it either');
});

test('client and Worker share one definition of a valid household code', async () => {
  const client = await import('../app/sync/client.js');
  const handlers = await import('../worker/handlers.js');
  assert.equal(client.isValidCodeFormat, handlers.isValidCodeFormat);
  assert.equal(client.normalizeCode, handlers.normalizeCode);
  for (let i = 0; i < 200; i++) assert.ok(client.isValidCodeFormat(generateCode()));
});

test('a merge is atomic: if the batch fails nothing is written and the rev does not move', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const before = s.d1.sql('SELECT rev FROM households')[0].rev;
  const realBatch = s.d1.batch;
  s.d1.batch = async (stmts) => { if (stmts.length > 3) { // fail partway through a merge batch
    const orig = stmts[3]._run; stmts[3]._run = () => { throw new Error('boom'); }; try { return await realBatch(stmts); } finally { stmts[3]._run = orig; } }
    return realBatch(stmts); };
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await post(s, code, { since: before, changes: [rec('brew-0002', 2), rec('brew-0003', 3), rec('brew-0004', 4)] }); } finally { console.error = orig; s.d1.batch = realBatch; }
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'internal');
  assert.equal(s.d1.sql('SELECT COUNT(*) n FROM records')[0].n, 1);
  assert.equal(s.d1.sql('SELECT rev FROM households')[0].rev, before);
  assert.ok(!logs.join('\n').includes(code) && !logs.join('\n').includes('boom'), 'logs carry the error class only');
});

test('storage outage: 500 JSON with advice, nothing sensitive logged', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  s.d1.failNext = true;
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await post(s, code, { since: 0, changes: [] }); } finally { console.error = orig; s.d1.failNext = false; }
  assert.equal(r.status, 500);
  assert.match(r.json.message, /try again/i);
  assert.ok(logs.length >= 1);
  assert.ok(!logs.join('\n').includes(code));
});

test('API responses are never cacheable and carry nosniff', async () => {
  const s = makeServer(); const code = await newHousehold(s);
  for (const r of [await post(s, code, { since: 0 }), await post(s, 'maple-tiger-orbit-0000', { since: 0 }), await call(s.sync, { method: 'GET' })]) {
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
});

test('no api/ directory (Vercel would treat it as functions) and no Node-only APIs in the worker', () => {
  assert.throws(() => readdirSync(new URL('../api/', import.meta.url)), /ENOENT/);
  for (const f of readdirSync(new URL('../worker/', import.meta.url))) {
    const src = readFileSync(new URL(`../worker/${f}`, import.meta.url), 'utf8');
    assert.ok(!/from 'node:|require\(|Buffer\.|process\.env/.test(src), `${f} must run on Workers without nodejs_compat`);
  }
});
