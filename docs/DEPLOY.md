# Hosting Dot Scale on Cloudflare

The app is static files plus one small Worker for the optional sync API, served by **Cloudflare Workers with static assets**
straight from this repository. There is no build step. **Workers Builds** deploys every push to `main`, and the site is at
**https://coffee.yaafsome.fyi**.

The dashboard steps below need the owner's Cloudflare login. Dashboard labels move around, so where one differs, look for the
thing named in **bold**. Nothing secret goes into the repository (it is public): Cloudflare account and zone ids and API tokens stay
in the dashboard.

## What is in the repository

- `wrangler.jsonc`: the Worker named `dot-scale`: the repo root as static assets, `worker/index.js` for `/api/*`, and an empty
  `previews` block that branch preview builds need.
- `.assetsignore`: what is **never** served (`.git`, `.claude`, `docs`, `test`, `scripts`, `worker`, `migrations`, `package.json`,
  `README.md`, `wrangler.jsonc`, ...). Anything committed at the top level that is not listed there is **public**, so add new
  private top-level files to it. `test/hosting.test.mjs` fails until every top-level entry is either public on purpose or ignored.
- `_headers`: security headers (section 5).
- `worker/` and `migrations/`: the sync API and its D1 schema (section 4).

## 1. One-time setup

1. **Connect the repository.** Dashboard → **Workers & Pages → Create → Import a repository** (the Git-connected Workers flow) and
   authorize the Cloudflare GitHub app for `yaaf-some/dot-scale` if asked. Worker name: **dot-scale** (it must match `name` in
   `wrangler.jsonc`). Production branch: `main`. Root directory: `/`. **Build command: leave empty.** Deploy command:
   `npx wrangler deploy` (the default). Pushes to `main` now deploy automatically.
2. **Check the first deploy** on the `dot-scale.<your-workers-subdomain>.workers.dev` address shown on the Worker's page, in
   Chrome or Bluefy: press **Demo**, and with the real scale press **Connect**. Then check the headers and that private files are
   not served:
   ```
   curl -sI https://dot-scale.<your-subdomain>.workers.dev/ | grep -i -E "strict|content-security|permissions|nosniff"
   for p in /wrangler.jsonc /README.md /_headers /.assetsignore /docs/DEPLOY.md /worker/index.js /.git/config; do
     curl -s -o /dev/null -w "$p %{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev$p; done   # every one must be 404
   ```
   If Connect fails only on a new address, loosen the headers one at a time in `_headers` (start with the Permissions-Policy) and
   redeploy; the Bluetooth permission is per address.
3. **Attach the domain.** **Workers & Pages → dot-scale → Settings → Domains & Routes → Add → Custom domain** →
   `coffee.yaafsome.fyi` (the `yaafsome.fyi` zone is in the same account). Cloudflare creates the DNS record and the certificate, which
   usually takes a minute or a few. If another DNS record already uses that name, delete it first or the attach fails. To keep the
   domain in the config instead, add `"routes": [{ "pattern": "coffee.yaafsome.fyi", "custom_domain": true }]` to `wrangler.jsonc`
   (a commented example is there).
4. **Check the domain:** repeat the header and 404 checks from step 2 against `https://coffee.yaafsome.fyi`.

Browsers keep data **per address**. The home-screen icon, saved brews and the scale's Bluetooth permission belong to the address
they were made on; on a new address, press Connect and pick the scale again.

## 2. Deploys and rollbacks

Every merge to `main` builds and deploys. CI (unit tests plus the Demo-mode browser test in Chromium and in WebKit, on a pinned Node 27 alpha) runs on every pull request, and Cloudflare
posts its build status on the PR. To roll back, open the Worker's **Deployments** tab, pick an earlier version and roll back to it.
Secrets and bindings are not touched by a rollback.

## 3. Branch previews

Workers Builds builds every other branch as a **preview** with its own address, without touching production or the domain. It runs
`npx wrangler preview`, which needs the empty `"previews": {}` block that `wrangler.jsonc` already has (without it the build fails
with "missing a `previews` block"). A branch gets a stable alias of the form
`https://<branch-name-with-dashes>-dot-scale.<your-workers-subdomain>.workers.dev` (lower-case, non-alphanumerics become `-`);
the Cloudflare bot also comments it on the pull request.

- **Settings → Builds → Branch control:** this repository is public and a preview build runs that branch's code on your Cloudflare
  account with the same bindings as production (including the D1 database once it exists). Restrict preview builds to branches you
  trust instead of "all branches". As far as I know only branches pushed to this repository are built, not pull requests from
  forks; check that setting in the dashboard.
- **Settings → Domains & Routes:** make sure **Preview URLs** are enabled.
- A preview is a different address, so it has its **own browser data** and its own Bluetooth permission.

## 4. Household sync (D1)

Sync is optional and separate from hosting: until you turn it on, the app shows "Sync not set up" and works locally. The Worker
(`worker/`) serves `/api/*`; household data lives in a **D1** (SQLite) database. Details: `docs/SYNC.md`.

1. Create the database and note its id:
   ```
   npx wrangler login
   npx wrangler d1 create dot-scale
   ```
   **Done for this project:** the `d1_databases` block in `wrangler.jsonc` is enabled with the id of the `dot-scale` database (a D1
   database id is a resource id, not an account id or a secret; the Cloudflare account id and API tokens never go into the repo).
   For a new database, replace the `database_id` there. With the placeholder id `REPLACE_WITH_D1_DATABASE_ID` a deploy fails (a
   test guards against merging that).
2. Create the tables: `npx wrangler d1 migrations apply dot-scale --remote`. No terminal? Dashboard →
   **Storage & databases → D1 → dot-scale → Console**, paste `migrations/0001_init.sql`, run. Repeat for any later
   `migrations/000N_*.sql` (deploys do not run migrations).
3. **Required: set the `SYNC_PEPPER` secret, once, before anyone creates a household.** It is the key the server uses to hash
   household codes. The code and the Worker are public, so without a secret key a leaked database could be brute-forced
   offline; the Worker therefore **refuses to run** (503 `sync_not_configured`, and the app shows "Sync not set up") until the
   secret exists and is at least 32 characters. Make a long random value and store it as a Worker secret, **never in the repo,
   a PR, a screenshot or a chat**:
   ```
   openssl rand -base64 48        # prints a suitable value; copy it
   npx wrangler secret put SYNC_PEPPER    # paste it when asked
   ```
   (If wrangler says the Worker doesn't exist yet, deploy once first.) No terminal? Dashboard → **Workers & Pages → dot-scale →
   Settings → Variables and Secrets → Add**, type **Secret**, name `SYNC_PEPPER`. Secrets persist across deploys. **Use the Worker's
   runtime "Variables and secrets", not the similarly named block under Settings → Build** (that one only exists while a build runs, so
   the Worker never sees it), and not Preview settings. Keep a copy in
   your password manager: **if you ever change or lose it, existing households can no longer be found** and must be recreated
   (so set it before anyone creates a household).
   For local development put it in a git-ignored `.dev.vars` file (`SYNC_PEPPER=...`), never in a tracked file.
4. Check: `curl -s -X POST https://coffee.yaafsome.fyi/api/sync` returns `{"error":"missing_code",...}` when the API is fully set
   up. `sync_not_configured` means D1 isn't bound (recheck the id) or the pepper is missing/too short (its message says which).
   Then in the app: **Settings → Sync → Create household**, and
   **Join** from the other device.

Previews: a Workers Builds preview of another branch uses the **same D1 database** as production (the binding is in
`wrangler.jsonc`); turn preview builds off or accept shared data.


## 5. Security headers (`_headers`)

HSTS (`max-age=31536000`, no `includeSubDomains`, no `preload`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame blocking, COOP, a Permissions-Policy that
keeps **Bluetooth for the app itself** and turns off camera, microphone, geolocation, payment, USB, serial and HID, and a CSP:
`default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.

**CSP is strict here:** `script-src 'self'` and `style-src 'self'`. The app shell has no inline script or style (one external module
script, external CSS files, no `style=""` attributes in markup or `innerHTML`; JS that sets `element.style.x = ...` is allowed by
CSP), and loads nothing from other origins; `connect-src 'self'` covers the sync API. `test/hosting.test.mjs` fails if the CSP would
block what `index.html` or `app/` does, and fails if `'unsafe-inline'` is added without anything needing it.

Cloudflare Access (a login in front of the site) is **not** enabled: it would interrupt the installed app and the
Bluetooth flow. It is an optional later step if you ever want the whole site private.


## 6. What has and has not been checked

Checked against the real Cloudflare deployment (November 2026): production builds and deploys from `main`; the app and its service
worker served over HTTPS on the Worker address and the custom domain; every security header on the real edge; the private files in
section 1 returning 404; branch preview builds (including the `previews` block fix); the D1 database bound to the Worker with its
three tables created; `SYNC_PEPPER` set as a runtime secret; and `/api/sync` answering `missing_code` (the API is live) instead of
`sync_not_configured`. The owner has also confirmed on an iPhone in Bluefy that the app opens and connects to the real scale.

Checked in CI on every PR: unit tests and the Demo-mode browser test in **Chromium and in WebKit** (Playwright's WebKit, the engine
Bluefy uses) under the real CSP, with no violations (a deliberately stricter CSP does produce violations, so the check can fail).
`npm test` includes `test/hosting.test.mjs`, which guards `.assetsignore`, `_headers` and `wrangler.jsonc`. Locally, `wrangler dev
--local` (workerd with a local D1) ran the real migration and the real sync client end to end: create a household, push large brews
in chunks, join a second device and converge (edit and delete), with no codes or tokens in the log.

**Not checked:** a household created and joined across two real devices against the **remote D1** (latency, quotas, error behaviour,
and `db.batch()` atomicity exactly as documented, which the merge relies on); `CF-Connecting-IP` being present in production (rate
limits share one bucket without it); the Workers Free plan's 50-queries-per-request assumption behind the 15-records-per-push cap
(worst case measured on SQLite: 38 statements); a full brew on the Cloudflare address in Bluefy under the production headers; and
passkeys on real devices (the Settings → Sync probe is the first check, see `docs/PASSKEYS.md`). Playwright's WebKit is not Bluefy
itself.
