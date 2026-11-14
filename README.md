# Dot Scale

A self-hosted web app for the **Timemore Dot (TES017)** Bluetooth coffee scale, so you don't need the Timemore app.
The scale's firmware is left as it is. The app talks to it directly over Web Bluetooth using
[Timemore's published protocol](https://github.com/TIMEMORE-COFFEE/open-scale-protocol).

## Hosting

The app is plain static files with no build step. It's hosted on **Vercel** at **https://dot-scale.vercel.app**, which redeploys on every push to `main`.
Open the Vercel URL in Chrome (Android, desktop) or **Bluefy** (iPhone; Safari has no Web Bluetooth).
Bluetooth runs between the scale and whatever device has the page open, so no computer needs to stay on.

## Run it locally

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1 -Open
```

Or, with Node 18+ on any OS: `npm run serve`.

Then open http://localhost:8737 in **Chrome or Edge** and click **Connect scale**. You can install it as an app
from the address bar.

Web Bluetooth only works on `localhost` or `https://`.

### Optional: tailnet-only hosting

On any always-on machine running `serve.ps1` (or any static server on port 8737),
`tailscale serve --bg 8737` publishes it over HTTPS at `https://<machine>.<tailnet>.ts.net/`, visible only on your tailnet.

## What it does

- Live weight (0.1 g), flow rate, the scale's own timer, and battery level
- Tare, plus timer start, pause and reset (on the scale itself)
- Brew recipe with dose, ratio and target, a progress bar, and a beep at the target
- The timer can start automatically when you start pouring
- Pour graph of weight and flow
- Brew history, stored in this browser: tap a brew for its pour graph and notes (bean, grind, rating);
  export as JSON or CSV, and import a JSON export (duplicates are merged)
- Scale settings: rename, power off, forget old app pairing, factory reset
- Debug log with raw frames, and a raw command sender
- **Demo mode**: a simulated scale that speaks the same protocol, so you can try the app without hardware

## Files

| File | What it is |
|---|---|
| `protocol.js` | Frame builder, CRC-16/MODBUS, streaming parser. Command bytes match frames verified on real hardware. |
| `history.js` | Brew history shape, migration, merge, downsampling, JSON/CSV export |
| `index.html` | The app UI |
| `serve.ps1` | Small local web server for Windows (no dependencies) |
| `scripts/serve.mjs` | The same server in Node (`npm run serve`) |
| `test/` | Protocol and history unit tests (`npm test`) and a Demo-mode browser smoke test (`npm run smoke`) |

## Protocol notes

- Service `FFF0`: notifications on `FFF1`, writes (without response) on `FFF2`.
- Frame: `A5 5A | opcode | cmd | len(u16 BE) | payload | CRC16 BE`. Opcodes: 1 notify, 2 read, 3 write.
- Weight frame `01 01`: int32 weight ×0.1 g, int16 flow ×0.1 g/s, uint16 timer s, uint8 overload.
- The scale only streams weight after the app sends unit=g (`03 06 [00]`) and mode (`03 08 [01 00]`).
- The scale's own notifications carry `00 00` instead of a CRC, so incoming frames aren't CRC-checked.
