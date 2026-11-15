# Dot Scale

A home-barista coach for the **Timemore Dot (TES017)** Bluetooth coffee scale. It reads weight and flow straight from the scale,
runs the brew hands-off, and after each drink tells you one thing to try next. The scale's firmware is left as it is: the app talks
to it directly over Web Bluetooth using [Timemore's published protocol](https://github.com/TIMEMORE-COFFEE/open-scale-protocol).

> Unofficial hobby project. It is not made by or affiliated with Timemore; "Timemore" and "Dot" belong to their owners.

## Use it

Open **https://coffee.yaafsome.fyi** in Chrome (Android, desktop) or **Bluefy** (iPhone, iPad; Safari has no Web Bluetooth),
then connect your scale. Add it to your home screen to install it; it works offline once it has loaded. Press **Demo** to try it
without a scale.

Bluetooth runs between the scale and whatever device has the page open, so no computer needs to stay on.

### Trouble connecting on iPhone or iPad?

- **Don't connect the scale in iOS Settings → Bluetooth.** Web Bluetooth does not use that pairing, and a scale that is already
  connected to the phone (or to the Timemore app) can't be found by Bluefy. Close the Timemore app, and if the scale is listed under
  Settings → Bluetooth, tap it and choose **Forget This Device**. Then switch the scale on and press **Connect** in the app.
- **The scale talks to one device at a time.** Disconnect it from any other phone, tablet or computer first.
- **"Request payload could not be parsed"** comes from Bluefy itself. The app sends only full-length Bluetooth IDs and, if the browser
  still rejects the request, tries simpler requests automatically (down to listing every nearby Bluetooth device, where you pick the
  scale by name). **Settings → Advanced → Debug log** shows which request worked. Update Bluefy to its latest version too.

## What it does

- **Brew:** espresso, pour-over, French press, AeroPress, moka pot and Wacaco Prestina. Pick a method, check the recipe, and the app
  tares, starts the timer when coffee starts flowing, cues the pours and the moment to stop the pump, beeps at the target, and keeps
  the screen awake. The live screen is readable from a metre away.
- **Learn from every drink:** the result screen gives one takeaway and one thing to try next, plus a quick taste check. The advice
  is tuned for a 16 g double on a non-pressurized basket and changes one variable at a time.
- **Journal:** your brews by day, with weight and flow curves, comparing two brews, a dial-in trail for each bean, and JSON/CSV
  backup and import.
- **Learn:** short cards that explain what the numbers mean, linked from the tips.
- **Profiles:** Yaaf and Alexa to start, more can be added, each with their own recipes and history.
- **Household sync (optional):** share profiles, beans and brews between your devices with a household code. The app works fully
  without it.
- **Scale settings:** rename, power off, forget an old app pairing and factory reset, plus a debug log and raw command sender.
- **Demo mode:** a simulated scale that speaks the same protocol.

## Hosting

The app is plain static files with no build step, plus one small Worker for the optional sync API. It runs on **Cloudflare**
(Workers with static assets) and deploys on every push to `main`. Setup, previews, sync and security headers: `docs/DEPLOY.md`.

## Develop

```bash
npm run serve      # local server on http://localhost:8737 (Web Bluetooth needs localhost or https)
npm test           # unit tests (Node 22.13+ locally, CI runs a Node 27 alpha; the sync tests use the built-in node:sqlite)
npm run smoke      # browser test through Demo mode (Playwright)
npm run check      # both; run before every push
```

Open http://localhost:8737 in Chrome or Edge. No dependencies and no build step.

Where to read next: `CLAUDE.md` (code layout and rules), `docs/PRODUCT.md` (what the app is and the data model),
`docs/DESIGN.md` (the visual direction), `docs/SYNC.md` (household sync), `docs/DEPLOY.md` (hosting).

## Files

| Path | What it is |
|---|---|
| `protocol.js` | Frame builder, CRC-16/MODBUS, streaming parser. Command bytes match frames verified on real hardware. |
| `index.html` | Thin app shell |
| `app/` | The app: `core/` (store, scale, demo, brew session), `methods/`, `insights/`, `learn/`, `journal/`, `sync/`, `ui/` (tokens, components, views) |
| `sw.js`, `icons/`, `manifest.webmanifest` | Offline support and install |
| `worker/`, `migrations/` | The sync API (a Cloudflare Worker) and its D1 schema |
| `wrangler.jsonc`, `_headers`, `.assetsignore` | Cloudflare config, security headers, and what is never served |
| `scripts/` | Local dev server and asset scripts |
| `test/` | Unit tests and the Demo-mode browser test |
| `docs/` | Product, design, sync and deploy documents |

## Protocol notes

- Service `FFF0`: notifications on `FFF1`, writes (without response) on `FFF2`.
- Frame: `A5 5A | opcode | cmd | len(u16 BE) | payload | CRC16 BE`. Opcodes: 1 notify, 2 read, 3 write.
- Weight frame `01 01`: int32 weight ×0.1 g, int16 flow ×0.1 g/s, uint16 timer s, uint8 overload.
- The scale only streams weight after the app sends unit=g (`03 06 [00]`) and mode (`03 08 [01 00]`).
- The scale's own notifications carry `00 00` instead of a CRC, so incoming frames aren't CRC-checked.
