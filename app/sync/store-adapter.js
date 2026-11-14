// Adapts the app store (app/core/store.js) to the contract app/sync/client.js expects (docs/SYNC.md, "Store contract").
// The store finds local changes by `updatedAt` and tags merged-in records with `remote: true`; the client wants a cursor.
// The cursor is the newest updatedAt of the records that are really local (pushed), never of records merged in from the
// server, so a peer with a fast clock cannot hide later local edits. Limitation: an edit stamped older than the newest pushed
// local one (this device's clock set backwards) is not pushed until the next full re-push (the server triggers one with `reset`).
export function syncStoreAdapter(store) {
  const fromServer = new Map(); // id -> updatedAt of the version we merged in, so it is not pushed straight back
  return {
    async changesSince(cursor) {
      const records = (await store.changesSince(cursor)).filter((r) => fromServer.get(r.id) !== r.updatedAt);
      return { cursor: records.reduce((max, r) => Math.max(max, r.updatedAt), cursor), records };
    },
    async applyRemote(records) {
      for (const r of records) fromServer.set(r.id, r.updatedAt);
      return store.applyRemote(records);
    },
    onChange: (cb) => store.on('change', (e) => { if (!e.remote) cb(); }),
    /** Called by the client when the household changes: what came from the old one must be pushed to the new one. */
    reset: () => fromServer.clear(),
  };
}
