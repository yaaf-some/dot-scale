// API handlers against an in-memory fake of the Upstash REST API (no real Redis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeUpstash } from './helpers/fake-upstash.mjs';
import { call } from './helpers/http.mjs';
import { createRedis, redisConfigFromEnv } from '../api/_lib/redis.js';
import { createHouseholdHandler, createSyncHandler, generateCode, hashCode, envDeps, LIMITS } from '../api/_lib/handlers.js';
import { compare } from '../api/_lib/records.js';
import { WORDS } from '../api/_lib/words.js';

const T0 = 1_700_000_000_000;
function setup({ limits, pepper = '' } = {}) {
  const clock = { t: T0 };
  const up = createFakeUpstash({ now: () => clock.t });
  const redis = createRedis({ url: up.url, token: up.token, fetch: up.fetch });
  const deps = () => ({ redis, now: () => clock.t, pepper, limits });
  return { clock, up, household: createHouseholdHandler(deps), sync: createSyncHandler(deps) };
}
const rec = (id, updatedAt, extra = {}) => ({ id, type: 'brew', updatedAt, ...extra });
const post = (s, code, body, opts = {}) => call(s.sync, { headers: { authorization: `Bearer ${code}` }, body, ...opts });
async function newHousehold(s, ip) { const r = await call(s.household, { ip }); assert.equal(r.statusCode, 201); return r.json.code; }

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

test('env: accepts KV_* and UPSTASH_* names, otherwise not configured', () => {
  assert.deepEqual(redisConfigFromEnv({ KV_REST_API_URL: 'https://a/', KV_REST_API_TOKEN: 't' }), { url: 'https://a', token: 't' });
  assert.deepEqual(redisConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'https://b', UPSTASH_REDIS_REST_TOKEN: 'u' }), { url: 'https://b', token: 'u' });
  assert.equal(redisConfigFromEnv({ KV_REST_API_URL: 'https://a' }), null);
  assert.equal(envDeps({}).redis, null);
});

test('household: POST only, 503 JSON when Upstash is not configured', async () => {
  const h = createHouseholdHandler(() => envDeps({}));
  const s = createSyncHandler(() => envDeps({}));
  const get = await call(h, { method: 'GET' });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, 'POST');
  const r = await call(h, {});
  assert.equal(r.statusCode, 503);
  assert.equal(r.json.error, 'sync_not_configured');
  assert.match(r.json.message, /Upstash/);
  const r2 = await call(s, { headers: { authorization: 'Bearer maple-tiger-orbit-1234' }, body: { since: 0, changes: [] } });
  assert.equal(r2.statusCode, 503);
  assert.equal(r2.json.error, 'sync_not_configured');
});

test('household: returns a code, stores only a hash of it', async () => {
  const s = setup({ pepper: 'pep' });
  const code = await newHousehold(s);
  assert.ok(!s.up.dump().some((x) => x.includes(code)), 'code must not appear in any key or value');
  assert.ok(s.up.keys().some((k) => k.includes(hashCode(code, 'pep'))), 'keys use the hash');
  assert.notEqual(hashCode(code, 'pep'), hashCode(code, ''), 'pepper changes the hash');
  const probe = await post(s, code, { since: 0, changes: [] });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probe.json, { rev: 0, changes: [], more: false, accepted: 0, rejected: [], reset: false });
});

test('household: creation is rate limited per caller IP', async () => {
  const s = setup();
  for (let i = 0; i < LIMITS.createPerHourPerIp; i++) await newHousehold(s, '198.51.100.1');
  const r = await call(s.household, { ip: '198.51.100.1' });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.equal(r.json.error, 'rate_limited');
  assert.equal((await call(s.household, { ip: '198.51.100.2' })).statusCode, 201, 'another IP is unaffected');
  s.clock.t += 3_600_000;
  assert.equal((await call(s.household, { ip: '198.51.100.1' })).statusCode, 201, 'window resets');
});

test('auth: missing, malformed, wrong-method and unknown codes are rejected with actionable messages', async () => {
  const s = setup();
  assert.equal((await call(s.sync, { method: 'GET' })).statusCode, 405);
  const none = await call(s.sync, { body: { since: 0, changes: [] } });
  assert.equal(none.statusCode, 401); assert.equal(none.json.error, 'missing_code');
  const bad = await post(s, 'x', { since: 0, changes: [] });
  assert.equal(bad.statusCode, 401);
  const basic = await call(s.sync, { headers: { authorization: 'Basic abc' }, body: {} });
  assert.equal(basic.statusCode, 401);
  const unknown = await post(s, 'maple-tiger-orbit-0000', { since: 0, changes: [] });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json.error, 'unknown_household');
  assert.match(unknown.json.message, /Settings/);
  // a code for household A is not valid on any other
  const a = await newHousehold(s);
  assert.equal((await post(s, a, { since: 0, changes: [] })).statusCode, 200);
});

test('auth: repeated wrong codes from one IP are throttled, even a right code then gets no answer', async () => {
  const s = setup();
  const good = await newHousehold(s, '192.0.2.50');
  for (let i = 0; i < LIMITS.ipFailuresPer10Min; i++) {
    assert.equal((await post(s, `wrong-guess-here-${1000 + i}`, { since: 0, changes: [] }, { ip: '192.0.2.99' })).statusCode, 401);
  }
  const blocked = await post(s, good, { since: 0, changes: [] }, { ip: '192.0.2.99' });
  assert.equal(blocked.statusCode, 429);
  assert.equal((await post(s, good, { since: 0, changes: [] }, { ip: '192.0.2.50' })).statusCode, 200, 'other callers are fine');
  s.clock.t += 601_000;
  assert.equal((await post(s, good, { since: 0, changes: [] }, { ip: '192.0.2.99' })).statusCode, 200, 'block expires');
});

test('rate limit: per household, independent of IP, with Retry-After', async () => {
  const s = setup({ limits: { syncPerMinute: 3 } });
  const a = await newHousehold(s), b = await newHousehold(s);
  for (let i = 0; i < 3; i++) assert.equal((await post(s, a, { since: 0, changes: [] }, { ip: `10.0.0.${i}` })).statusCode, 200);
  const limited = await post(s, a, { since: 0, changes: [] }, { ip: '10.0.0.200' });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await post(s, b, { since: 0, changes: [] })).statusCode, 200, 'other households unaffected');
  s.clock.t += 60_000;
  assert.equal((await post(s, a, { since: 0, changes: [] })).statusCode, 200, 'next minute window');
});

test('merge: new records are stored, revs are monotonic and returned to other devices only', async () => {
  const s = setup();
  const code = await newHousehold(s);
  const r1 = await post(s, code, { since: 0, changes: [rec('brew-0001', 100), rec('brew-0002', 200, { dose: 16 })] });
  assert.equal(r1.json.accepted, 2);
  assert.deepEqual(r1.json.changes, [], 'own pushes are not echoed back');
  assert.equal(r1.json.rev, 2);
  const r2 = await post(s, code, { since: r1.json.rev, changes: [rec('brew-0003', 300)] });
  assert.equal(r2.json.rev, 3);
  const other = await post(s, code, { since: 0, changes: [] });
  assert.deepEqual(other.json.changes.map((r) => r.id), ['brew-0001', 'brew-0002', 'brew-0003']);
  assert.equal(other.json.changes[1].dose, 16);
  assert.equal(other.json.rev, 3);
  const none = await post(s, code, { since: 3, changes: [] });
  assert.deepEqual(none.json.changes, []);
  assert.equal(none.json.rev, 3);
});

test('merge: a caught-up device pushing gets its new rev back without a pull query', async () => {
  const s = setup(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  s.up.log.length = 0;
  const r = await post(s, code, { since: 1, changes: [rec('brew-0002', 2)] });
  assert.equal(r.json.rev, 2);
  assert.equal(r.json.more, false);
  assert.ok(!s.up.log.some((c) => c[0] === 'ZRANGEBYSCORE'));
  // behind by one other device's write: must still pull it
  await post(s, code, { since: 2, changes: [rec('brew-0003', 3)] });
  const behind = await post(s, code, { since: 2 - 1, changes: [rec('brew-0004', 4)] });
  assert.deepEqual(behind.json.changes.map((x) => x.id), ['brew-0002', 'brew-0003']);
  assert.equal(behind.json.rev, 4);
});

test('merge: last writer wins on updatedAt; the loser gets the winning copy back', async () => {
  const s = setup();
  const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 500, { notes: 'phone' })] });
  // iPad has seen rev 1 and then edits with an OLDER clock: must lose
  const stale = await post(s, code, { since: 1, changes: [rec('brew-0001', 400, { notes: 'ipad-old' })] });
  assert.equal(stale.json.accepted, 0);
  assert.equal(stale.json.changes.length, 1, 'winning server copy is returned even though its rev is <= since');
  assert.equal(stale.json.changes[0].notes, 'phone');
  // newer edit wins
  const fresh = await post(s, code, { since: stale.json.rev, changes: [rec('brew-0001', 600, { notes: 'ipad-new' })] });
  assert.equal(fresh.json.accepted, 1);
  const read = await post(s, code, { since: 0, changes: [] });
  assert.equal(read.json.changes.length, 1);
  assert.equal(read.json.changes[0].notes, 'ipad-new');
});

test('merge: identical push is a no-op; equal updatedAt resolves deterministically in either order', async () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const s = setup();
    const code = await newHousehold(s);
    const v = { a: rec('brew-0001', 700, { notes: 'a' }), b: rec('brew-0001', 700, { notes: 'b' }) };
    await post(s, code, { since: 0, changes: [v[order[0]]] });
    await post(s, code, { since: 0, changes: [v[order[1]]] });
    const read = await post(s, code, { since: 0, changes: [] });
    assert.equal(read.json.changes[0].notes, compare(v.a, v.b) > 0 ? 'a' : 'b');
  }
  const s = setup(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const again = await post(s, code, { since: 1, changes: [rec('brew-0001', 1)] });
  assert.equal(again.json.accepted, 0);
  assert.deepEqual(again.json.changes, []);
  assert.equal(again.json.rev, 1, 'no new rev for a no-op');
  assert.equal(compare({ id: 'b', updatedAt: 5 }, { id: 'a', updatedAt: 5 }), 1, 'ties between ids break by id');
});

test('merge: duplicates inside one request collapse to the winner', async () => {
  const s = setup(); const code = await newHousehold(s);
  const r = await post(s, code, { since: 0, changes: [rec('brew-0001', 5, { n: 'old' }), rec('brew-0001', 9, { n: 'new' }), rec('brew-0001', 7, { n: 'mid' })] });
  assert.equal(r.json.accepted, 1);
  assert.equal((await post(s, code, { since: 0, changes: [] })).json.changes[0].n, 'new');
});

test('tombstones: kept, compacted, and subject to LWW (edit after delete resurrects, older edit does not)', async () => {
  const s = setup(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 100, { samples: { weight: new Array(500).fill(1) } })] });
  await post(s, code, { since: 1, changes: [rec('brew-0001', 200, { deleted: true, samples: { weight: [1, 2, 3] }, notes: 'secret' })] });
  let read = await post(s, code, { since: 0, changes: [] });
  assert.deepEqual(read.json.changes, [{ id: 'brew-0001', type: 'brew', updatedAt: 200, deleted: true }], 'envelope only');
  // an older edit from an offline device must not undelete it
  const old = await post(s, code, { since: read.json.rev, changes: [rec('brew-0001', 150, { notes: 'late' })] });
  assert.equal(old.json.accepted, 0);
  assert.equal(old.json.changes[0].deleted, true);
  // a newer edit does
  await post(s, code, { since: old.json.rev, changes: [rec('brew-0001', 300, { notes: 'back' })] });
  read = await post(s, code, { since: 0, changes: [] });
  assert.equal(read.json.changes[0].deleted, undefined);
  assert.equal(read.json.changes[0].notes, 'back');
  // deleting something the server never saw still stores a tombstone
  await post(s, code, { since: read.json.rev, changes: [{ id: 'brew-0002', type: 'brew', updatedAt: 50, deleted: true }] });
  read = await post(s, code, { since: 0, changes: [] });
  assert.ok(read.json.changes.some((r) => r.id === 'brew-0002' && r.deleted));
});

test('two devices converge through the server', async () => {
  const s = setup(); const code = await newHousehold(s);
  const A = [rec('brew-0001', 100, { v: 'A1' }), rec('brew-0002', 300, { v: 'A2' })];
  const B = [rec('brew-0001', 200, { v: 'B1' }), rec('brew-0002', 250, { v: 'B2' }), rec('brew-0003', 10, { v: 'B3' })];
  const merge = (local, incoming) => { const m = new Map(local.map((r) => [r.id, r])); for (const r of incoming) { const c = m.get(r.id); if (!c || compare(r, c) > 0) m.set(r.id, r); } return [...m.values()].sort((x, y) => (x.id < y.id ? -1 : 1)); };
  const ra = await post(s, code, { since: 0, changes: A });
  const rb = await post(s, code, { since: 0, changes: B });
  const finalA = merge(A, rb.json.changes), finalB = merge(B, []);
  const ra2 = await post(s, code, { since: ra.json.rev, changes: [] });
  const bothA = merge(finalA, ra2.json.changes);
  const bothB = merge(finalB, rb.json.changes);
  assert.deepEqual(bothA, bothB);
  assert.deepEqual(bothA.map((r) => r.v), ['B1', 'A2', 'B3']);
});

test('pull is paged: `more` and a cursor that resumes without gaps or repeats', async () => {
  const s = setup({ limits: { pageRecords: 3 } });
  const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: Array.from({ length: 8 }, (_, i) => rec(`brew-${String(i).padStart(4, '0')}`, 1000 + i)) });
  const got = []; let since = 0, pages = 0;
  for (;;) {
    const r = await post(s, code, { since, changes: [] });
    got.push(...r.json.changes.map((x) => x.id)); since = r.json.rev; pages++;
    if (!r.json.more) break;
    assert.ok(pages < 10);
  }
  assert.deepEqual(got, Array.from({ length: 8 }, (_, i) => `brew-${String(i).padStart(4, '0')}`));
  assert.equal(since, 8);
  assert.equal(pages, 3);
});

test('pull response stays under the byte budget (large records are split across pages)', async () => {
  const s = setup({ limits: { pageBytes: 50_000 } });
  const code = await newHousehold(s);
  const big = (i) => rec(`brew-${i}000`.slice(0, 9), 100 + i, { samples: { weight: new Array(5000).fill(12.34) } }); // ~30 KB each
  await post(s, code, { since: 0, changes: [0, 1, 2, 3].map(big) });
  let since = 0; const ids = []; let pages = 0;
  for (;;) {
    const r = await post(s, code, { since, changes: [] });
    assert.ok(Buffer.byteLength(r.body) < 90_000);
    ids.push(...r.json.changes.map((x) => x.id)); since = r.json.rev; pages++;
    if (!r.json.more) break;
  }
  assert.equal(ids.length, 4);
  assert.ok(pages >= 2);
});

test('limits: 1 MB request cap (declared length and actual body), per-record cap, change count', async () => {
  const s = setup(); const code = await newHousehold(s);
  const declared = await post(s, code, { since: 0, changes: [] }, { headers: { authorization: `Bearer ${code}`, 'content-length': String(2 * 1024 * 1024) } });
  assert.equal(declared.statusCode, 413);
  assert.equal(declared.json.error, 'too_large');
  const huge = await post(s, code, JSON.stringify({ since: 0, changes: [{ pad: 'x'.repeat(1024 * 1024 + 10) }] }));
  assert.equal(huge.statusCode, 413);
  const oneBig = await post(s, code, { since: 0, changes: [rec('brew-0001', 5, { pad: 'x'.repeat(LIMITS.maxRecordBytes) }), rec('brew-0002', 5)] });
  assert.equal(oneBig.statusCode, 200);
  assert.equal(oneBig.json.accepted, 1);
  assert.equal(oneBig.json.rejected.length, 1);
  assert.equal(oneBig.json.rejected[0].id, 'brew-0001');
  assert.match(oneBig.json.rejected[0].reason, /limit/);
  const many = await post(s, code, { since: 0, changes: Array.from({ length: LIMITS.maxChangesPerRequest + 1 }, (_, i) => rec(`brew-${i}xxxx`, 5)) });
  assert.equal(many.statusCode, 400);
  assert.equal(many.json.error, 'too_many_changes');
});

test('limits: household record cap (new records rejected, updates to existing still accepted)', async () => {
  const s = setup({ limits: { maxRecords: 3 } });
  const code = await newHousehold(s);
  const r = await post(s, code, { since: 0, changes: [1, 2, 3, 4, 5].map((i) => rec(`brew-000${i}`, i)) });
  assert.equal(r.json.accepted, 3);
  assert.equal(r.json.rejected.length, 2);
  assert.match(r.json.rejected[0].reason, /full/);
  const upd = await post(s, code, { since: r.json.rev, changes: [rec('brew-0001', 99, { notes: 'edit' })] });
  assert.equal(upd.json.accepted, 1);
});

test('validation: strict envelope checks report what to fix and never store the bad record', async () => {
  const s = setup(); const code = await newHousehold(s);
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
  const r = await post(s, code, { since: 0, changes: [...bad, rec('brew-0099', 5)] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.accepted, 1);
  assert.equal(r.json.rejected.length, bad.length);
  assert.ok(r.json.rejected.every((x) => typeof x.reason === 'string' && x.reason.length > 10));
  assert.equal((await post(s, code, { since: 0, changes: [] })).json.changes.length, 1);

  for (const body of ['{nope', '[]', 'null', JSON.stringify({ since: -1 }), JSON.stringify({ since: 'a' }), JSON.stringify({ since: 1.5 }),
    JSON.stringify({ changes: 'x' }), JSON.stringify({ limit: -2 })]) {
    const x = await post(s, code, body);
    assert.equal(x.statusCode, 400, body);
    assert.ok(x.json.error && x.json.message, body);
  }
});

test('since beyond the server rev signals reset (data was lost) and returns data from 0', async () => {
  const s = setup(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const r = await post(s, code, { since: 500, changes: [] });
  assert.equal(r.json.reset, true);
  assert.equal(r.json.changes.length, 1);
  assert.equal(r.json.rev, 1);
});

test('limit:0 probes the household without returning data', async () => {
  const s = setup(); const code = await newHousehold(s);
  await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  const r = await post(s, code, { since: 0, changes: [], limit: 0 });
  assert.deepEqual(r.json.changes, []);
  assert.equal(r.json.more, true);
});

test('concurrent sync is refused with 409 busy while the household lock is held, and released afterwards', async () => {
  const s = setup(); const code = await newHousehold(s);
  const lockKey = s.up.keys().find((k) => k.endsWith(':meta')).replace(':meta', ':lock');
  await s.up.fetch(s.up.url, { method: 'POST', headers: { Authorization: `Bearer ${s.up.token}` }, body: JSON.stringify(['SET', lockKey, 'other', 'PX', '8000', 'NX']) });
  const busy = await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json.error, 'busy');
  assert.equal(busy.headers['retry-after'], '1');
  assert.equal((await post(s, code, { since: 0, changes: [] })).statusCode, 200, 'reads do not need the lock');
  s.clock.t += 9000; // lock TTL passes
  assert.equal((await post(s, code, { since: 0, changes: [rec('brew-0001', 1)] })).statusCode, 200);
  assert.ok(!s.up.keys().includes(lockKey), 'lock is released after a write');
});

test('storage outage: 502 with advice, and nothing sensitive is logged', async () => {
  const s = setup(); const code = await newHousehold(s);
  s.up.state.fail = true;
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = await post(s, code, { since: 0, changes: [] });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json.error, 'storage_unavailable');
    assert.match(r.json.message, /Try again/);
  } finally { console.error = orig; }
  const text = logs.join('\n') + JSON.stringify(s.up.state);
  assert.ok(logs.length >= 1);
  assert.ok(!text.includes(code) && !text.includes(s.up.token) && !text.includes(s.up.url));
});

test('writes go out in small Redis requests', async () => {
  const s = setup({ limits: { writeBatchBytes: 20_000 } });
  const code = await newHousehold(s);
  const many = Array.from({ length: 40 }, (_, i) => rec(`brew-${String(i).padStart(4, '0')}`, 10 + i, { samples: { weight: new Array(400).fill(1.5) } }));
  s.up.state.requestBytes.length = 0;
  await post(s, code, { since: 0, changes: many });
  assert.ok(Math.max(...s.up.state.requestBytes) < 40_000, `largest Redis request ${Math.max(...s.up.state.requestBytes)}`);
  assert.equal((await post(s, code, { since: 0, changes: [], })).json.changes.length, 40);
});
