// The adapter between the app store (app/core/store.js) and the sync client contract (docs/SYNC.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/core/store.js';
import { memoryAdapter } from '../app/core/store-adapters.js';
import { syncStoreAdapter } from '../app/sync/store-adapter.js';

const make = () => {
  const clock = { t: 1_000_000 };
  const store = createStore(memoryAdapter(), { now: () => clock.t });
  return { clock, store, adapter: syncStoreAdapter(store) };
};

test('changesSince returns {cursor, records}: new and changed records once, tombstones included, cursor = newest updatedAt', async () => {
  const { clock, store, adapter } = make();
  const a = await store.put({ type: 'bean', name: 'Guji' });
  clock.t += 10;
  const b = await store.put({ type: 'bean', name: 'Yirg' });
  let r = await adapter.changesSince(0);
  assert.deepEqual(r.records.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal(r.cursor, b.updatedAt);
  r = await adapter.changesSince(r.cursor);
  assert.deepEqual(r.records, [], 'nothing new');
  assert.equal(r.cursor, b.updatedAt, 'cursor does not move backwards');
  clock.t += 10;
  await store.delete(a.id);
  r = await adapter.changesSince(b.updatedAt);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].deleted, true, 'tombstones are pushed too');
  assert.ok(r.cursor > b.updatedAt);
});

test('records merged in from the server are not pushed straight back, but a newer local edit still is', async () => {
  const { clock, store, adapter } = make();
  const remote = { id: 'bean-from-server', type: 'bean', name: 'Remote', updatedAt: clock.t + 5 };
  await adapter.applyRemote([remote]);
  assert.equal((await store.get(remote.id)).name, 'Remote');
  let r = await adapter.changesSince(0);
  assert.deepEqual(r.records, [], 'no echo of what the server just sent');
  assert.equal(r.cursor, 0, 'the cursor does not move for records that came from the server');
  clock.t += 100;
  await store.update(remote.id, { name: 'Edited here' });
  r = await adapter.changesSince(0);
  assert.deepEqual(r.records.map((x) => x.name), ['Edited here']);
});

test('a remote record that loses to a newer local one does not hide the local one', async () => {
  const { clock, store, adapter } = make();
  const local = await store.put({ type: 'bean', name: 'Local newer' });
  await adapter.applyRemote([{ id: local.id, type: 'bean', name: 'Remote older', updatedAt: local.updatedAt - 1 }]);
  assert.equal((await store.get(local.id)).name, 'Local newer');
  assert.deepEqual((await adapter.changesSince(0)).records.map((x) => x.name), ['Local newer']);
});

test('onChange fires for local writes only, not for merged-in records; returns an unsubscribe', async () => {
  const { store, adapter } = make();
  let n = 0;
  const off = adapter.onChange(() => { n++; });
  await store.put({ type: 'bean', name: 'Local' });
  assert.equal(n, 1);
  await adapter.applyRemote([{ id: 'r1', type: 'bean', name: 'Remote', updatedAt: 5 }]);
  assert.equal(n, 1, 'remote merges do not count as local changes');
  off();
  await store.put({ type: 'bean', name: 'After unsubscribe' });
  assert.equal(n, 1);
});

test('a record from a peer with a fast clock does not hide later local edits', async () => {
  const { clock, store, adapter } = make();
  await adapter.applyRemote([{ id: 'from-the-future', type: 'bean', name: 'Fast clock', updatedAt: clock.t + 3_600_000 }]); // stamped an hour ahead
  const first = await adapter.changesSince(0);
  assert.deepEqual(first.records, []);
  clock.t += 50;
  const mine = await store.put({ type: 'bean', name: 'Made here, now' }); // stamped now: far below the peer's record
  const r = await adapter.changesSince(first.cursor);
  assert.deepEqual(r.records.map((x) => x.id), [mine.id], 'the local edit is still found');
  assert.equal(r.cursor, mine.updatedAt);
});

test('reset() forgets what came from the server, so a new household gets everything', async () => {
  const { store, adapter } = make();
  await adapter.applyRemote([{ id: 'r1', type: 'bean', name: 'From household A', updatedAt: 5 }]);
  assert.deepEqual((await adapter.changesSince(0)).records, []);
  adapter.reset();
  assert.deepEqual((await adapter.changesSince(0)).records.map((x) => x.id), ['r1'], 'now pushed to the next household');
  assert.equal((await store.get('r1')).name, 'From household A');
});
