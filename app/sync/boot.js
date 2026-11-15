// Starts household sync (called from app/main.js). The sync client is ~20 KB and most devices never use it, so it is loaded
// on demand: right away in the background when this device already has a household saved, or when Settings → Sync opens.
// Without a household it makes no network request. Sync is optional: if it cannot start, the app carries on without it.
let client = null, loading = null;
export const getSync = () => client;

// The client keeps its household in localStorage (see STORAGE_KEY in client.js); peek without loading the client.
function hasSavedHousehold() {
  try { return !!JSON.parse(globalThis.localStorage?.getItem('dot.sync'))?.code; } catch { return false; }
}

/** Loads and starts the client (once). Resolves with it, or null when sync is unavailable. */
export function loadSync(store) {
  return (loading ??= Promise.all([import('./client.js'), import('./store-adapter.js')])
    .then(([{ createSyncClient }, { syncStoreAdapter }]) => (client = createSyncClient({ store: syncStoreAdapter(store) }).start()))
    .catch((e) => { console.error('sync unavailable', e); return null; }));
}

export function startSync(store) {
  if (hasSavedHousehold()) loadSync(store);
}
