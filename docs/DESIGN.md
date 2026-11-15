# Dot Scale: design direction

Result of the frontend-design two-pass process (plan → critique against the brief → build). Tokens live in
`app/ui/tokens.css`; components and layout in `app/ui/app.css`. Change both this file and the tokens together.

## Brief in one line
A calm, tactile tool for two people making espresso at the counter at 6 a.m. Phone in one hand, iPad on the counter
1 m away. Precise, not clinical. Must not look like every AI coffee app.

## Pass 1: first instinct (rejected)
Warm cream background, espresso-brown text, terracotta/caramel accent, a high-contrast serif for headings, everything
in identical rounded cards. This is the exact cluster the skill warns about, and every "coffee app" generates it.

## Critique
- Cream + terracotta is the generated-coffee default; nothing about it comes from *this* counter.
- Identical cards flatten the hierarchy: the thing you tap every day (Brew again) looked like a settings group.
- Brown-on-cream is also the weakest contrast pair for a screen read from 1 m.
- A single warm accent gives the numbers nowhere to be loud.

## Pass 2: the direction ("Porcelain & crema")
Take the palette from the objects on the counter instead of from "coffee": **white porcelain, blue-and-white cup
glaze, the golden line of crema, the dark roast in the cup**.

Colour (light "Porcelain" / dark "Roast"; all text pairs ≥ 4.5:1, button labels ≥ 7.7:1):

| token | light | dark | role |
|---|---|---|---|
| `--paper` | #EFF1EE | #1D1713 | page (cool porcelain / roast brown, not black) |
| `--raised` | #FAFBF9 | #29211B | grouped panels, dialogs |
| `--sunken` | #E1E5E0 | #140F0C | wells, inputs, tab bar |
| `--ink` | #17211D | #F2EBE1 | text (green-black, not neutral grey) |
| `--cobalt` | #2342B5 | #9DB2FF | primary action: the glaze blue on the cup |
| `--crema` | #E3A63B | #E9B45E | target / progress / the one "good" moment |

Type: a serif for **numbers and titles** (`ui-serif` is New York on iPhone/iPad, with Iowan Old Style / Georgia
fallbacks) and the platform sans for everything you read or tap. Numerals are tabular and large: grams are the product.
No all-caps labels, no mono "data" labels, no eyebrow text.

Shape: different things get different radii. Big 28 px "tickets" for Brew again, 20 px grouped panels, 14 px buttons,
pill chips. No shadow kit: depth comes from tone steps (`paper → raised`), and one hairline.

The memorable detail (the one place boldness is spent): **saucer avatars and numeral tickets**. Profiles are a coloured
disc with a thin concentric ring, like a cup on a saucer, and Brew again shows the recipe as big numerals
(`16 → 32 g`) instead of a description.

Layout:
```
phone                      iPad / wide
┌──────────────────┐       ┌────┬─────────────────────────┐
│ ☕ Yaaf  🌱 Alexa  + │       │ ◯  │  ☕ Yaaf  🌱 Alexa  +       │
│ ● Demo scale  78%│       │Home│  ● Demo scale  78%       │
│                  │       │ ◯  │                          │
│  nudge (one line)│       │Brew│  16 → 32 g   15 → 250 g  │
│  16→32   15→250  │       │ ◯  │  tickets in a grid       │
│  tickets         │       │... │                          │
├──────────────────┤       └────┴─────────────────────────┘
│ Home Journal ◉ Learn ⚙ │  bottom tabs  →  side rail at ≥ 768 px
└──────────────────┘
```
Left-aligned everywhere; numerals may centre inside their own readout.

## Motion
Character: **subtle and quick**. Used at a counter with wet hands, so nothing slows a tap and nothing distracts on the live screen.
Tokens in `tokens.css`: `--t-fast` 120 ms (press, hover), `--t-base` 220 ms (enter, route), `--t-exit` 140 ms (leaving is quicker),
`--ease` / `--ease-in`, and one `--spring` (`linear()`, 520 ms) used only for the "shot complete" cue. Helpers in `app/ui/motion.js`.

Rules: animate `transform` and `opacity` only; opt animations in with `(prefers-reduced-motion: no-preference)` (the tokens also drop
to 0 ms under `reduce`; there is no global `animation-duration` override); no flashing (the slowest pulse is 1.1 s at 35% depth);
strict CSP means no inline styles, only classes and data attributes. Every effect has a fallback:

| moment | how | fallback |
|---|---|---|
| tab / route change | View Transition on `main` only (tab bar stays), `data-vt` = tab (fade + 6 px rise), push / pop (16 px slide, Journal list ↔ brew) | instant swap |
| brew screens (recipe → prep → result) | `data-enter` fade-and-rise on the stage; **never** on the live screen | none |
| dialogs and toasts | keyframes in, `data-leaving` keyframes out, closed after `--t-exit` by a timer | opens and closes instantly |
| press / hover / focus | `:active` scale 0.97-0.98, hover only under `(hover: hover)`, global `:focus-visible` ring | none |
| shot complete | the stop cue springs in (`--spring`); other cues get one 360 ms pulse | plain ease where `linear()` is missing |
| live progress bar | `scaleX` instead of `width` (compositor only) | n/a |
| slow screen | soft skeleton after 140 ms if the view has rendered nothing | blank until ready |
| scrolling chip rows | static edge mask (no scroll-driven animation needed) | none |

Cues: the target and step cues always show on screen; sound follows the "Beep at target" setting and `navigator.vibrate` (Android,
desktop Chrome; absent on iOS) fires with it.

## Platform rules baked into the tokens
- Light and dark are plain custom properties switched by `prefers-color-scheme` and `[data-theme]`; **no `light-dark()`
  and no `color-mix()`**, so older WebKit (Bluefy on an older iOS) still gets the theme.
- Touch targets: `--target: 48px` (64 px for primary live actions), enlarged further on coarse pointers.
- Safe-area insets on the tab bar and rail; `100dvh` with a `100vh` fallback; container queries only enhance a layout
  that is already single-column without them.
