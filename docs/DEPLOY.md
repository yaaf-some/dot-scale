# Hosting Dot Scale on Cloudflare (replacing Vercel)

The app is plain static files, so it is served as a **Cloudflare Worker with static assets** straight from this repo: no build
step, no Worker code and no `package.json` needed. Pushes to `main` deploy automatically through **Workers Builds**. The site
will be at **https://coffee.yaafsome.fyi**.

You (the owner) have to do the dashboard steps below; they need your Cloudflare login. Dashboard labels move around, so where
one differs, look for the thing named in **bold**. Nothing secret goes into the repo (it is public): this setup needs no
tokens, and Cloudflare account and zone IDs stay in the dashboard.

Facts this is written for: the `yaafsome.fyi` zone is active on the Cloudflare Free plan, the account has no Workers yet, and the
only DNS record is a CNAME `coffee` pointing at a `vercel-dns.com` name (DNS only). That record is why the order of the
cutover steps matters.

## What this adds

- `wrangler.jsonc`: an assets-only Worker named `dot-scale` that serves the repo root.
- `.assetsignore`: what is **never** served (`.git`, `.claude`, `docs`, `test`, `scripts`, `package.json`, `README.md`,
  `serve.ps1`, `wrangler.jsonc`, ...). It covers today's repo and the planned `app/`, `worker/`, `migrations/` layout. Anything
  not listed there is public, so add new private top-level files to it.
- `_headers`: security headers (below).
- This guide.

Merging this to `main` changes nothing for visitors by itself: Vercel keeps deploying `main` exactly as before until you
disconnect it (step 5), and Cloudflare starts deploying `main` once you connect the repo (step 1).

## 1. Connect the GitHub repo (Workers Builds)

1. Dashboard → **Workers & Pages → Create → Import a repository** (the Git-connected Workers flow). Authorize the Cloudflare
   GitHub app for this repository if asked.
2. Worker name: **dot-scale** (it must match `name` in `wrangler.jsonc`).
3. Production branch: `main`. Root directory: `/`. **Build command: leave empty.** Deploy command: `npx wrangler deploy` (the
   default; it fetches wrangler itself, so no `package.json` is required).
4. Save and deploy. Pushes to `main` now deploy automatically.

## 2. Test on the workers.dev address first

After the first deploy, open the `dot-scale.<your-subdomain>.workers.dev` URL shown on the Worker's page in Chrome (or Bluefy on
iPhone/iPad), press **Demo**, and check the app works. Vercel is still serving `coffee.yaafsome.fyi`, so nothing is at risk.
Check the headers and that private files are not served:

```
curl -sI https://dot-scale.<your-subdomain>.workers.dev/ | grep -i -E "strict|content-security|permissions|nosniff"
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/wrangler.jsonc   # must be 404
curl -s -o /dev/null -w "%{http_code}\n" https://dot-scale.<your-subdomain>.workers.dev/README.md        # must be 404
```

## 3. Try other branches on your phone before they reach `main` (preview versions)

Workers Builds builds non-production branches as **preview versions** with their own URL, without touching production or your
domain.

1. **Workers & Pages → dot-scale → Settings → Builds → Branch control**: builds for non-production branches **on**
   (non-production deploy command `npx wrangler versions upload`, the default). In a public repo you can limit this to branches you
   trust.
2. **Settings → Domains & Routes**: **Preview URLs** enabled.
3. Push to the branch. When the build finishes, the preview URL is on the build's page and under the Worker's **Deployments /
   Versions**. A branch gets a stable alias of the form `https://<branch-name-with-dashes>-dot-scale.<your-workers-subdomain>.workers.dev`
   (lower-case, non-alphanumerics become `-`, the name part is cut to fit 63 characters).
4. Open it on the iPhone/iPad in Bluefy (or Chrome). It is a different address from `coffee.yaafsome.fyi`, so it has its **own browser
   data** (fresh settings and history) and its own Bluetooth permission; the live site's data is untouched.

Preview versions use the same bindings as production (once the app has a database, previews share it).

## 4. Cutover: move coffee.yaafsome.fyi from Vercel to Cloudflare

Cloudflare's Worker custom domain creates its **own** DNS record for the name, so the old Vercel CNAME has to go first or it
conflicts (the attach fails with a message about existing DNS records). Do these in one sitting, in this order:

1. **Write down** the current record: Cloudflare dashboard → `yaafsome.fyi` → **DNS → Records** → the CNAME `coffee` (its target, a
   `vercel-dns.com` name, DNS only). You need it only if you roll back.
2. **Delete** that CNAME. From this moment `coffee.yaafsome.fyi` is down until step 3 finishes (`dot-scale.vercel.app` keeps working).
3. Dashboard → **Workers & Pages → dot-scale → Settings → Domains & Routes → Add → Custom domain** → `coffee.yaafsome.fyi` → Add.
   Cloudflare creates the DNS record and a certificate; this usually takes a minute or a few.
4. Check: open https://coffee.yaafsome.fyi and repeat the header and 404 checks from step 2 against it.

If a later deploy ever drops the domain (the config file doesn't mention it), pin it in `wrangler.jsonc` by adding
`"routes": [{ "pattern": "coffee.yaafsome.fyi", "custom_domain": true }]` (the file has the snippet in a comment). Only add it after
step 2, otherwise the deploy fails on the DNS conflict.

**Rollback:** remove the custom domain from the Worker, then re-create the CNAME `coffee` with the target you wrote down (DNS only).
Vercel serves it again as long as the Vercel project still exists, so do the cleanup below only after a few days of everything working.

### Browser data and the address

Browsers keep data **per address** (origin). If your devices already use `https://coffee.yaafsome.fyi`, the address doesn't change,
so saved brews, settings and the home-screen icon carry over. Any device still using `https://dot-scale.vercel.app` has data there
that will **not** appear at `coffee.yaafsome.fyi`: use the app's History export (Export JSON) there and import it at the new address,
then re-add the home-screen icon. The scale's Bluetooth permission is also per address; if the scale doesn't reconnect, press
Connect and pick it again.

## 5. Clean up Vercel (after a few days of Cloudflare working)

1. In the Vercel project → **Settings → Domains**: remove `coffee.yaafsome.fyi` (and the project's other domains if you want).
2. **Settings → Git**: disconnect the GitHub repository (this also stops the Vercel bot comments on PRs).
3. **Settings → General → Delete Project** at the bottom, once you are sure you don't want to roll back.
4. In the repo, delete `.vercelignore` if present (it only exists on branches that carry it) and update the Vercel mentions in
   `README.md` and `CLAUDE.md` (the live URL becomes https://coffee.yaafsome.fyi). Ask Claude to do this in a small PR; do it only
   after steps 1-3.

## Security headers (`_headers`)

HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame blocking, COOP, a Permissions-Policy that keeps
**Bluetooth for the app itself** and turns off camera, microphone, geolocation, payment, USB, serial and HID, and a CSP:
`default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.

**Assumption, with a TODO:** the current shell (`index.html`) is a single inline module script plus an inline `<style>` block and
`style=""` attributes, and loads nothing from other origins. So the CSP allows `'unsafe-inline'` for scripts and styles for now (with
`script-src 'self'` a Cloudflare deploy of this shell would be a blank page). When the new app shell (external `app/main.js` and
CSS files) replaces it: change `script-src` to `'self'`; and `style-src` to `'self'` once no `style=""` attribute remains in markup or
`innerHTML` (JS that sets `element.style.x = ...` is fine under CSP). Keep `connect-src 'self'` unless the app needs another origin.

Cloudflare Access (a login in front of the site) is **not** enabled: it would interrupt the installed app and the Bluetooth flow. It
is an optional later step if you ever want the whole site private.

## What was and was NOT tested against real Cloudflare

Tested (no Cloudflare account was available):

- `wrangler deploy --dry-run` (wrangler 4.162, installed temporarily outside the repo) accepts `wrangler.jsonc` as an assets-only
  Worker (no `main`, no bindings) on a checkout of `main` plus these files.
- `wrangler dev --local` (workerd): all app files are served with the right content types; `_headers` parsed ("1 valid header rule")
  and the HSTS/CSP/Permissions-Policy headers came back on `/`; `wrangler.jsonc`, `README.md`, `serve.ps1`, `.git/`, `.gitignore`
  and `docs/` returned 404.
- A browser run of the Demo mode (Chromium) against that server shows no CSP violations.

**Not tested:** a real deploy; Workers Builds (the GitHub connection, build/deploy commands, preview-branch behaviour); attaching
the custom domain and its certificate; the DNS cutover and its exact error messages; headers and HSTS on the real edge; and
iPhone/iPad in Bluefy (WebKit) on the new host (only Chromium was run). Treat the first deploy as the real test, which is why
step 2 uses workers.dev while Vercel is still live.
