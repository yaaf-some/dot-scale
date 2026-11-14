# Hosting Dot Scale on Cloudflare (replacing Vercel)

The app is plain static files, so it is served as a **Cloudflare Worker with static assets** straight from this repo: no
build step and no Worker code yet. Pushes to `main` deploy automatically through **Workers Builds**. The site will be at
**https://coffee.yaafsome.fyi**.

You (the owner) have to do the dashboard steps below; they need your Cloudflare login. Dashboard labels move around, so
where one differs, look for the thing named in **bold**.

Facts this is written for: the `yaafsome.fyi` zone is active on the Cloudflare Free plan, the account has no Workers yet,
and the only DNS record is a CNAME `coffee` pointing at a `vercel-dns.com` name (DNS only). That record is why the order
of steps 4-5 matters.

## 1. How this reaches production

This work lands on the **integration branch** (`claude/admiring-brahmagupta-2rovr3`), not on `main`. `main` is production and
only changes at the single release PR, so `wrangler.jsonc` is not on `main` until then and Vercel keeps serving the live site
exactly as before in the meantime (`.vercelignore` excludes the Cloudflare-only files). To try the new app on Cloudflare
before the release, use the staging steps (section "Try the integration branch on your phone", below).

## 2. Connect the GitHub repo (Workers Builds)

1. Dashboard → **Workers & Pages → Create → Import a repository** (the Git-connected Workers flow). Authorize the
   Cloudflare GitHub app for `yaaf-some/dot-scale` if asked.
2. Worker name: **dot-scale** (it must match `name` in `wrangler.jsonc`).
3. Production branch: `main`. Root directory: `/`. **Build command: leave empty.** Deploy command: `npx wrangler deploy`
   (the default).
4. Save and deploy. Pushes to `main` now deploy automatically.

Production branch: `main` (so real Cloudflare deploys start when the release PR lands). Other branches are built as
**preview versions**, see the next section.

## 3. Test on the workers.dev address first

After the first deploy, open the `dot-scale.<your-subdomain>.workers.dev` URL shown on the Worker's page. Vercel is still serving
`coffee.yaafsome.fyi`, so nothing is at risk. **Do not cut over until all of these pass:**

1. In Chrome: press **Demo** and check the app works.
2. **On the iPhone/iPad in Bluefy: press Connect and connect the real scale**, then tare. Demo mode does not use Web Bluetooth,
   and Bluefy (WebKit) was not tested here, so this is the real check that the security headers don't get in the way.
3. If Connect fails only on this address, loosen the headers one at a time in `_headers` (first remove the
   `Permissions-Policy` line, then `Cross-Origin-Opener-Policy`, then try without the CSP) and push; the change deploys in a
   minute. Tell Claude which one it was so the file can be fixed properly.
4. Check the security headers and that private files are not served:

```
curl -sI https://dot-scale.<your-subdomain>.workers.dev/ | grep -i -E "strict|content-security|permissions|nosniff"
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/wrangler.jsonc   # must be 404
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/_headers          # must be 404 (config, not a file)
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/.assetsignore     # must be 404
```

## Try the integration branch on your phone (staging, before the cutover)

Workers Builds builds non-production branches as **preview versions** with their own URL, without touching production or your
domain. This is how you try the new app on Cloudflare while Vercel still serves the old one.

0. Leave non-production builds **off** unless you want staging. If you turn them on, set the allow-list below **first**.
1. Dashboard → **Workers & Pages → dot-scale → Settings → Builds → Branch control**: turn builds for non-production branches
   **on** (non-production deploy command: `npx wrangler versions upload`, the default) and **restrict them to a short allow-list
   of branches you trust** (for example just the integration branch), not "all branches". This repository is public: a preview
   build runs that branch's code on your Cloudflare account with the same bindings as production (including the D1 database once
   it exists). As far as I know, only branches pushed to this repository are built (not pull requests from forks); check that
   setting in the dashboard.
2. **Settings → Domains & Routes**: make sure **Preview URLs** are enabled.
3. Push to (or re-run a build of) the integration branch `claude/admiring-brahmagupta-2rovr3`. When the build finishes, the
   preview URL is on the build's page and under the Worker's **Deployments / Versions**. A branch gets a stable alias of the
   form `https://<branch-name-with-dashes>-dot-scale.<your-workers-subdomain>.workers.dev` (lower-case, non-alphanumerics become
   `-`, the name part is cut to fit 63 characters). Cloudflare's GitHub app may also post it on the pull request.
4. Open that URL on the iPhone/iPad in Bluefy (or Chrome), press **Demo** or connect the scale, and try it. It is a different
   address from `coffee.yaafsome.fyi`, so it has its **own browser data** (fresh settings and history) and its own Bluetooth
   permission; the Vercel site's data is untouched.

Preview versions use the same bindings as production (once the sync PR lands: the same D1 database; see "Household sync"), so
a household created on a preview is real production data.

Going live before the release PR is possible but not recommended until the new app matches the old one's features: temporarily
set the **production branch** under **Settings → Builds → Branch control** to the integration branch, do the cutover below, and
set it back to `main` when the release PR merges.

## 4. Cutover: move coffee.yaafsome.fyi from Vercel to Cloudflare

Cloudflare's Worker custom domain creates its **own** DNS record for the name, so the old Vercel CNAME has to go first or it
conflicts (the attach fails with a message about existing DNS records). That means **`coffee.yaafsome.fyi` is down between steps
2 and 3** (a few minutes if all goes well; `dot-scale.vercel.app` keeps working). The custom-domain attach and certificate flow
is untested here, so rehearse it first on a throwaway name that has no DNS record yet:

**Rehearsal (recommended):** add the custom domain `coffee-test.yaafsome.fyi` to the Worker (**Settings → Domains & Routes → Add →
Custom domain**), wait for it to become active, run the header and 404 checks from step 3 against it and press Connect in
Bluefy, then remove that domain again. If the attach or the certificate misbehaves, you learn it without any downtime.

Then do the real cutover in one sitting, at a quiet time, in this order:

1. **Write down** the current record: Cloudflare dashboard → `yaafsome.fyi` → **DNS → Records** → the CNAME `coffee`
   (its target, a `vercel-dns.com` name, DNS only). You need it only if you roll back.
2. **Delete** that CNAME. (If the dashboard offers to replace the existing record when you add the custom domain in step 3, that does
   the same thing in one step and shortens the downtime; I couldn't test whether it does.) From this moment `coffee.yaafsome.fyi` is down until step 3 finishes
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

### Browser data and the address

Browsers keep data **per address** (origin). If your devices already use `https://coffee.yaafsome.fyi`, the address doesn't
change, so saved brews and settings carry over (and a home-screen shortcut keeps working). Any device still using
`https://dot-scale.vercel.app` has its data **there only**: it will not appear at `coffee.yaafsome.fyi`, and the current app has
**no export yet**. Household sync (this PR) will carry data across devices later. If you only want to keep that history for now,
keep using the old address until the release (so don't remove the Vercel project, see step 5, before then). The scale's
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
   (a D1 database id is a resource id, not an account id or a secret; the Cloudflare account id and API tokens never go into the repo). **Do this before merging the sync PR, or its first deploy fails.**
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

HSTS (`max-age=31536000`, no `includeSubDomains`, no `preload`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame blocking, COOP, a Permissions-Policy that
keeps **Bluetooth for the app itself** and turns off camera, microphone, geolocation, payment, USB, serial and HID, and a CSP:
`default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.

**CSP is strict here:** `script-src 'self'` and `style-src 'self'`. The app shell has no inline script or style (one external module
script, external CSS files, no `style=""` attributes in markup or `innerHTML`; JS that sets `element.style.x = ...` is allowed by
CSP), and loads nothing from other origins; `connect-src 'self'` covers the sync API. `test/hosting.test.mjs` fails if the CSP would
block what `index.html` or `app/` does, and fails if `'unsafe-inline'` is added without anything needing it. (On `main`'s older,
inline shell the minimal hosting PR still needs `'unsafe-inline'`; this branch replaces that file and tightens it.)

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
Workers Free plan's 50-queries-per-request assumption behind the 15-records-per-push cap (worst case measured on SQLite: 38 statements); Workers Builds (the GitHub connection, build/deploy commands, how it handles preview
branches); attaching the custom domain and the certificate; the DNS cutover itself and its exact error messages; HSTS and
headers on the real edge (only `wrangler dev` was used); and iPhone/iPad in Bluefy (WebKit) on the new address (only
Chromium was run). Treat the first deploy as the real test and use steps 3-4 (workers.dev first, Vercel still live) for that.
