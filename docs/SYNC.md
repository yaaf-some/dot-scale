# Household sync: owner guide

Sync lets the household's iPhones and iPads share profiles, beans, recipes and brews. It is local-first: the app works
fully offline and syncs in the background. There are no accounts; a **household code** such as `maple-tiger-orbit-4271`
is the only secret.

**Until you do the one-time setup below, sync is simply off.** The app shows "Sync not set up" and keeps working on
each device.

## One-time setup (the owner has to do this)

You add an Upstash Redis database to the Vercel project. It takes about two minutes and the free plan is enough.

1. Open the Vercel dashboard → the **dot-scale** project → **Storage** tab.
2. Choose **Create Database** (or **Browse Marketplace**) → **Upstash** → **Upstash for Redis**. Pick the free plan and
   a region near you, then create it. (Vercel's menu labels move around; what you want is an Upstash *Redis* database.)
3. When asked, **connect it to the dot-scale project** for Production (Preview too if you test on preview URLs).
4. Vercel adds these environment variables to the project. Nothing to copy by hand:
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN` (used by the app)
   - `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL` (added by the integration; unused)
   - If you create the database on upstash.com instead, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
     yourself; the API accepts either naming scheme.
5. **Redeploy** (Deployments → the latest → ⋯ → Redeploy). Environment variables only reach new deployments.
6. Check it from a terminal:
   ```
   curl -s -X POST https://dot-scale.vercel.app/api/sync
   ```
   - `{"error":"missing_code",...}` → sync is set up.
   - `{"error":"sync_not_configured",...}` → the variables are missing or not on this deployment; redo steps 3 and 5.
   - A 404 page → the `api/` folder is not deployed (this PR isn't merged to the deployed branch).

Then, in the app: **Settings → Sync → Create household**, and note the code. On the other devices: **Join household**
and type the code.

Optional hardening: set `SYNC_PEPPER` to a long random string **before creating any household**. The server then hashes
codes with that secret, so even a leaked database could not be used to guess codes offline. Changing it later orphans
existing households.

## How it works

- `POST /api/household` creates a household and returns `{ code }`. Code = 3 words from a 256-word list + 4 digits
  (about 37 bits), generated with `crypto.randomInt`. Only an HMAC-SHA256 of the code is stored.
- `POST /api/sync` with `Authorization: Bearer <code>` and `{ since, changes }` merges the pushed records and returns
  `{ rev, changes, more, accepted, rejected, reset }`.
  - **Merge:** per record, last-writer-wins on `updatedAt` (ties: id, then canonical JSON so it is deterministic).
    Deletes are tombstones (`deleted: true`); the server keeps only their envelope.
  - **rev** is a household counter (`INCRBY`). Every accepted change gets a new rev; `since` is "the last rev I have".
    If a pushed record *loses*, the server re-stamps its winning copy with a new rev, so the pusher pulls it.
  - **Paging:** responses are capped (200 records / ~700 KB). While `more` is true, call again with `since = rev`.
  - **`reset: true`** means the server's data was lost (its rev is below your `since`). The client re-pushes everything.
  - **`rejected`** lists records the server refused (invalid envelope, over 256 KB, household full) with a reason.
  - `limit: 0` is a cheap "is this code valid?" probe, used when joining.
- Writers take a short per-household Redis lock (`SET NX PX`). A second device pushing at the same instant gets `409 busy`
  and retries a second later. Pull-only syncs don't lock. The lock is best-effort (no Lua/WATCH over REST); the worst
  case if it ever expires mid-write is a stale merge decision that the next edit corrects.

## Limits and protections

| What | Limit |
| --- | --- |
| Request body | 1 MB (the client pushes in ≤256 KB chunks) |
| One record | 256 KB (a very long brew curve); bigger ones are skipped and counted in the status |
| Records per request | 500 |
| Records per household | 20,000 (tombstones count) |
| Requests per household | 120 per minute → `429` with `Retry-After` |
| Wrong codes per caller IP | 10 per 10 minutes, then everything from that IP is refused for a while |
| Household creation | 5 per hour per IP |

Codes and tokens are never logged. Errors are JSON `{ error, message }`; the `message` says what to do.
Device clocks matter: `updatedAt` more than a day in the future is rejected, so a wrong clock can't win forever.
Small clock drift just means the later-clocked edit wins.

Cost: a pull-only sync is about 8 Redis commands, a push about 15 plus 2 per record. There is no background polling by
default; a device syncs on start, after edits (1.5 s debounce), when it comes back online, and when the tab becomes
visible. Check your Upstash plan's command quota if you add polling (`pollMs`).

## Store contract (for the app's IndexedDB store)

`app/sync/client.js` expects the store to provide:

- `changesSince(cursor) → Promise<{ cursor, records }>`: records written **locally** (including tombstones) after `cursor`
  (`0` = all). `cursor` is any monotonic number the store likes, such as a local write sequence. Return the *whole* records.
- `applyRemote(records) → Promise<void>`: merge records from the server. Last-writer-wins on `updatedAt`, ties by id.
  Idempotent. Must **not** show up in `changesSince` afterwards (otherwise every pull echoes back), and should not fire `onChange`.
  Tombstones from the server contain only `{ id, type, updatedAt, deleted: true }`.
- `onChange(cb) → unsubscribe` (optional): called after local writes. Without it, call `client.notifyChange()` yourself.

Using it from the UI:

```js
import { createSyncClient } from './app/sync/client.js';
const sync = createSyncClient({ store });   // endpoint defaults to /api
sync.start();                                // resumes a saved household, or probes whether sync is available
sync.onStatus((s) => { el.textContent = s.label; });  // "Synced 2 min ago" | "Offline" | "Sync not set up" | "Sync off" | ...
await sync.createHousehold();                // → { code }; show it to the user
await sync.joinHousehold(typedCode);         // throws SyncError with a message to show
sync.syncNow(); sync.leaveHousehold(); sync.getHouseholdCode();
```

`status` = `{ state, label, lastSyncedAt, retryAt, error, skipped }`, state ∈ `off | idle | syncing | synced | offline | error | unavailable`.
`label` is computed when read; call `formatStatus(status, Date.now())` on a timer to keep "2 min ago" fresh.
The household code and sync cursors are kept in `localStorage` under `dot.sync`.

Joining a household pushes this device's existing records into it (merged by last-writer-wins). Leaving keeps all local data.

## What was and wasn't tested

- `npm test`: API handlers against an **in-memory fake of the Upstash REST API**, and the client against a fake `fetch`,
  fake timers and a fake store (including two clients converging, offline, retry/backoff, chunking).
- `REAL_REDIS=1 node --test test/api-real-redis.test.mjs`: the same API code against a **real local `redis-server`** through
  a small REST-protocol shim, to check the Redis command semantics (NX/EX/PX, INCRBY, HMGET, ZADD, ZRANGEBYSCORE).
- **Not tested:** Upstash itself (its HTTP layer, quotas, latency) and the Vercel runtime. Verify on a preview deployment
  after setup: create a household on one device, join from another, edit on both.
