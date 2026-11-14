// Storage adapters for core/store.js. The store never talks to IndexedDB directly: it talks to an adapter, so the
// logic is unit-tested against the in-memory one and the browser uses the IndexedDB one.
//
// Adapter contract (all async):
//   get(id) → record | undefined          put(record)            putMany(records)
//   list(type) → records of that type (tombstones included)
//   since(ms) → every record with updatedAt > ms (tombstones included)
//   getMeta(key) / setMeta(key, value)    device-local key/value, never synced; metaEntries() → [[key, value]…]
//   clear()                               wipe records and meta

export function memoryAdapter() {
  const records = new Map();
  const meta = new Map();
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    kind: 'memory',
    persistent: false,
    async get(id) { return clone(records.get(id)); },
    async put(rec) { records.set(rec.id, clone(rec)); },
    async putMany(recs) { for (const r of recs) records.set(r.id, clone(r)); },
    async list(type) { return [...records.values()].filter((r) => r.type === type).map(clone); },
    async since(ms) { return [...records.values()].filter((r) => r.updatedAt > ms).map(clone); },
    async getMeta(key) { return clone(meta.get(key)); },
    async setMeta(key, value) { meta.set(key, clone(value)); },
    async metaEntries() { return [...meta.entries()].map(([k, v]) => [k, clone(v)]); },
    async clear() { records.clear(); meta.clear(); },
  };
}

const DB_NAME = 'dot-scale';
const DB_VERSION = 1;

const req = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (tx) => new Promise((ok, fail) => {
  tx.oncomplete = () => ok();
  tx.onabort = tx.onerror = () => fail(tx.error);
});

export async function idbAdapter(idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB is not available');
  const db = await new Promise((ok, fail) => {
    const open = idb.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      const records = d.createObjectStore('records', { keyPath: 'id' });
      records.createIndex('type', 'type');
      records.createIndex('updatedAt', 'updatedAt');
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    open.onsuccess = () => ok(open.result);
    open.onerror = () => fail(open.error);
    open.onblocked = () => fail(new Error('IndexedDB upgrade blocked by another tab'));
  });
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    kind: 'indexeddb',
    persistent: true,
    get: (id) => req(store('records').get(id)),
    async put(rec) { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(rec); await done(tx); },
    async putMany(recs) {
      const tx = db.transaction('records', 'readwrite');
      for (const r of recs) tx.objectStore('records').put(r);
      await done(tx);
    },
    list: (type) => req(store('records').index('type').getAll(type)),
    since: (ms) => req(store('records').index('updatedAt').getAll(IDBKeyRange.lowerBound(ms, true))),
    async getMeta(key) { return (await req(store('meta').get(key)))?.value; },
    async setMeta(key, value) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); await done(tx); },
    async metaEntries() { return (await req(store('meta').getAll())).map((m) => [m.key, m.value]); },
    async clear() {
      const tx = db.transaction(['records', 'meta'], 'readwrite');
      tx.objectStore('records').clear(); tx.objectStore('meta').clear();
      await done(tx);
    },
  };
}
