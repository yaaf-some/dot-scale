// Adapts the app store (app/core/store.js) to the contract app/sync/client.js expects (docs/SYNC.md, "Store contract").
// The store finds local changes by `updatedAt` and tags merged-in records with `remote: true`; the client wants a cursor.
// Limitation: the cursor is the newest updatedAt pushed, so an edit stamped *older* than that (a device clock set backwards)
// is not pushed until the next full re-push (which happens when the server reports a reset).
export function syncStoreAdapter(store) {
  const fromServer = new Map(); // id -> updatedAt of the version we merged in, so it is not pushed straight back
  return {
    async changesSince(cursor) {
      const all = await store.changesSince(cursor);
      return {
        cursor: all.reduce((max, r) => Math.max(max, r.updatedAt), cursor),
        records: all.filter((r) => fromServer.get(r.id) !== r.updatedAt),
      };
    },
    async applyRemote(records) {
      for (const r of records) fromServer.set(r.id, r.updatedAt);
      return store.applyRemote(records);
    },
    onChange: (cb) => store.on('change', (e) => { if (!e.remote) cb(); }),
  };
}
