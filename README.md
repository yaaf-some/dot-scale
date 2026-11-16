# Dot Scale

**A coffee coach that lives in your browser.** Connect your Timemore Dot scale, make your coffee the way you always do, and Dot Scale
takes care of the timing, tells you when to stop, and after every cup suggests one small thing to try next.

**Try it: [coffee.yaafsome.fyi](https://coffee.yaafsome.fyi)**
No scale handy? Tap **Demo** and play with a pretend one.

> A hobby project, made with love for one home coffee setup. It isn't made by or connected to Timemore; "Timemore" and "Dot" belong
> to their owners.

## What it does

- **Hands-free brewing.** Pick what you're making and Dot Scale zeroes the scale, starts the timer the moment coffee begins to flow,
  nudges you through each pour, beeps when you reach your target, and keeps the screen awake. The numbers are big enough to read from
  across the counter. It works for espresso, pour-over, French press, AeroPress, moka pot and the Wacaco Prestina.
- **Gets better with every cup.** After each drink you get one takeaway and one thing to try next, plus a quick "how did it taste?"
  check. It only ever suggests changing one thing at a time, so you can tell what helped.
- **Remembers your coffee.** The Journal keeps every brew with its weight and flow curve. Compare two cups side by side, see how
  you dialled in a particular bag of beans, and save a backup whenever you like.
- **Learn as you go.** Short, plain-language cards explain what the numbers mean, and the tips link straight to them.
- **For the whole household.** Everyone gets their own profile with their own recipes and history. If you want, you can share them
  between your phones and tablets (see *Sharing between devices* below).
- **Works without internet.** Add it to your home screen and it opens like any other app, even with no signal.

## Getting started

1. **Open [coffee.yaafsome.fyi](https://coffee.yaafsome.fyi)**
   - **iPhone or iPad:** use **Bluefy**, a free browser app that can talk to Bluetooth gadgets. Safari can't connect to scales.
   - **Android or computer:** Chrome or Edge works.
2. **Switch your scale on**, tap **Connect**, and pick it from the list.
3. **Choose a method and brew.** Then use your browser's *Add to Home Screen* to keep the app close.

### Trouble connecting on iPhone or iPad?

- **Don't pair the scale in iOS Settings → Bluetooth.** That pairing isn't used, and a scale already connected to the phone (or to
  Timemore's own app) can't be found by Bluefy. Close the Timemore app, and if the scale is listed in Settings → Bluetooth, tap it and
  choose **Forget This Device**. Then switch the scale on and tap **Connect** again.
- **A scale talks to one device at a time.** Disconnect it from any other phone, tablet or computer first.
- **"Request payload could not be parsed"** comes from Bluefy itself. Dot Scale tries simpler requests automatically, all the way down
  to listing every nearby Bluetooth device so you can pick yours by name. It also helps to update Bluefy to its latest version.
  **Settings → Advanced → Debug log** shows what worked.

## Good to know

- **Built around one setup.** The espresso advice is tuned for a 16 g double shot in a standard (non-pressurized) basket. Other gear
  works fine, but treat the suggestions as a starting point and trust your taste.
- **Your data stays with you.** There are no accounts, no ads and no tracking. Everything lives on your own device unless you choose
  to turn sharing on.
- **Sharing between devices (optional).** Create a *household* in **Settings → Sync** and you get a private code made of a few words
  and numbers. Enter it on your other devices and your profiles, beans and brews stay in step. Keep the code safe, because anyone who
  has it can see the household's coffee notes. The app works fully without any of this.
- **Scale settings.** You can rename the scale, switch it off, forget an old pairing, or factory reset it from inside the app.

## For tinkerers

<details>
<summary>Run it yourself, how it's built, and the scale protocol</summary>

Dot Scale is plain web files with no build step and no dependencies, plus one small Cloudflare Worker for the optional sharing
feature. Every merge to `main` goes live at [coffee.yaafsome.fyi](https://coffee.yaafsome.fyi).

```bash
npm run serve      # local server on http://localhost:8737 (Bluetooth needs localhost or https)
npm test           # unit tests (Node 22.13+ locally; CI runs a Node 27 alpha)
npm run smoke      # browser test through Demo mode (Playwright)
npm run check      # both; run before every push
```

Open http://localhost:8737 in Chrome or Edge.

**Where to read next:** `CLAUDE.md` (code layout and house rules), `docs/PRODUCT.md` (what the app is and how the pieces fit),
`docs/DESIGN.md` (the look and feel), `docs/SYNC.md` (sharing between devices), `docs/DEPLOY.md` (hosting on Cloudflare).

**How the scale talks.** The scale's firmware is left as it is. The app speaks Timemore's published
[open scale protocol](https://github.com/TIMEMORE-COFFEE/open-scale-protocol) directly over Web Bluetooth:

- Service `FFF0`: notifications on `FFF1`, writes (without response) on `FFF2`.
- Frame: `A5 5A | opcode | cmd | len(u16 BE) | payload | CRC16 BE`. Opcodes: 1 notify, 2 read, 3 write.
- Weight frame `01 01`: int32 weight ×0.1 g, int16 flow ×0.1 g/s, uint16 timer s, uint8 overload.
- The scale only streams weight after the app sends unit=g (`03 06 [00]`) and mode (`03 08 [01 00]`).
- The scale's own notifications carry `00 00` instead of a CRC, so incoming frames aren't CRC-checked.

The code is in `protocol.js`; its command bytes match frames verified on real hardware.

</details>
