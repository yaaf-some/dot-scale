// Starts household sync once the store is open (called from app/main.js). It resumes a saved household in the background;
// without one it does nothing and makes no network request. The Settings → Sync section talks to the same client.
// Sync is optional: if it cannot start, the app carries on without it.
import { createSyncClient } from './client.js';
import { syncStoreAdapter } from './store-adapter.js';

let client = null;
export const getSync = () => client;

export function startSync(store) {
  if (client) return client;
  try { client = createSyncClient({ store: syncStoreAdapter(store) }).start(); } catch (e) { console.error('sync unavailable', e); }
  return client;
}
