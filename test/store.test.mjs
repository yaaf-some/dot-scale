import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, openStore, uuid, remoteWins } from '../app/core/store.js';
import { memoryAdapter } from '../app/core/store-adapters.js';

const fresh = (t0 = 1000) => { let t = t0; const clock = () => t; clock.set = (v) => { t = v; }; return { clock, store: createStore(memoryAdapter(), { now: clock }) }; };

test('put assigns id and updatedAt, get returns the record', async () => {
  const { store } = fresh();
  const rec = await store.put({ type: 'bean', name: 'Guji' });
  assert.match(rec.id, /^[0-9a-f-]{36}$/);
  assert.equal(rec.updatedAt, 1000);
  assert.deepEqual(await store.get(rec.id), rec);
});

test('put rejects records without a type', async () => {
  await assert.rejects(fresh().store.put({ name: 'x' }), TypeError);
});

test('updatedAt never goes backwards even if the clock does', async () => {
  const { store, clock } = fresh(5000);
  const a = await store.put({ type: 'bean', name: 'a' });
  clock.set(10);
  const b = await store.put({ ...a, name: 'b' });
  assert.ok(b.updatedAt > a.updatedAt);
});

test('list filters by type, hides tombstones, newest first', async () => {
  const { store, clock } = fresh();
  const a = await store.put({ type: 'bean', name: 'a' });
  clock.set(2000); const b = await store.put({ type: 'bean', name: 'b' });
  clock.set(3000); await store.put({ type: 'gear', name: 'g' });
  assert.deepEqual((await store.list('bean')).map((r) => r.name), ['b', 'a']);
  assert.equal(await store.delete(a.id), true);
  assert.deepEqual((await store.list('bean')).map((r) => r.id), [b.id]);
  assert.equal((await store.list('bean', { includeDeleted: true })).length, 2);
});

test('delete leaves a tombstone with only the envelope, and is idempotent', async () => {
  const { store, clock } = fresh();
  const a = await store.put({ type: 'bean', name: 'secret' });
  clock.set(2000);
  await store.delete(a.id);
  const raw = await store.adapter.get(a.id);
  assert.deepEqual(raw, { id: a.id, type: 'bean', updatedAt: 2000, deleted: true });
  assert.equal(await store.get(a.id), undefined);
  assert.equal(await store.delete(a.id), false);
  assert.equal(await store.delete('missing'), false);
});

test('putting a record again after delete resurrects it (tombstone flag cleared)', async () => {
  const { store } = fresh();
  const a = await store.put({ type: 'bean', name: 'a' });
  await store.delete(a.id);
  await store.put({ ...a, name: 'a2' });
  assert.equal((await store.get(a.id)).name, 'a2');
  assert.equal((await store.adapter.get(a.id)).deleted, undefined);
});

test('update merges fields and keeps id and type', async () => {
  const { store } = fresh();
  const a = await store.put({ type: 'bean', name: 'a', roaster: 'r' });
  const b = await store.update(a.id, { name: 'b', type: 'hacked' });
  assert.deepEqual([b.id, b.type, b.name, b.roaster], [a.id, 'bean', 'b', 'r']);
  await assert.rejects(store.update('nope', {}), /no record/);
});

test('change events: one per record, with remote flag, and AbortSignal unsubscribes', async () => {
  const { store } = fresh();
  const seen = [];
  const ac = new AbortController();
  store.on('change', (e) => seen.push([e.type, e.deleted, e.remote]), { signal: ac.signal });
  const a = await store.put({ type: 'bean', name: 'a' });
  await store.delete(a.id);
  await store.applyRemote([{ id: 'r1', type: 'gear', updatedAt: 9 }]);
  ac.abort();
  await store.put({ type: 'bean', name: 'after abort' });
  assert.deepEqual(seen, [['bean', false, false], ['bean', true, false], ['gear', false, true]]);
});

test('changesSince returns records (tombstones included) newer than the cursor', async () => {
  const { store, clock } = fresh();
  const a = await store.put({ type: 'bean', name: 'a' });          // 1000
  clock.set(2000); const b = await store.put({ type: 'bean', name: 'b' });
  clock.set(3000); await store.delete(a.id);
  const ids = (await store.changesSince(1000)).map((r) => r.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.equal((await store.changesSince(3000)).length, 0);
  assert.equal((await store.changesSince(0)).length, 2);
});

test('applyRemote is last-writer-wins and keeps the remote updatedAt', async () => {
  const { store } = fresh();
  await store.adapter.put({ id: 'x', type: 'bean', name: 'local', updatedAt: 500 });
  assert.equal(await store.applyRemote([{ id: 'x', type: 'bean', name: 'older', updatedAt: 400 }]), 0);
  assert.equal((await store.get('x')).name, 'local');
  assert.equal(await store.applyRemote([{ id: 'x', type: 'bean', name: 'newer', updatedAt: 600 }]), 1);
  const x = await store.get('x');
  assert.deepEqual([x.name, x.updatedAt], ['newer', 600]);
  // a newer tombstone wins over a live local record
  await store.applyRemote([{ id: 'x', type: 'bean', updatedAt: 700, deleted: true }]);
  assert.equal(await store.get('x'), undefined);
  // new ids are inserted; malformed records are ignored
  assert.equal(await store.applyRemote([{ id: 'y', type: 'gear', updatedAt: 1 }, { id: 'z' }, null]), 1);
});

test('remoteWins: ties keep local for the same id, and the greater id wins otherwise', () => {
  assert.equal(remoteWins({ id: 'a', updatedAt: 1 }, { id: 'a', updatedAt: 1 }), false);
  assert.equal(remoteWins(undefined, { id: 'a', updatedAt: 1 }), true);
  assert.equal(remoteWins({ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }), true);
});

test('prefs persist through the adapter and reload via openStore', async () => {
  const adapter = memoryAdapter();
  const s1 = await openStore({ adapter });
  assert.equal(s1.prefs.get('theme', 'system'), 'system');
  await s1.prefs.set('theme', 'dark');
  const s2 = await openStore({ adapter });
  assert.equal(s2.prefs.get('theme'), 'dark');
});

test('openStore falls back to memory when IndexedDB is unavailable', async () => {
  const s = await openStore({ indexedDB: undefined });
  assert.equal(s.persistent, false);
  assert.ok(s.openError);
  await s.put({ type: 'bean', name: 'still works' });
  assert.equal((await s.list('bean')).length, 1);
});

test('clearAll wipes records, meta and prefs', async () => {
  const { store } = fresh();
  await store.put({ type: 'bean', name: 'a' });
  await store.prefs.set('theme', 'dark');
  await store.clearAll();
  assert.equal((await store.list('bean')).length, 0);
  assert.equal(store.prefs.get('theme'), undefined);
});

test('uuid looks like a v4 uuid', () => assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));

test('applyRemote: the newest version of an id wins regardless of order within a batch', async () => {
  const { store } = fresh();
  await store.adapter.put({ id: 'x', type: 'bean', name: 'local', updatedAt: 50 });
  await store.applyRemote([{ id: 'x', type: 'bean', name: 'new', updatedAt: 200 }, { id: 'x', type: 'bean', name: 'old', updatedAt: 100 }]);
  assert.equal((await store.get('x')).name, 'new');
});
