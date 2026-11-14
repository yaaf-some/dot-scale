# Dot Scale — guide for Claude sessions

Static web app for the Timemore Dot (TES017) Bluetooth scale. No build step, no dependencies.
Live on Vercel at https://dot-scale.vercel.app — **every merge to `main` deploys to production**.

## Layout
- `protocol.js` — BLE frame builder, CRC-16/MODBUS, streaming parser. Pure ES module, no DOM.
- `index.html` — the whole UI: markup, CSS and app logic in one `<script type="module">`.
- `sw.js` — service worker: network-first with a cache fallback, so the app opens offline. **Bump `VERSION` when you add a
  file the app needs to `SHELL`.**
- `icons/` — PNG icons (192/512, maskable, apple-touch) rendered from `icon.svg` by `node scripts/make-icons.cjs`.
  The PNGs are committed; re-run the script after editing `icon.svg`.
- `scripts/serve.mjs` — local static server (`npm run serve`, port 8737). `serve.ps1` is the Windows equivalent.
- `test/*.test.mjs` — unit tests for `protocol.js` (`node:test`).
- `test/smoke.cjs` — Playwright smoke test: runs Demo mode, simulates a pour, then reloads offline via the service worker.
- `.vercelignore` keeps tests/scripts out of the deployment.

## Commands
- `npm test` — unit tests
- `npm run smoke` — browser smoke test (`SCREENSHOT=/path.png npm run smoke` to capture the page)
- `npm run check` — both. **Run before every push.**

## Rules
- No real scale in the cloud: verify UI changes through **Demo mode**, which speaks the real protocol.
  If you add a protocol feature, teach the demo simulator in `index.html` to answer it.
- Keep zero runtime dependencies and no build step. Only third-party scripts from pinned CDN URLs, if ever.
- Protocol facts come from Timemore's open-scale-protocol; mark anything unverified on hardware as such.
- Data lives in `localStorage` under the `dot.` prefix (`store.get/set`). Don't break existing keys
  (`recipe`, `autoStart`, `beep`, `history`) — migrate instead.
- Must work on phone width and in Bluefy (iOS) / Chrome (Android, desktop).
- Work on your own branch, open a **draft PR** to `main`; keep PRs small and focused. Never push to `main`.
