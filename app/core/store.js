// Local-first record store (PRODUCT.md §6).
//
// Every record is an envelope { id, type, updatedAt, deleted?, ...fields }. Deletes are tombstones, so they can sync.
// The store is async and adapter-backed (see store-adapters.js). It also keeps small *device-local* preferences
// (`store.prefs`: active profile, theme, "onboarded"…) that are never synced.
//
// Sync hooks (for app/sync):
//   store.changesSince(ms)        → every record, tombstones included, with updatedAt > ms
//   store.applyRemote(records)    → last-writer-wins merge; keeps the remote updatedAt; emits `change` with remote:true
//   store.on('change', fn)        → fn({ type, id, record, deleted, remote })  (one event per record)
import { Emitter } from './events.js';
import { idbAdapter, memoryAdapter } from './store-adapters.js';

export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

/** Last-writer-wins on updatedAt. On an exact tie the record with the greater id wins (ids are equal for the same record, so local stays). */
export function remoteWins(local, remote) {
  if (!local) return true;
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt;
  return remote.id > local.id;
}

export function createStore(adapter, { now = Date.now } = {}) {
  const events = new Emitter();
  const prefCache = new Map();

  const emitChange = (record, remote) =>
    events.emit('change', { type: record.type, id: record.id, record, deleted: !!record.deleted, remote });

  const stamp = (prev) => Math.max(now(), (prev?.updatedAt ?? 0) + 1);

  const store = {
    adapter,
    get persistent() { return adapter.persistent; },
    on: events.on.bind(events),

    /** One record, or undefined if missing or deleted. */
    async get(id) {
      const rec = await adapter.get(id);
      return rec && !rec.deleted ? rec : undefined;
    },

    /** All live records of a type, newest update first. `includeDeleted` is for sync/debug only. */
    async list(type, { includeDeleted = false } = {}) {
      const recs = await adapter.list(type);
      return recs.filter((r) => includeDeleted || !r.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** Create or replace a record. Assigns id and updatedAt; never lets updatedAt go backwards. */
    async put(input) {
      if (!input || typeof input.type !== 'string' || !input.type) throw new TypeError('record needs a type');
      const prev = input.id ? await adapter.get(input.id) : undefined;
      const rec = { ...input, id: input.id || uuid(), updatedAt: stamp(prev) };
      delete rec.deleted;
      await adapter.put(rec);
      emitChange(rec, false);
      return rec;
    },

    /** Merge fields into an existing record. */
    async update(id, patch) {
      const prev = await store.get(id);
      if (!prev) throw new Error(`no record ${id}`);
      return store.put({ ...prev, ...patch, id, type: prev.type });
    },

    /** Tombstone a record. Fields are dropped, only the envelope stays. */
    async delete(id) {
      const prev = await adapter.get(id);
      if (!prev || prev.deleted) return false;
      const rec = { id, type: prev.type, updatedAt: stamp(prev), deleted: true };
      await adapter.put(rec);
      emitChange(rec, false);
      return true;
    },

    changesSince: (ms = 0) => adapter.since(ms),

    /** Merge records from the server. Returns how many were applied. */
    async applyRemote(records) {
      const applied = [];
      for (const remote of records ?? []) {
        if (!remote?.id || !remote.type || typeof remote.updatedAt !== 'number') continue;
        const local = await adapter.get(remote.id);
        if (remoteWins(local, remote)) applied.push(remote);
      }
      if (applied.length) await adapter.putMany(applied);
      for (const r of applied) emitChange(r, true);
      return applied.length;
    },

    /** Device-local preferences (not synced). get() is sync once loaded; set() persists. */
    prefs: {
      get(key, fallback) { return prefCache.has(key) ? prefCache.get(key) : fallback; },
      async set(key, value) {
        prefCache.set(key, value);
        await adapter.setMeta(`pref:${key}`, value);
        events.emit('pref', { key, value });
      },
    },

    async getMeta(key) { return adapter.getMeta(key); },
    async setMeta(key, value) { return adapter.setMeta(key, value); },

    async clearAll() {
      await adapter.clear(); prefCache.clear();
      events.emit('reset', {});
    },

    /** Warm the pref cache from the adapter. Called by openStore(). */
    async loadPrefs() {
      for (const [k, v] of await adapter.metaEntries()) if (k.startsWith('pref:')) prefCache.set(k.slice(5), v);
    },
  };
  return store;
}

/** Open IndexedDB, or fall back to memory (private mode, blocked storage) and say so via store.persistent. */
export async function openStore({ indexedDB = globalThis.indexedDB, adapter } = {}) {
  let a = adapter;
  let error;
  if (!a) {
    try { a = await idbAdapter(indexedDB); } catch (e) { error = e; a = memoryAdapter(); }
  }
  const store = createStore(a);
  await store.loadPrefs();
  store.openError = error;
  return store;
}
