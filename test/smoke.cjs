// Browser smoke test: serves the app, runs Demo mode, simulates a brew, fails on page errors.
// Uses the preinstalled Playwright (cloud sessions) or a local `npm i -g playwright`.
const { chromium } = require('playwright');

(async () => {
  const { start } = await import('../scripts/serve.mjs');
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
  try {
    await page.goto(url);
    await page.click('#demoBtn');
    await page.waitForFunction(() => !document.querySelector('#tareBtn').disabled, null, { timeout: 5000 });
    check(true, 'demo connects and enables controls');
    await page.click('#startBtn');
    await page.waitForTimeout(3000);
    const text = await page.locator('.readout').innerText();
    const grams = parseFloat((text.match(/-?\d+(\.\d)?/) || ['0'])[0]);
    check(grams > 1, `weight rises during simulated pour (readout: ${text.replace(/\s+/g, ' ').slice(0, 60)})`);
    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  } catch (e) { check(false, e.message); }

  // Offline: the service worker registers, caches the shell, and the app reloads (and runs Demo) with no network.
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const off = await ctx.newPage();
  const offErrors = [];
  off.on('pageerror', (e) => offErrors.push(e.message));
  try {
    await off.goto(url);
    const scope = await off.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then((r) => r.scope),
      new Promise((ok) => setTimeout(() => ok('none (timed out)'), 5000)),
    ]));
    check(scope === url, `service worker registers (scope ${scope})`);
    await off.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
    // No file list in sw.js: the page hands over what it loaded on this first visit. Wait until that is cached.
    await off.waitForFunction(async () => !!(await caches.match('protocol.js')), null, { timeout: 5000, polling: 100 });
    check(true, 'first-visit files are cached without a file list');
    // A file the page never loaded (stands in for a new app/ module) is cached the first time it's fetched.
    await off.evaluate(() => fetch('icons/icon-512.png').then((r) => r.blob()));
    await off.waitForFunction(async () => !!(await caches.match('icons/icon-512.png')), null, { timeout: 5000, polling: 100 });
    await ctx.setOffline(true);
    await off.reload();
    check(await off.isVisible('#demoBtn'), 'page reloads while offline');
    await off.click('#demoBtn');
    await off.waitForFunction(() => !document.querySelector('#tareBtn').disabled, null, { timeout: 5000 });
    check(true, 'demo runs offline (protocol.js served from cache)');
    const lateOk = await off.evaluate(() => fetch('icons/icon-512.png').then((r) => r.ok, () => false));
    check(lateOk, 'a file first fetched after install is served offline');
    check(offErrors.length === 0, `no page errors offline${offErrors.length ? ': ' + offErrors.join('; ') : ''}`);
  } catch (e) { check(false, 'offline: ' + e.message); }
  await ctx.close().catch(() => {});
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
})();
