# Deploying Dot Scale on Cloudflare

Everything runs on Cloudflare: the static app and the sync API are one **Worker with static assets**, and household data is
in a **D1** (SQLite) database. No Vercel, no Redis. The app will live at **https://coffee.yaafsome.fyi**.

You (the owner) have to do the dashboard and terminal steps below; they need your Cloudflare login. Dashboard menu names
move around, so where a label differs, look for the thing named in bold. You need Node 18+ for `npx wrangler` (nothing to
install permanently).

## 1. Create the D1 database and apply the schema

```
npx wrangler login
npx wrangler d1 create dot-scale
```

The second command prints a `database_id`. Open `wrangler.jsonc` and replace `REPLACE_WITH_D1_DATABASE_ID` with it,
then commit that change to `main` (the id is not a secret). Then create the tables:

```
npx wrangler d1 migrations apply dot-scale --remote
```

No terminal? In the dashboard open **Storage & databases → D1 → dot-scale → Console**, paste the contents of
`migrations/0001_init.sql` and run it. Do this once now, and again for any future `migrations/000N_*.sql`
(deploys do not run migrations for you).

## 2. Connect the GitHub repo (Workers Builds), so pushes to `main` deploy

1. Dashboard → **Workers & Pages → Create → Import a repository** (the Git-connected Workers flow).
2. Pick `yaaf-some/dot-scale`; project/Worker name **dot-scale** (it must match `name` in `wrangler.jsonc`).
3. Production branch: `main`. Root directory: `/`. **Build command: leave empty** (there is no build step).
   Deploy command: `npx wrangler deploy` (the default).
4. Save and deploy. If the first build fails because step 1's id isn't committed yet, fix `wrangler.jsonc` and push again.

Pull requests and other branches: Workers Builds can build them as preview versions, but a preview uses the **same D1
database** as production (the binding is in `wrangler.jsonc`). Either turn non-production builds off in the Worker's
**Settings → Builds**, or treat previews as sharing production data.

## 3. Custom domain: coffee.yaafsome.fyi

`wrangler.jsonc` already declares it (`routes` with `custom_domain: true`), so the first successful deploy asks Cloudflare
to attach `coffee.yaafsome.fyi` and create its DNS record and certificate. The `yaafsome.fyi` zone must be in the same
Cloudflare account (it is). Requirements: no existing DNS record for the name `coffee` (delete a stale one first).
You can check under the Worker's **Settings → Domains & Routes**. The `dot-scale.<your-subdomain>.workers.dev` URL stays
enabled for testing; set `"workers_dev": false` later if you want it gone.

## 4. Optional but recommended: a pepper for the codes

```
npx wrangler secret put SYNC_PEPPER
```

Paste a long random string. The server then hashes household codes with it, so a leaked database alone could not be
used to guess codes offline. Do this **before** anyone creates a household; changing it later orphans existing ones.

## 5. Check it

```
curl -s -X POST https://coffee.yaafsome.fyi/api/sync
#   {"error":"missing_code",...}      -> the API is up
#   {"error":"sync_not_configured",...} -> D1 isn't bound: recheck step 1 and the id in wrangler.jsonc
curl -sI https://coffee.yaafsome.fyi/ | grep -i -E "strict|content-security|permissions|nosniff"
curl -s -o /dev/null -w "%{http_code}\n" https://coffee.yaafsome.fyi/wrangler.jsonc   # must be 404
```

Then in the app: **Settings → Sync → Create household** on one device, **Join** on another.

## Security headers (`_headers`)

HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame blocking, COOP, a Permissions-Policy that
keeps **Bluetooth for the app itself** and turns off camera, microphone, geolocation, payment, USB, serial and HID, and a CSP:
`default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.

**Assumption, with a TODO:** the current shell (`index.html`) is a single inline module script plus an inline `<style>` block
and `style=""` attributes, and loads nothing from other origins. So the CSP allows `'unsafe-inline'` for scripts and styles.
Once the new shell has no inline code (CSS in a file, external module script), remove `'unsafe-inline'` from both
directives in `_headers`. API responses set their own headers (`no-store`, `nosniff`) in `worker/handlers.js`; `_headers`
only applies to static files. `.assetsignore` keeps `.git`, `.claude`, `docs`, `test`, `scripts`, `worker`, `migrations`,
`wrangler.jsonc`, `package.json`, etc. from ever being served.

Cloudflare Access (login in front of the site) is **not** enabled: it would interrupt the installed app and Bluetooth
flows. It is an optional later step if you want the whole site private; the household code would still be needed for sync.

## Cutover from Vercel

Vercel keeps serving `dot-scale.vercel.app` until you decide otherwise; nothing here changes it (`worker/`, `migrations/`,
`wrangler.jsonc`, `_headers` and `.assetsignore` are excluded from the Vercel deploy by `.vercelignore`).

1. Do steps 1-5 and use `https://coffee.yaafsome.fyi` for a few days alongside Vercel.
2. **Browser data is per address.** Brews, settings and the saved scale permission at `dot-scale.vercel.app` are *not*
   visible at `coffee.yaafsome.fyi` (separate localStorage/IndexedDB). Before switching a device, export its data from the
   old address (History → export, once available) and import it at the new one, or create the household at the new address
   from the device with the most history and join from the others, which merges by last-writer-wins.
3. Per device: open the new address in Bluefy/Chrome, re-add it to the Home Screen (installed icons are per address),
   and reconnect the scale once (Bluetooth permission is per address too).
4. When every device has moved, replace the Vercel deployment with a redirect to the new address (or disconnect the
   Vercel Git integration and delete the project), and remove the Vercel/`.vercelignore` mentions from `CLAUDE.md`.
   Keep Vercel up for a few weeks first in case a device still has unexported data.

## What was and was NOT tested against real Cloudflare

Tested here (no Cloudflare account was available):

- `wrangler deploy --dry-run` (wrangler 4.162, installed temporarily outside the repo) bundles `worker/index.js`, reads the
  assets directory (21 KiB uploaded; the private files listed above ignored) and accepts the bindings.
- `wrangler dev --local` (workerd with a local D1 emulation): the real migration applied, `_headers` parsed ("1 valid header
  rule") and the headers came back on `/`, private paths returned 404, the real client created a household, pushed 45 large
  brews in chunks, a second device joined and converged (edit + delete), and the worker log held no codes or tokens.
- The shipped CSP in Chromium: the demo-mode smoke test passes with no CSP violations; a stricter CSP does produce violations.
- Unit tests run the same SQL on SQLite (see `docs/SYNC.md`).

**Not tested:** a real deploy; **remote D1** (latency, quotas, error behaviour, and whether `db.batch()` is atomic across
statements exactly as documented, which this design relies on); Workers Builds; custom-domain attachment and certificates;
HSTS and headers on the real edge; `CF-Connecting-IP` being present in production (rate limits fall back to one shared
"unknown" bucket without it); iPhone/iPad in Bluefy against the new origin; and the assumption that the Workers Free plan
allows 50 D1 queries per request, which is why a push is limited to 20 records (`LIMITS.maxChangesPerRequest`; raise it on
a paid plan if the first sync of a big history feels slow). The Worker is expected to work as tested but treat the first
deployment as the real test.
