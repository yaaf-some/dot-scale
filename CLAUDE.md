# Dot Scale — guide for Claude sessions

Static web app for the Timemore Dot (TES017) Bluetooth scale. No build step, no dependencies.
Live on Vercel at https://dot-scale.vercel.app — **every merge to `main` deploys to production**.

## Read first
- **`docs/PRODUCT.md`** is the product spec and the contracts between modules (data model, insights, sync). Follow it;
  change it in your PR if it's wrong.
- UI work: use the **frontend-design** skill (visual identity) and the **modern-web-guidance** skill (platform patterns),
  both in `.claude/skills/`.
- Primary devices are **iPhone/iPad in Bluefy (WebKit)**. Every feature must work in WebKit, with fallbacks for anything
  Safari lacks. If you can, also run the smoke test in Playwright WebKit (`npx playwright install webkit` may be blocked;
  if so, say so in your PR).

## Layout (current; moving to the `app/` structure in PRODUCT.md §11)
- `protocol.js` — BLE frame builder, CRC-16/MODBUS, streaming parser. Pure ES module, no DOM.
- `index.html` — the whole UI: markup, CSS and app logic in one `<script type="module">`.
- `scripts/serve.mjs` — local static server (`npm run serve`, port 8737).
- `test/*.test.mjs` — unit tests for `protocol.js` (`node:test`).
- `test/smoke.cjs` — Playwright smoke test: runs Demo mode and simulates a pour.
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
- Must work at phone and iPad sizes, in Bluefy (iOS) and Chrome (Android, desktop).
- Work on your own branch, open a **draft PR** to `main`; keep PRs small and focused. Never push to `main`.
