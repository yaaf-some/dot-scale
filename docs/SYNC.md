# Household sync

Sync lets the household's iPhones and iPads share profiles, beans, recipes and brews. It is local-first: the app works
fully offline and syncs in the background. There are no accounts; a **household code** such as `maple-tiger-orbit-river-4271`
is the only secret.

Until the Cloudflare side is set up (`docs/DEPLOY.md`: the D1 database and its migration, and the `SYNC_PEPPER` secret), sync is simply
off. The app shows "Sync not set up" and keeps working on each device.

## Where things live

| Piece | File |
| --- | --- |
| Worker entry: routes `/api/*`, everything else is static assets | `worker/index.js` |
| API handlers, plain `(Request, deps) → Response`, no framework | `worker/handlers.js` |
| Record envelope validation and last-writer-wins order | `worker/records.js` |
| **Storage adapter (the only file that knows the database)** | `worker/storage.js` |
| Database schema | `migrations/0001_init.sql` |
| Browser client (create/join, background sync, status) | `app/sync/client.js` |
| Household code format, shared by the client and the Worker | `app/sync/code.js` |

### The storage adapter

`worker/storage.js` exports `createD1Storage(db)`, which implements eight small functions:
`gate`, `createHousehold`, `hit` (rate-limit counter), `purgeExpired`, `recordCount`, `existingIds`, `merge`, `changesSince`
(signatures are in the file's header comment). To run on another database, reimplement those eight; handlers don't change.
Cloudflare **D1** is used rather than KV because sync needs a strictly increasing per-household `rev`, and KV is
eventually consistent. `merge` is one D1 `batch()` (a transaction), so two devices syncing at the same moment can't
interleave.

## How it works

- `POST /api/household` creates a household and returns `{ code }`. Code = **4 words from a 256-word list + 4 digits =
  32 + 13.3 = 45.3 bits of entropy** (about 3.5 × 10¹³ possibilities), generated with WebCrypto and easy to read aloud. Older 3-word
  codes (37 bits) are still accepted so existing households keep working, but are no longer generated. Only an HMAC-SHA256 of the
  code, keyed with the `SYNC_PEPPER` secret, is stored.
- `POST /api/sync` with `Authorization: Bearer <code>` and `{ since, changes }` merges the pushed records and returns
  `{ rev, changes, more, accepted, rejected, reset }`.
  - **Merge:** per record, last-writer-wins on `updatedAt`. Ties: id, then canonical JSON compared as UTF-8 bytes (the same order SQLite uses), so it is deterministic.
    Deletes are tombstones (`deleted: true`); the server keeps only their envelope.
  - **rev** is a per-household counter. Every accepted change gets a new rev; `since` is "the last rev I have". Revs can
    have gaps (the server reserves a range per push); only the order matters.
    If a pushed record *loses*, the server re-stamps its winning copy with a new rev, so the pusher pulls it.
  - **Paging:** responses are capped (100 records / ~700 KB). While `more` is true, call again with `since = rev`.
  - **`reset: true`** means the server's data was lost (its rev is below your `since`). The client re-pushes everything.
  - **`rejected`** lists records the server refused (invalid envelope, over 256 KB, household full) with a reason.
  - `limit: 0` is a cheap "is this code valid?" probe, used when joining. A request with **no** `Authorization` header
    never touches the database; the client uses that to detect "sync not set up".

## Limits and protections

| What | Limit |
| --- | --- |
| Request body | 1 MB (the client pushes in chunks of at most 15 records / 256 KB) |
| Records per request | 15 (about 3 D1 statements per record + ~6, so at most 38 in the worst case measured; the Workers **Free** plan's per-invocation query budget is assumed to be 50) |
| One record | 256 KB (a very long brew curve); bigger ones are skipped and counted in the status |
| Records per household | 20,000 (tombstones count) |
| Requests per household | 120 per minute → `429` with `Retry-After` |
| Wrong codes per caller IP | 10 per 10 minutes, then everything from that IP is refused for a while. The IP is `CF-Connecting-IP` only (set by Cloudflare); `X-Forwarded-For` is client-controlled and ignored |
| Household creation | 5 per hour per IP |

Authentication and the rate limits run before the request body is read. Codes and tokens are never logged. Errors are JSON `{ error, message }`; the `message` says what to do. Device clocks
matter: `updatedAt` more than a day in the future is rejected, so a wrong clock can't win forever. Small drift just
means the later-clocked edit wins. The code is the only thing protecting a household, and this code is public, so protection rests on its entropy (45.3 bits), the
rate limits above, and the hashing: **`SYNC_PEPPER` is a required secret** (at least 32 characters, set with
`npx wrangler secret put SYNC_PEPPER`, never committed; see DEPLOY.md). Without it the hash key would be public and a leaked
database could be brute-forced offline, so the Worker refuses to run: `/api/household` and `/api/sync` answer the 503
`sync_not_configured` with a message telling the owner what to do, and the app shows "Sync not set up". Changing the pepper later
orphans existing households. Cloudflare's own
rate-limiting rules (dashboard) can be added in front as defence in depth.

A device syncs on start, after edits (1.5 s debounce, at most 15 s under continuous edits), when it comes back online,
and when the tab becomes visible. There is no background polling by default (`pollMs` option) to keep D1 usage tiny.

## Store contract (for the app's IndexedDB store)

`app/sync/client.js` expects the store to provide:

- `changesSince(cursor) → Promise<{ cursor, records }>`: records written **locally** (including tombstones) after `cursor`
  (`0` = all). `cursor` is any monotonic number the store likes, such as a local write sequence. Return the *whole* records.
- `applyRemote(records) → Promise<void>`: merge records from the server. Last-writer-wins on `updatedAt`, ties by id.
  Idempotent. Must **not** show up in `changesSince` afterwards (otherwise every pull echoes back), and should not fire
  `onChange`. Tombstones from the server contain only `{ id, type, updatedAt, deleted: true }`.
- `onChange(cb) → unsubscribe` (optional): called after local writes. Without it, call `client.notifyChange()` yourself.

**It is wired into the app.** `app/main.js` calls `startSync(store)` (`app/sync/boot.js`) after the store opens; that wraps the app
store with `app/sync/store-adapter.js` (the store finds local changes by `updatedAt`, so the cursor is the newest `updatedAt` pushed;
records merged in from the server are remembered so they are not pushed back). **Settings → Sync** (`app/sync/settings-section.js`)
lets the user create or join a household, see the status, sync now, show/hide the code and leave. Without a household the app makes
no sync request at all until Settings → Sync is opened (it then checks whether a server is set up). Known limitation: because the
cursor is an `updatedAt`, an edit stamped older than the newest pushed one (a device clock set backwards) is not pushed until the
next full re-push, which the server triggers with `reset`.

Using the client directly:

```js
import { createSyncClient } from './app/sync/client.js';
const sync = createSyncClient({ store });   // endpoint defaults to /api
sync.start();                                // resumes a saved household; makes no request without one
await sync.probe();                          // is a configured server there? sets "Sync not set up" if not
sync.onStatus((s) => { el.textContent = s.label; });  // "Synced 2 min ago" | "Offline" | "Sync not set up" | "Sync off" | ...
await sync.createHousehold();                // → { code }; show it to the user
await sync.joinHousehold(typedCode);         // throws SyncError with a message to show
sync.syncNow(); sync.leaveHousehold(); sync.getHouseholdCode();
```

`status` = `{ state, label, lastSyncedAt, retryAt, error, skipped }`, state ∈ `off | idle | syncing | synced | offline | error | unavailable`.
`label` is computed when read; call `formatStatus(status, Date.now())` on a timer to keep "2 min ago" fresh.
The household code and sync cursors are kept in `localStorage` under `dot.sync`.

Joining a household pushes this device's existing records into it (merged by last-writer-wins). Leaving keeps all local data.

## Tests and what they do and don't prove

`npm test` needs **Node 22.13+** (it uses the built-in `node:sqlite`).

- `test/worker.test.mjs` runs the real handlers, the real `worker/storage.js` and the real `migrations/*.sql` on an
  **in-memory SQLite** behind a small D1-API shim (`test/helpers/d1-sqlite.mjs`). SQLite is the engine D1 is built on,
  so the merge SQL is genuinely exercised: LWW, tombstones, atomic batches, concurrency, paging, limits, rate limits,
  auth, validation, no secrets in logs/storage, the D1 statement budget, and the hosting config.
- `test/sync-client.test.mjs` runs the client against that server with a fake network, fake timers and a fake store:
  offline, backoff, retries, 429, chunking, restart, server data loss, two devices converging.
- **Not tested here:** real Cloudflare D1 (network, latency, quotas, its exact error behaviour), Workers Builds, and the
  production edge. See `docs/DEPLOY.md` for exactly what was and wasn't checked.
