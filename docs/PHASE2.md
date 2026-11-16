# Phase 2: a faster, more polished app

**Status: shipped (November 2026).** Cold Home load went from 1425 ms to 937 ms on a throttled test link (31 files / 6 levels deep to 24
files / 3 levels, preloaded), live-screen layouts per 10 s from about 465 to about 97, and the Journal with 600 brews from 288 ms to
121 ms; motion, view transitions and the live-screen wording fixes are in `docs/DESIGN.md`. Not done: Early Hints (only verifiable on the
deployed site) and a reconnect-time measurement (needs a real scale). The text below is the original plan.

Scope: the **deployed app only** (how it loads, how it runs while brewing, how it feels). CI and deploy speed are out of scope.
Constraints: free Cloudflare plan, zero runtime dependencies, no build step, strict CSP (no inline script or style),
Bluefy/WebKit is a first-class target (every feature needs a fallback where Safari lacks it).

Two workstreams, one PR each, independent files. Read `CLAUDE.md`, `docs/PRODUCT.md`, `docs/DESIGN.md` first.

## Baseline (measured, Nov 2026)

- 71 JS files, ~250 KB JS (~127 KB gzipped for all app files). Brotli, HTTP/2 and HTTP/3 are already on.
- Cold start from `app/main.js`: 31 files, 166 KB, **6 levels deep** (about 7 dependent round trips). Brew screen: 35 files, 192 KB.
  Home: 11 files, 34 KB.
- Every static file is `Cache-Control: public, max-age=0, must-revalidate` with an ETag. The service worker (stale-while-revalidate)
  covers repeat visits. Static asset requests are free and unlimited, so revalidating costs latency only.
- Unmeasured so far: runtime cost of the live brew screen, startup with a large history, reconnect time. Workstream A measures these first.

## Workstream A: Performance (branch `claude/phase2-perf`)

Measure before and after with throwaway local Playwright scripts (do not add them to CI; put numbers in the PR body).

1. **Flatten the module waterfall.** Add `<link rel="modulepreload">` for the critical graph in `index.html` (plus `fetchpriority="high"`
   on the main stylesheet). Add a unit test that fails when the preload list and the real static import graph from `app/main.js` drift
   apart, so it stays no-build. Target: cold start in about 2 round trips.
2. **Lazy-load heavy code.** `insights/analyze.js` (47 KB) only on the result screen, the sync client only when sync is enabled,
   anything else not needed for first paint. Keep the module boundaries; move imports, do not rewrite.
3. **Gentler offline warm-up** in `app/pwa.js`: use real idle time (`requestIdleCallback` with fallback), skip it on Save-Data, keep
   `data-offline-ready` semantics for the smoke test.
4. **Service worker:** navigation preload, a single-pass cache fill, bump `VERSION`. Never cache `/api/`.
5. **Runtime while brewing:** measure redraw rate and per-frame cost of the live screen at the scale's stream rate; remove per-frame
   allocation and layout thrash; update only what changed. Report battery-relevant numbers (long tasks, frames over 16 ms).
6. **Data path:** measure boot (IndexedDB open, seeds, migration) and Home/Journal with a generated history of 500+ brews; fix what
   scales badly (indexes, lazy rendering, windowed lists).
7. **Early Hints:** try a `Link` header in `_headers`; keep only if a real browser trace shows it fires for static assets, else drop it
   and say so.
8. **Reconnect time** in Demo mode: measure; improve only if it is clearly slow.

Out of scope: bundling or hashed filenames (needs a build step), Workers Cache API (bills static requests), Durable Objects,
Workers AI, Web Analytics beacon (CSP), paid-plan features.

## Workstream B: UX and motion (branch `claude/phase2-ux`)

Character: **subtle and quick**. Typical durations 120-250 ms; one spring only, for the "shot complete" moment. Used at a
counter with wet hands, so nothing slows a tap and nothing distracts on the live screen.

1. **Audit** first (in the PR body, ranked): current screens against `docs/DESIGN.md` and the vendored guides in
   `.claude/skills/modern-web-guidance/guides` (`ui-behaviors/motion`, `same-document-transitions`, `physics-based-easing`,
   `animate-element-entry-exit`, `user-experience/natural-interactions`, `content-first-noise-reduction`, `form-factor-adaptation`).
2. **Motion tokens** in `app/ui/tokens.css`: durations, easings, one `linear()` spring. One small helper (for example
   `app/ui/motion.js`) wrapping `document.startViewTransition` with a no-op fallback and focus handling.
3. **Apply to the highest-value moments only:**
   - tab changes and route changes (view transitions; instant switch where unsupported);
   - Journal list to brew detail; live to result screen;
   - toasts, dialogs and sheets enter/exit (`@starting-style`, `transition-behavior: allow-discrete`, fallback = no animation);
   - press/hover/focus feedback on every control (`:active` scale, visible `:focus-visible`);
   - skeleton or soft placeholders instead of blank panels; edge fades on scrolling lists.
4. **Flow shortcuts:** remember the last method and recipe; one-tap "brew again" from Home and Journal. No new screens.
5. **Feedback cues:** target-weight and finish cues use sound and a visual cue everywhere; `navigator.vibrate` only where it exists
   (not iOS). Respect existing settings.
6. **Tablet and phone polish:** safe areas, larger touch targets, better use of iPad width.

Rules:
- Animate only `transform` and `opacity` (compositor). Handle `prefers-reduced-motion` per animation (opt in with
  `no-preference`, or adjust parameters with `reduce`); never a global `animation-duration: 0.01ms`. No flashing.
- Every effect has a WebKit fallback. Scroll-driven animations are polish only and may simply be absent.
- Take colours, spacing and radii from `tokens.css`. Build DOM with `h()`; no `innerHTML` with user data; no inline styles.
- Disclose the guides used in the PR body under `### Modern Web Guidance`.
- Coordinate with workstream A: its measurements are the guardrail. If an animation costs frames on the live screen, cut the animation.

## Done when

- A: before/after numbers in the PR body show fewer dependent round trips and no regression on the live screen; unit test covers
  the preload list; `npm run check` is green.
- B: motion tokens and helper exist, the listed moments are animated with fallbacks, reduced-motion verified, smoke test green,
  screenshots in the PR (reference screenshots in `docs/design/` updated only if the design changed).
- Both: docs updated (`CLAUDE.md` layout lines, `docs/DESIGN.md` motion section for B), no secrets or personal data (public repo).
