# Hosting Dot Scale on Cloudflare (replacing Vercel)

The app is plain static files, so it is served as a **Cloudflare Worker with static assets** straight from this repo: no
build step and no Worker code yet. Pushes to `main` deploy automatically through **Workers Builds**. The site will be at
**https://coffee.yaafsome.fyi**.

You (the owner) have to do the dashboard steps below; they need your Cloudflare login. Dashboard labels move around, so
where one differs, look for the thing named in **bold**.

Facts this is written for: the `yaafsome.fyi` zone is active on the Cloudflare Free plan, the account has no Workers yet,
and the only DNS record is a CNAME `coffee` pointing at a `vercel-dns.com` name (DNS only). That record is why the order
of steps 4-5 matters.

## 1. Merge this PR

It adds `wrangler.jsonc` (the Worker + assets config), `.assetsignore` (what is never served: `.git`, `.claude`, `docs`,
`test`, `scripts`, `package.json`, ...), `_headers` (security headers) and this guide. Vercel keeps deploying `main`
exactly as before (`.vercelignore` excludes the new files), so merging changes nothing for visitors yet.

## 2. Connect the GitHub repo (Workers Builds)

1. Dashboard → **Workers & Pages → Create → Import a repository** (the Git-connected Workers flow). Authorize the
   Cloudflare GitHub app for `yaaf-some/dot-scale` if asked.
2. Worker name: **dot-scale** (it must match `name` in `wrangler.jsonc`).
3. Production branch: `main`. Root directory: `/`. **Build command: leave empty.** Deploy command: `npx wrangler deploy`
   (the default).
4. Save and deploy. Pushes to `main` now deploy automatically.

Pull requests: Workers Builds can also build other branches as preview versions (off by default for some setups; see the
Worker's **Settings → Builds**). Previews are optional.

## 3. Test on the workers.dev address first

After the first deploy, open the `dot-scale.<your-subdomain>.workers.dev` URL shown on the Worker's page in Chrome (or
Bluefy on iPhone/iPad), press **Demo**, and check the app works. Vercel is still serving `coffee.yaafsome.fyi`, so nothing
is at risk. Check the security headers and that private files are not served:

```
curl -sI https://dot-scale.<your-subdomain>.workers.dev/ | grep -i -E "strict|content-security|permissions|nosniff"
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/wrangler.jsonc   # must be 404
```

## 4. Cutover: move coffee.yaafsome.fyi from Vercel to Cloudflare

Cloudflare's Worker custom domain creates its **own** DNS record for the name, so the old Vercel CNAME has to go first or
it conflicts (the attach fails with a message about existing DNS records). Do these in one sitting, in this order:

1. **Write down** the current record: Cloudflare dashboard → `yaafsome.fyi` → **DNS → Records** → the CNAME `coffee`
   (its target, a `vercel-dns.com` name, DNS only). You need it only if you roll back.
2. **Delete** that CNAME. From this moment `coffee.yaafsome.fyi` is down until step 3 finishes
   (`dot-scale.vercel.app` keeps working).
3. Dashboard → **Workers & Pages → dot-scale → Settings → Domains & Routes → Add → Custom domain** →
   `coffee.yaafsome.fyi` → Add. Cloudflare creates the DNS record and a certificate; this usually takes a minute or a few.
4. Check: open https://coffee.yaafsome.fyi, repeat the header and 404 checks from step 3 against it.

If a later deploy ever drops the domain (the config file doesn't mention it), pin it in `wrangler.jsonc` by adding
`"routes": [{ "pattern": "coffee.yaafsome.fyi", "custom_domain": true }]` (the file has the snippet in a comment).
Only add it after step 2, otherwise the deploy fails on the DNS conflict.

**Rollback:** remove the custom domain from the Worker, then re-create the CNAME `coffee` with the target you wrote down
(DNS only). Vercel serves it again as long as the Vercel project still exists, so do the cleanup below only after a few
days of everything working.

### Browser data and the new address

Browsers keep data **per address** (origin). If your devices already use `https://coffee.yaafsome.fyi`, the address
doesn't change, so saved brews, settings and the home-screen icon carry over. Any device still using
`https://dot-scale.vercel.app` has data there that will **not** appear at `coffee.yaafsome.fyi`: export it first (History
→ export, where available) and import it at the new address, then re-add the home-screen icon there. The scale's
Bluetooth permission is also per address; if the scale doesn't reconnect, press Connect and pick it again.

## 5. Clean up Vercel (after a few days of Cloudflare working)

1. In the Vercel project → **Settings → Domains**: remove `coffee.yaafsome.fyi` (and the project's other domains if you want).
2. **Settings → Git**: disconnect the GitHub repository (this also stops the Vercel bot comments on PRs).
3. **Settings → General → Delete Project** at the bottom, once you are sure you don't want to roll back.
4. In the repo, delete `.vercelignore` and remove the Vercel mentions in `README.md` and `CLAUDE.md` (the live URL becomes
   https://coffee.yaafsome.fyi). Ask Claude to do this in a small PR; it is safe only after steps 1-3.

## 6. Household sync (D1)

Sync is optional and separate from hosting: until you do this, the app shows "Sync not set up" and works locally. The Worker
(`worker/`) serves `/api/*`; household data lives in a **D1** (SQLite) database. Details: `docs/SYNC.md`.

1. Create the database and note its id:
   ```
   npx wrangler login
   npx wrangler d1 create dot-scale
   ```
   Put the printed `database_id` into `wrangler.jsonc` (replacing `REPLACE_WITH_D1_DATABASE_ID`) and commit it to `main`
   (the id is not a secret). **Do this before merging the sync PR, or its first deploy fails.**
2. Create the tables: `npx wrangler d1 migrations apply dot-scale --remote`. No terminal? Dashboard →
   **Storage & databases → D1 → dot-scale → Console**, paste `migrations/0001_init.sql`, run. Repeat for any later
   `migrations/000N_*.sql` (deploys do not run migrations).
3. Optional, recommended **before anyone creates a household**: `npx wrangler secret put SYNC_PEPPER` and paste a long random
   string. The server then hashes household codes with it, so a leaked database alone can't be used to guess codes. Changing
   it later orphans existing households.
4. Check: `curl -s -X POST https://coffee.yaafsome.fyi/api/sync` returns `{"error":"missing_code",...}` when the API is up
   (`sync_not_configured` means D1 isn't bound: recheck the id). Then in the app: **Settings → Sync → Create household**, and
   **Join** from the other device.

Previews: a Workers Builds preview of another branch uses the **same D1 database** as production (the binding is in
`wrangler.jsonc`); turn preview builds off or accept shared data.

## Security headers (`_headers`)

HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame blocking, COOP, a Permissions-Policy that
keeps **Bluetooth for the app itself** and turns off camera, microphone, geolocation, payment, USB, serial and HID, and a CSP:
`default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.

**Assumption, with a TODO:** the current shell (`index.html`) is a single inline module script plus an inline `<style>`
block and `style=""` attributes, and loads nothing from other origins. So the CSP allows `'unsafe-inline'` for scripts and
styles. Once the new app shell has no inline code (CSS in a file, an external module script), remove `'unsafe-inline'` from
both directives in `_headers`. Keep `connect-src 'self'` unless the app needs another origin.

Cloudflare Access (a login in front of the site) is **not** enabled: it would interrupt the installed app and the
Bluetooth flow. It is an optional later step if you ever want the whole site private.

## What was and was NOT tested against real Cloudflare

Tested here (no Cloudflare account was available to me):

- `wrangler deploy --dry-run` (wrangler 4.162, installed temporarily outside the repo) bundles `worker/index.js` and accepts
  `wrangler.jsonc` with the `DB` and `ASSETS` bindings. (Its "Total Upload" figure is the Worker script, not the assets.)
- `wrangler dev --local` (workerd with a local D1): the real migration applied and the real sync client created a household,
  pushed 45 large brews in chunks, joined a second device and converged (edit + delete); the worker log held no codes or tokens.
- The sync tests run the real storage code and migration on in-memory SQLite behind a small D1-API shim (see `docs/SYNC.md`).
- `wrangler dev --local` (workerd): all app files are served with the right content types; `_headers` parsed ("1 valid
  header rule") and the HSTS/CSP/Permissions-Policy headers came back on `/`; `wrangler.jsonc`, `docs/`, `test/`,
  `package.json`, `CLAUDE.md`, `.git/` and `.claude/` returned 404.
- The demo-mode smoke test (Chromium) passes against that server with no CSP violations. A deliberately stricter CSP does
  produce violations, so the check can fail.
- `npm test` includes `test/hosting.test.mjs`, which guards `.assetsignore`, `_headers` and the Vercel ignore list.

**Not tested:** a real deploy; **remote D1** (latency, quotas, error behaviour, and `db.batch()` atomicity exactly as documented,
which the merge relies on); `CF-Connecting-IP` being present in production (rate limits share one bucket without it); the
Workers Free plan's 50-queries-per-request assumption behind the 20-records-per-push cap; Workers Builds (the GitHub connection, build/deploy commands, how it handles preview
branches); attaching the custom domain and the certificate; the DNS cutover itself and its exact error messages; HSTS and
headers on the real edge (only `wrangler dev` was used); and iPhone/iPad in Bluefy (WebKit) on the new address (only
Chromium was run). Treat the first deploy as the real test and use steps 3-4 (workers.dev first, Vercel still live) for that.
