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
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
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

  // ---- Journal and Learn: seed brews through the store, then use the real screens ----
  try {
    const jctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const jp = await jctx.newPage();
    track(jp);
    await jp.goto(url);
    await jp.waitForSelector('.onboard');
    await jp.click('button:has-text("Skip")');
    await jp.waitForSelector('.home-title');
    check(await jp.locator('.nudge[data-nudge^="run-"], .nudge[data-nudge^="dialled-"]').count() === 0, 'Home shows no history nudge before there is history');
    await jp.evaluate(async () => {
      const { store } = window.dotScale;
      const profile = (await store.list('profile')).sort((a, b) => a.createdAt - b.createdAt)[0];
      store.prefs.set('activeProfile', profile.id);
      const bean = await store.put({ type: 'bean', name: 'Ethiopia Guji', roaster: 'Test Roasters' });
      // Synthetic 10 Hz shot: flow ramps in 3 s after the first drops, stops at the target, short tail.
      const shot = (firstDrop, flow, stopAt) => {
        const w = [], f = []; let g = 0, stopT = null, t = 0;
        while (t < 60) {
          let fl = t >= firstDrop && stopT == null ? flow * Math.min(1, (t - firstDrop) / 3) : 0;
          if (stopT == null && g >= stopAt) stopT = t;
          if (stopT != null) { fl = Math.max(0, 1.2 * (1 - (t - stopT) / 2)); if (t - stopT > 2) break; }
          g += fl / 10; w.push(Math.round(g * 10) / 10); f.push(Math.round(fl * 100) / 100); t += 0.1;
        }
        return { samples: { hz: 10, t0: 0, channels: { weight: w, flow: f } }, yield: w[w.length - 1], timeS: Math.round((stopT ?? t) * 10) / 10 };
      };
      const day = 86400000, now = Date.now();
      const plan = [[4, 2.6, 33, 12, 0], [4, 2.6, 33, 11, 0], [8, 1.7, 30.5, 10, 4], [8, 1.7, 30.5, 10, 5]];
      for (const [i, [fd, fl, stop, grind, stars]] of plan.entries()) {
        const s = shot(fd, fl, stop);
        await store.put({ type: 'brew', profileId: profile.id, method: 'espresso', beanId: bean.id, gear: { portafilter: 'naked', basketG: 16 },
          startedAt: now - (plan.length - i) * 3600000, dose: 16, targetYield: 32, ratio: +(s.yield / 16).toFixed(2), grind: { value: grind },
          ...s, metrics: {}, insights: {}, ...(stars ? { taste: { balance: 0, strength: 0, stars } } : {}), notes: i === 0 ? '=cmd|calc' : undefined });
      }
      await store.put({ type: 'brew', profileId: profile.id, method: 'pour-over', legacy: true, gear: {}, startedAt: now - 3 * day, dose: 15, yield: 240, targetYield: 240, ratio: 16, timeS: 190, metrics: {}, insights: {} });
    });
    await jp.click('a.tab:has-text("Journal")');
    await jp.waitForSelector('[data-testid="brew-row"]');
    check(await jp.locator('[data-testid="brew-row"]').count() === 5, 'Journal lists the seeded brews');
    check(await jp.locator('.day-head').count() >= 2, 'brews are grouped by day');
    check(await jp.locator('[data-testid="brew-row"] .spark svg path').count() === 4, 'rows with curves show a sparkline (legacy brew has none)');
    await jp.selectOption('.filters select >> nth=1', 'pour-over');
    check(await jp.locator('[data-testid="brew-row"]').count() === 1, 'method filter narrows the list');
    await jp.selectOption('.filters select >> nth=1', 'all');
    await jp.click('[data-testid="brew-row"]:has-text("Earlier app")');
    await jp.waitForSelector('.note:has-text("earlier version")');
    check(true, 'a legacy brew (no curve) opens with an explanation, not a broken chart');
    await jp.goBack();
    await jp.waitForSelector('[data-testid="brew-row"]');
    await jp.locator('[data-testid="brew-row"]:has-text("Ethiopia Guji")').first().click();
    await jp.waitForSelector('canvas[aria-label^="Weight and flow"]');
    const drawn = () => { const c = document.querySelector('canvas'); if (!c.width) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 2000; };
    check(await jp.waitForFunction(drawn, null, { timeout: 5000 }).then(() => true, () => false), 'the detail chart actually draws');
    check(await jp.locator('.verdict').count() === 1 && await jp.locator('.metrics .metric').count() >= 4, 'detail shows metrics and the recomputed verdict');
    await jp.click('button:has-text("Compare…")');
    await jp.click('dialog[open] button:has-text("Compare")');
    await jp.waitForSelector('.cmp');
    check(await jp.locator('.cmp tbody tr').count() >= 6 && await jp.locator('canvas').count() === 1, 'Compare overlays two curves with a side-by-side table');
    await jp.goBack(); await jp.waitForSelector('canvas');
    await jp.click('a:has-text("Dial-in trail")');
    await jp.waitForSelector('[data-testid="trail-shot"]');
    check(await jp.locator('[data-testid="trail-shot"]').count() === 4 && await jp.locator('.trail .badge:has-text("Dialled in")').count() === 1, 'dial-in trail lists the shots and flags the dialled-in one');
    await jp.goBack(); await jp.waitForSelector('canvas');
    await jp.click('button:has-text("Edit")');
    await jp.fill('dialog[open] textarea', 'Sweet and juicy');
    await jp.click('dialog[open] button:has-text("Save")');
    await jp.waitForSelector('.notes:has-text("Sweet and juicy")');
    check(true, 'editing a brew saves taste and notes');
    await jp.click('a.tab:has-text("Journal")');
    await jp.waitForSelector('[data-testid="brew-row"]');
    await jp.click('button:has-text("Backup")');
    const [jsonDl] = await Promise.all([jp.waitForEvent('download'), jp.click('dialog[open] button:has-text("Export JSON")')]);
    const jsonText = require('fs').readFileSync(await jsonDl.path(), 'utf8');
    const parsed = JSON.parse(jsonText);
    check(parsed.format === 'dot-scale' && parsed.records.filter((r) => r.type === 'brew').length === 5, 'JSON export contains the brews');
    const [csvDl] = await Promise.all([jp.waitForEvent('download'), jp.click('dialog[open] button:has-text("Export CSV")')]);
    const csv = require('fs').readFileSync(await csvDl.path(), 'utf8');
    check(csv.split('\r\n').length >= 7 && csv.includes("'=cmd|calc"), 'CSV export has a row per brew and defuses formulas');
    // Import the JSON back: same ids and updatedAt, so nothing changes; a copy with a newer edit updates one brew.
    const edited = JSON.parse(jsonText);
    const target = edited.records.find((r) => r.type === 'brew' && r.legacy);
    target.notes = 'Imported note'; target.updatedAt += 100000;
    const importPath = require('path').join(require('os').tmpdir(), `dot-scale-smoke-import-${process.pid}.json`);
    require('fs').writeFileSync(importPath, JSON.stringify(edited));
    await jp.setInputFiles('dialog[open] input[type=file]', importPath);
    await jp.waitForSelector('dialog[open] [role=status]:has-text("1 updated")');
    check(true, 'import merges by id: only the newer edit is applied');
    await jp.click('dialog[open] button:has-text("Done")');
    // Learn
    await jp.click('a.tab:has-text("Learn")');
    await jp.waitForSelector('[data-testid="learn-card"]');
    const all = await jp.locator('[data-testid="learn-card"]').count();
    await jp.click('button.pill:has-text("Espresso")');
    check(await jp.locator('[data-testid="learn-card"]').count() < all, 'Learn filters by topic');
    await jp.goto(url + '#/learn?card=ratio-and-strength');
    await jp.waitForSelector('.article h1:has-text("Ratio sets strength")');
    check(await jp.locator('.article svg.diagram').count() === 1 && await jp.locator('.article svg.diagram script').count() === 0, 'a card deep link opens it with its diagram');
    await jp.click('a.back');
    await jp.waitForSelector('.learn-progress');
    check(await jp.locator('.dot-new.read').count() === 1, 'the opened card is marked as seen');
    // Home nudge
    await jp.click('a.tab:has-text("Home")');
    await jp.waitForSelector('.home-title');
    check(await jp.locator('.nudge[data-nudge^="dialled-"]').count() === 1, 'Home shows a dialled-in note from the history');
    await jp.click('.nudge button:has-text("Dismiss")');
    await jp.waitForFunction(async () => !!(await window.dotScale.store.getMeta('pref:nudgeDismissed')), null, { timeout: 5000 }); // persisted before we reload
    await jp.reload();
    await jp.waitForSelector('.home-title');
    check(await jp.locator('.nudge[data-nudge^="dialled-"]').count() === 0, 'a dismissed nudge stays dismissed');
    check(errors.length === 0, `no page errors in Journal/Learn${errors.length ? ': ' + errors.join('; ') : ''}`);
    await jctx.close();
  } catch (e) { check(false, 'journal/learn: ' + e.message.split('\n').slice(0, 3).join(' | ')); }

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
