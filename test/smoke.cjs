// Browser smoke test: serves the app and drives the new shell through Demo mode. Fails on any page error.
// Uses the preinstalled Playwright (cloud sessions) or a local `npm i -g playwright`.
// Set SMOKE_BROWSER=webkit to run in WebKit (needs `npx playwright install webkit`).
const pw = require('playwright');

(async () => {
  const { start } = await import('../scripts/serve.mjs');
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw[process.env.SMOKE_BROWSER || 'chromium'].launch();
  const errors = [];
  const track = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    // The static test server has no /api, so the sync probe (POST /api/sync) 404s; Chromium logs a failed request as a console
    // error. Only that one 404 is ignored; any other failed /api/ request is a real error.
    page.on('console', (m) => m.type() === 'error' && !(/Failed to load resource.*404/.test(m.text()) && /\/api\/sync$/.test(m.location().url || '')) && errors.push(m.text()));
  };
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

  try {
    // ---- phone: first run, with legacy localStorage data to migrate ----
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('dot.history')) {
        localStorage.setItem('dot.history', JSON.stringify([{ at: 1700000000000, dose: 15, out: 240, time: 190 }]));
        localStorage.setItem('dot.recipe', JSON.stringify({ dose: 15, ratio: 16 }));
      }
    });
    const page = await ctx.newPage();
    track(page);
    await page.goto(url);

    await page.waitForSelector('.onboard h1:has-text("Who")');
    check(true, 'first run lands on onboarding');
    check((await page.locator('.profile-chip').allInnerTexts()).join('|').includes('Yaaf') && (await page.locator('.profile-chip').allInnerTexts()).join('|').includes('Alexa'), 'profiles Yaaf and Alexa are seeded');
    await page.click('.profile-chip:has-text("Alexa")');
    await page.click('button:has-text("Next")');
    await page.click('.tile:has-text("Espresso")');
    await page.click('button:has-text("Next")');
    await page.waitForSelector('#ob-machine');
    check((await page.locator('#ob-machine option:checked').innerText()).includes('EC260'), 'espresso gear step is prefilled with the EC260');
    await page.click('button:has-text("Next")');
    await page.click('button:has-text("Try demo")');
    await page.waitForSelector('.demo-tag');
    await page.click('button:has-text("Done")');
    await page.waitForSelector('.home-title');
    check((await page.locator('.home-title').innerText()).includes('Alexa'), 'Home greets the chosen profile');
    check(await page.locator('.scale-line[data-status="connected"]').count() === 1, 'demo scale shows as connected on Home');

    await page.click('a.tab:has-text("Brew")');
    await page.waitForSelector('[data-testid="weight"]');
    await page.click('button:has-text("Start")');
    await page.waitForFunction(() => parseFloat(document.querySelector('[data-testid="weight"]').textContent) > 1, null, { timeout: 8000 });
    check(true, 'weight rises during the simulated pour');

    await page.click('a.tab:has-text("Journal")');
    await page.waitForSelector('[data-view="journal"] h2');
    await page.click('a.tab:has-text("Home")'); await page.waitForSelector('.home-title');
    await page.click('.profile-chip:has-text("Yaaf")');
    await page.waitForFunction(() => document.querySelector('.home-title')?.textContent.includes('Yaaf'));
    await page.waitForSelector('.ticket:has-text("Pour-over")');
    check(true, 'switching to Yaaf shows the migrated legacy brew under Brew again');

    check(await page.locator('.tab .icon svg path, .tab .icon svg rect, .tab .icon svg circle').count() > 5, 'tab icons render as SVG');
    await page.click('a.tab:has-text("Settings")');
    await page.waitForSelector('#profiles');
    await page.click('button:has-text("Add beans")');
    await page.fill('dialog[open] input[type=text] >> nth=0', 'Ethiopia Guji');
    await page.click('dialog[open] button:has-text("Add beans")');
    await page.waitForSelector('#beans .row:has-text("Ethiopia Guji")');
    check(true, 'beans can be added in Settings');
    await page.waitForSelector('#sync .row-title:has-text("Sync not set up")', { timeout: 5000 });
    check(await page.locator('#sync button:has-text("Check again")').count() === 1, 'Settings has a Sync section that says "Sync not set up" when there is no server, with a Check again button (the app keeps working)');

    await page.reload();
    await page.waitForSelector('#profiles');
    await page.click('a.tab:has-text("Home")');
    await page.waitForSelector('.home-title');
    check(await page.locator('.onboard').count() === 0, 'onboarding is not shown again after reload');
    check((await page.locator('.home-title').innerText()).includes('Yaaf'), 'active profile persists across reload (IndexedDB)');
    await ctx.close();

    // ---- iPad: side rail ----
    const pad = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const ipad = await pad.newPage();
    track(ipad);
    await ipad.goto(url);
    await ipad.waitForSelector('.onboard');
    await ipad.click('button:has-text("Skip")');
    await ipad.waitForSelector('.home-title');
    const box = await ipad.locator('nav.tabs').boundingBox();
    check(box.x === 0 && box.width < 140 && box.height >= 700, `iPad layout uses a side rail (${Math.round(box.width)}px wide)`);
    await pad.close();

    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  } catch (e) { check(false, e.message); }

  // Offline: the service worker registers, caches the shell, and the app reloads (and runs Demo) with no network.
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const off = await ctx.newPage();
  const offErrors = [];
  off.on('pageerror', (e) => offErrors.push(e.message));
  off.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && offErrors.push(m.text()));
  try {
    await off.goto(url);
    const scope = await off.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then((r) => r.scope),
      new Promise((ok) => setTimeout(() => ok('none (timed out)'), 5000)),
    ]));
    check(scope === url, `service worker registers (scope ${scope})`);
    await off.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
    await off.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
    // No file list in sw.js: the page hands over what it loaded on this first visit. Wait until that is cached.
    await off.waitForSelector('html[data-offline-ready]', { state: 'attached', timeout: 10000 });
    check(true, 'first-visit files are cached without a file list');
    // A file the page never loaded (stands in for a new app/ module) is cached the first time it's fetched.
    await off.evaluate(() => fetch('icons/icon-512.png').then((r) => r.blob()));
    await off.waitForFunction(async () => !!(await caches.match('icons/icon-512.png')), null, { timeout: 5000, polling: 100 });
    await ctx.setOffline(true);
    await off.reload();
    await off.waitForSelector('.onboard', { timeout: 8000 });
    check(true, 'app shell and modules load while offline');
    await off.click('button:has-text("Skip")');
    await off.waitForSelector('.home-title');
    await off.click('button:has-text("Try demo")');
    await off.waitForSelector('.demo-tag', { timeout: 8000 });
    check(true, 'demo runs offline (app/ modules and protocol.js served from cache)');
    const lateOk = await off.evaluate(() => fetch('icons/icon-512.png').then((r) => r.ok, () => false));
    check(lateOk, 'a file first fetched after install is served offline');
    check(offErrors.length === 0, `no page errors offline${offErrors.length ? ': ' + offErrors.join('; ') : ''}`);
  } catch (e) { check(false, 'offline: ' + (e.message.split('\n').slice(0, 3).join(' | '))); }
  await ctx.close().catch(() => {});
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
})();
