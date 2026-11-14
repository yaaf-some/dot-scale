// Opt-in: runs the API against a REAL redis-server (spawned locally) through a REST-protocol shim.
//   REAL_REDIS=1 node --test test/api-real-redis.test.mjs
// This validates the Redis command semantics the API relies on (NX/EX/PX, INCRBY, HMGET, ZADD, ZRANGEBYSCORE
// with exclusive bounds/WITHSCORES/LIMIT). It is not a test of Upstash itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { connect, shimFetch } from './helpers/redis-shim.mjs';
import { call } from './helpers/http.mjs';
import { createRedis } from '../api/_lib/redis.js';
import { createHouseholdHandler, createSyncHandler, hashCode } from '../api/_lib/handlers.js';

const have = process.env.REAL_REDIS === '1' && spawnSync('redis-server', ['--version']).status === 0;
const skip = have ? false : 'set REAL_REDIS=1 and install redis-server to run';
const PORT = 6400 + Math.floor(Math.random() * 500);
let proc, conn, s;
const t = 1_700_000_000_000;
const rec = (id, updatedAt, extra = {}) => ({ id, type: 'brew', updatedAt, ...extra });
const post = (code, body, opts = {}) => call(s.sync, { headers: { authorization: `Bearer ${code}` }, body, ...opts });

before(async () => {
  if (!have) return;
  proc = spawn('redis-server', ['--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !conn; i++) {
    try { conn = await connect(PORT); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const cfg = { url: 'https://redis.shim.test', token: 'tok' };
  const redis = createRedis({ ...cfg, fetch: shimFetch(conn, cfg) });
  const deps = () => ({ redis, now: () => t, limits: { pageRecords: 3, syncPerMinute: 1000 } });
  s = { household: createHouseholdHandler(deps), sync: createSyncHandler(deps), redis };
});
after(() => { conn?.close(); proc?.kill(); });

test('real redis: create, push, LWW, restamp, tombstone, paging, reset', { skip }, async () => {
  const c = await call(s.household, {});
  assert.equal(c.statusCode, 201);
  const code = c.json.code;
  const r1 = await post(code, { since: 0, changes: [1, 2, 3, 4, 5].map((i) => rec(`brew-000${i}`, 100 + i, { v: i })) });
  assert.equal(r1.json.accepted, 5);
  assert.equal(r1.json.rev, 5);

  // older loses; the winning copy is re-stamped so the loser's device pulls it
  const lose = await post(code, { since: 5, changes: [rec('brew-0001', 50, { v: 'old' })] });
  assert.equal(lose.json.accepted, 0);
  assert.equal(lose.json.changes[0].v, 1);
  const win = await post(code, { since: lose.json.rev, changes: [rec('brew-0002', 900, { v: 'new' }), { id: 'brew-0003', type: 'brew', updatedAt: 901, deleted: true, junk: 1 }] });
  assert.equal(win.json.accepted, 2);

  // a fresh device pages through everything with a cursor
  const got = new Map(); let since = 0, pages = 0;
  for (;;) {
    const r = await post(code, { since, changes: [] });
    for (const x of r.json.changes) got.set(x.id, x);
    since = r.json.rev; pages++;
    if (!r.json.more) break;
    assert.ok(pages < 10);
  }
  assert.equal(got.size, 5);
  assert.equal(got.get('brew-0002').v, 'new');
  assert.deepEqual(got.get('brew-0003'), { id: 'brew-0003', type: 'brew', updatedAt: 901, deleted: true });
  assert.ok(pages >= 2);

  const reset = await post(code, { since: 10_000, changes: [] });
  assert.equal(reset.json.reset, true);
});

test('real redis: the lock is exclusive, expires on its own and is released after a write', { skip }, async () => {
  const code = (await call(s.household, { ip: '198.51.100.9' })).json.code;
  const lk = `dot:hh:${hashCode(code)}:lock`;
  assert.equal(await s.redis.command(['SET', lk, 'x', 'PX', '300', 'NX']), 'OK');
  assert.equal((await post(code, { since: 0, changes: [rec('brew-0001', 1)] })).statusCode, 409);
  await new Promise((r) => setTimeout(r, 400)); // real PX expiry
  assert.equal((await post(code, { since: 0, changes: [rec('brew-0001', 1)] })).statusCode, 200);
  assert.equal(await s.redis.command(['EXISTS', lk]), 0);
});
