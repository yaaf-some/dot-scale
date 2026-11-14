# Dot Scale: product spec

Dot Scale goes from a scale utility to a **home-barista coach**. It uses one Bluetooth scale (Timemore Dot) and its timer.
This document is the source of truth for every session working on the app. If something here is wrong, change it in a PR;
don't quietly diverge from it.

## 1. Goal

Help the people in this household make better coffee, understand *why* it got better, and enjoy trying new things.

- **Hands-off while brewing.** Weight and flow drive the app, so there's no tapping with wet hands.
- **Teaches without lecturing.** Each brew ends with *one* clear takeaway and *one* thing to try next. Depth is there on request.
- **Calm for new users, deep for curious ones.** Smart defaults; anything advanced is one tap away, never in the way.
- **A joy to reuse.** "Brew again" is the fastest path. Progress (a bean dialled in, consistency improving) is visible.

### Who and where
- Profiles: **Yaaf** and **Alexa** to start, and anyone else can be added.
- Devices: **iPhone and iPad in Bluefy** (a WebKit browser with Web Bluetooth; Safari has no Web Bluetooth and never will be targeted),
  plus Chrome on Android and desktop. The iPad usually stands on the counter about 1 m away, so the live screen must read at a glance.
- Data **syncs across devices** for the household (see §7).

### Current gear (editable in the app; the household will upgrade later)
- Espresso machine: **De'Longhi Stilosa EC260**: 15-bar vibration pump, **51 mm** group, no pressure gauge, no temperature control, no
  preinfusion control.
- Baskets: **unpressurized double baskets only (~16–16.5 g)**, used with either a **naked (bottomless)** or a **2-spout** portafilter.
  Never the pressurized stock baskets. Shot time and flow are therefore real grind diagnostics.
- Grinder: *unknown, asked during onboarding*. Grind settings are free text plus an optional numeric value so trends work.
- Other brewers: pour-over (V60-style cone), French press, AeroPress, moka pot, **Wacaco Prestina** (cup-driven immersion press, 240 ml).
- Future, **not now**: a machine with pressure and temperature data. The data model reserves room for extra channels (§6) so this needs no rewrite.

## 2. What we learned from the market
- **Beanconqueror** (free, open source) is the power-user reference: huge feature set, many scales, everything customizable. Its reviews
  point to the opening for us: people say it's overwhelming, with "bad design choices", and some want "just a nice looking app to track brews".
  **We win on focus and guidance, not on feature count.**
- **Acaia** splits its features across several apps (Brewguide recipes, Brewmaster live flow), and reviewers find that annoying. **We stay one app.**
- **Bookoo** has decent graphs and mode control but little coaching.
- None of them closes the loop well: *what happened → why → what to change next → did it work?* That loop is our core.

## 3. Information architecture

```
Home ─┬─ Brew (method → recipe → prep → live → result) ── saves a Brew
      ├─ Journal (history, detail, compare, per-bean dial-in trail)
      ├─ Learn (short cards, unlocked by what you brew)
      └─ Settings (profiles, gear, beans, scale, sync, advanced/debug)
```

Navigation: a bottom tab bar on phones and a side rail on iPad/wide screens (container/media queries).

### Home
- A **profile switcher** at the top (avatar chips: Yaaf, Alexa, +). The last-used profile on this device is preselected.
- **Scale status** inline: connect button / battery / "demo". Auto-reconnect to a known scale.
- **"Brew again"** cards: the profile's favourite and most recent recipes per method, one tap to start with everything filled in.
- **One** contextual nudge, never a feed. For example: "Your last 3 shots on *Ethiopia Guji* ran fast; start 1 step finer",
  or "These beans are 21 days off roast. Fine for espresso, but past their peak soon."
- First run: short onboarding (§5).

### Brew flow (the core)
1. **Pick method:** espresso, pour-over, French press, AeroPress, moka pot, Prestina. Large tiles, last used first.
2. **Recipe:** prefilled from the profile's last brew of that method (or the method default). Editable: dose, ratio⇄yield, water temp
   (informational), grind (text + number), bean, and for espresso the portafilter (naked/spouted). Ratio and yield stay linked.
3. **Prep:** at most 3 checklist lines, specific to the method (e.g. espresso: "Purge grinder · Dose 16.2 g · Cup on scale"). With the
   scale connected, the **dose step is automatic**: put the beans or portafilter on, read the weight, and Use as dose. Then auto-tare.
4. **Live** (§4): hands-off.
5. **Result:** the numbers, the curve, **one takeaway + one change to try** (from the insights engine), a quick taste tap
   (sour ← balanced → bitter; weak ← → strong; plus 1–5 stars), optional notes, and for naked-portafilter shots "spurts?" yes/no. Save is the default
   action; nothing is lost if the user just walks away (autosave after 2 min).

### Journal
- A list grouped by day, filterable by profile, method and bean. Each row: method icon, bean, ratio, time, stars, a sparkline.
- Detail: the full curve, metrics, insights, taste, notes, and edit/delete. **Compare** overlays two brews.
- **Dial-in trail per bean:** the sequence of shots with grind changes and outcomes. This shows learning over time.
- Export/import JSON (backup), CSV export.

### Learn
- Cards of 3–6 sentences each, one idea per card, with a diagram where it helps. They are surfaced *in context* (the result screen links the card behind
  its tip, e.g. "Why does a fast shot taste sour?"). Learn lists all cards and marks the ones already seen.
- Tone: friendly, precise, no jargon without a one-line explanation. No textbook walls.

### Settings
Profiles (name, colour/emoji, default methods), gear, beans (name, roaster, roast date, process, notes), scale (rename,
power off, etc., from the existing app), sync (household code), Advanced (debug log, raw commands, demo mode).

## 4. Live screen
- Readable from 1 m: **weight** huge, **timer** large, **flow (g/s)** medium. Target progress as a ring or bar.
- Brewing keeps the screen awake (Screen Wake Lock API where supported; degrade silently).
- **Automation**, with defaults that can be turned off:
  - Auto-tare after the dose step / when the cup is placed (a stable weight jump, then tare).
  - Auto-start the timer at the first sustained flow (> 0.2 g/s for ≥ 0.5 s) or the first weight gain on pour-over.
  - Espresso timing: the scale sees drops, not the pump. With a `start` event (pump on) the timer covers *waiting* and records the
    first-drop time; with auto-start the timer begins at the first drops, so `timeS` excludes the pump-to-first-drop lag, first-drop time is left
    unset (never reported as 0), and `startSource: 'auto'` (vs `'manual'`) on the Brew record is how analysis knows which it has.
  - Espresso auto-stop: once yield nears target and flow drops to near 0 for 2 s → done. A cue at about 2 g before target
    ("stop the pump", with an optional beep) so the user can hit the yield despite the drip after stopping. The app learns the
    typical post-stop drip per profile/gear and suggests stopping that many grams early.
  - Pour-over: steps advance by weight/time (bloom → pours → drawdown), with the next target shown big and a gentle cue to pour.
  - Immersion (French press, AeroPress, Prestina): a countdown with stir/plunge/press cues.
  - Moka pot: the scale is used for dose and water only; then a timer with "remove from heat when it starts to gurgle/blond".
- Espresso phases on screen: *waiting → first drops → main flow → finishing*.
- Charts: live weight and flow curve on canvas; the target line is shown.

## 5. Onboarding (first run, under 60 s, skippable)
1. "Who's brewing?" Yaaf / Alexa / add.
2. "What do you brew?" Multi-select methods. These order the method tiles.
3. Espresso gear (only if espresso is picked): machine (prefilled EC260), basket size (16 g double), portafilter(s), grinder.
4. Connect the scale (or try the demo).
Done. Land on Home with a "Start your first brew" card.

## 6. Data model (contract between modules)

All records share this envelope: `{ id: string (uuid), type, updatedAt: ms epoch, deleted?: true, ...fields }`.
Local store is **IndexedDB** (localStorage is too small for curves), with a tiny wrapper. Migrate the existing `localStorage`
keys `dot.recipe`, `dot.autoStart`, `dot.beep`, `dot.history` on first run (history becomes Brew records under the first profile).

```js
Profile { id, type:'profile', name, color, emoji, createdAt, updatedAt }
Gear    { id, type:'gear', kind:'espresso-machine'|'grinder'|'brewer'|'basket'|'portafilter', name, props:{}, updatedAt }
Bean    { id, type:'bean', name, roaster, roastDate?: 'YYYY-MM-DD', process?, origin?, notes?, archived?, updatedAt }
Recipe  { id, type:'recipe', profileId, method, name, dose, yield, ratio, tempC?, grind?:{text, value?}, steps?:Step[], favorite?, updatedAt }
Brew    { id, type:'brew', profileId, method, recipeId?, beanId?, gear:{machine?, grinder?, portafilter?:'naked'|'spouted', basketG?},
          startedAt, dose, yield, targetYield, ratio, timeS, firstDropS?, grind?:{text, value?}, tempC?,
          samples: { hz: 10, t0: 0, channels: { weight: number[], flow: number[] /* future: pressure, temp */ } },
          metrics: {...from insights}, insights: {...from insights}, taste?: {balance:-2..2, strength:-2..2, stars:1..5, spurts?:bool},
          notes?, updatedAt }
Step    { kind:'bloom'|'pour'|'wait'|'stir'|'press'|'plunge'|'swirl'|'heat', targetG?, atS?, durationS?, label }
```
`samples` are stored downsampled to 10 Hz (a 40 s shot is ~800 numbers). Curves from before the migration may be absent; the UI must handle that.

## 7. Sync (household)
- **Local-first:** the app works fully offline; sync runs in the background when online.
- **Household code:** the first device creates a household and shows a code (e.g. `maple-tiger-orbit-42`). Other devices join by entering it.
  No accounts or passwords. The server stores only a hash of the code. Profiles live inside the household.
- **API** (Vercel serverless function, Node runtime, **no npm dependencies**: use the Upstash Redis REST API via `fetch`):
  - `POST /api/household` → `{ code }` (creates one)
  - `POST /api/sync` with header `Authorization: Bearer <code>` and body `{ since: rev, changes: Record[] }` → `{ rev, changes: Record[] }`.
    The server merges per record with **last-writer-wins on `updatedAt`** (ties broken by id), stamps a monotonically increasing `rev`
    (Redis `INCR`), and returns everything newer than `since`. Deletes are tombstones (`deleted: true`).
  - Limits: 1 MB per request, 20k records per household, basic rate limit per household.
- Env vars: `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel Marketplace Upstash integration). Also accept the
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` names. **The owner must add the Upstash Redis integration to the
  Vercel project**; until then the client shows "Sync not set up" and keeps working locally.
- Tests run against an in-memory fake of the REST API; no real Redis in CI.

## 8. Insights engine (pure module, no DOM)
`analyze(brew, { method, gear, history }) → { metrics, verdict, tips: Tip[], learn: string[] /* card ids */ }`

- **Metrics (espresso):** dose, yield, ratio, total time, time to first drops, main-phase average and peak flow, flow stability
  (coefficient of variation in the main phase), late-shot flow ramp (blonding/channel hint), and the drip after stopping.
- **Metrics (pour-over / immersion):** total time, time per step vs plan, pour rate, and drawdown time (from when weight stops increasing to the end).
- **Verdict:** one short sentence, such as "Ran fast: 36 g in 19 s."
- **Tips:** ranked; the UI shows the top one and expands to at most 2 more. Each tip: `{ id, title, change, why, confidence, learnCard? }`.
  Change **one variable at a time**; grind first for flow, ratio/yield for strength, taste overrides time.
- **Espresso rules, starting points for a 1:2 shot (16 g → 32 g) on a non-pressurized basket**, written so thresholds can be tuned:
  - Total time under ~22 s → grind finer. Over ~35 s → coarser. 25–30 s is the sweet spot, with taste deciding.
  - First drops under ~5 s → likely coarse / low dose / poor puck. Over ~12 s on the EC260 (no preinfusion control) → likely too fine.
  - Flow unstable, or sudden flow jumps, or "spurts" on a naked portafilter → puck prep (distribution/WDT, even tamp), **not** grind.
  - Sour → finer, or longer ratio. Bitter/astringent → coarser, or shorter ratio. Sour *and* bitter → channeling → puck prep.
  - Use the bean's roast date: very fresh beans (< 5 days) produce gassy, erratic flow, so wait or degas. Over ~6 weeks → expect faster shots.
- **History-aware:** compare with the previous shots on the same bean; recognise "you went finer and time rose 6 s, good, keep it".
  Mark a bean as **dialled in** after 2 consecutive shots that are in range and rated 4+.
- Thresholds live in one tunable table; tests cover each rule with synthetic curves.
- Future: the pressure/temp channels add rules; the engine must ignore channels it doesn't know.

## 9. Methods and recipes (data modules)
Each method has `{ id, name, icon, defaults: Recipe, steps: Step[], prep: string[], learn: string[] }`.
Defaults are well-known community starting points (cite the source in a comment) and are labelled as starting points in the UI:
- Espresso: 16 g → 32 g, 25–30 s.
- Pour-over (cone): 15 g : 250 g (about 1:16.7), 93–96 °C, bloom 2× dose for 45 s, then pours to 60%/100%, total about 3:00–3:30.
- French press: 30 g : 500 g, about 95 °C, 4:00 steep, break the crust, skim, wait 5 more minutes, press gently (the "long steep" style).
- AeroPress: 11–12 g : 200 g, about 95 °C, 2:00 steep, swirl, wait 30 s, press gently.
- Moka pot: fill the basket level (about 15–20 g, depending on pot size), hot water to the valve; record dose and water weight.
- Prestina (Wacaco, 240 ml): start at about 14 g : 220 g, medium-fine, stir, about 1:30–2:00 immersion, press. *Unverified; refine with use.*

## 10. Design direction
- Use the **frontend-design** skill for visual identity. Follow its two-pass process (plan tokens → critique against the brief → build).
  The subject is the home-espresso counter: a warm, tactile craft tool that is precise and calm, and easy on early-morning eyes.
  **Avoid the generic AI looks the skill lists**, including the cream + terracotta (#D97757) palette and the "everything is a card" kit.
- Use the **modern-web-guidance** skill for implementation patterns (dialogs, view transitions, dark mode, accessibility, PWA)
  and **always ship the Safari/WebKit fallback**.
- Light and dark themes (dark by default in the evening is fine). Touch targets ≥ 48 px; the live screen's primary actions are ≥ 64 px.
- Motion: one meaningful moment (e.g. hitting the target), otherwise only motion that answers an action. Respect reduced motion.
- Copy: plain, active, sentence case. Errors say what happened and what to do.

## 11. Technical architecture
- Still **no build step and no runtime dependencies** in the frontend. Native ES modules.
- Layout:
  ```
  index.html            app shell
  app/main.js           boot, router (hash), view mounting
  app/core/             store.js (IndexedDB + migration), scale.js (BLE/demo transport), brew-session.js (state machine), events.js
  app/insights/         pure analysis (tested)
  app/methods/          method definitions & recipes (tested for shape)
  app/learn/            card content
  app/sync/             client sync (tested with fake fetch)
  app/ui/               views + components + styles (tokens in one CSS file)
  api/                  Vercel functions (household, sync)
  protocol.js           unchanged BLE protocol
  ```
- Test: `npm run check` (unit + Playwright smoke via Demo mode). Each workstream adds tests for what it adds.

## 12. Out of scope for now
Native iOS app, accounts/passwords, social features, machine integration (data model is ready), AI chat.
