// Browser smoke test: serves the app, runs Demo mode, simulates a brew, saves and exports it,
// and fails on page errors. Uses the preinstalled Playwright (cloud sessions) or a local `npm i -g playwright`.
const { chromium } = require('playwright');
const { readFile } = require('node:fs/promises');

(async () => {
  const { start } = await import('../scripts/serve.mjs');
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  // A v1 history entry, as stored before history.js existed: it must survive and still open.
  await context.addInitScript(() => {
    if (!localStorage.getItem('dot.history'))
      localStorage.setItem('dot.history', JSON.stringify([{ at: 1700000000000, dose: 15, out: 240, time: 180 }]));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
  try {
    await page.goto(url);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dot.history')));
    check(stored.length === 1 && stored[0].id && stored[0].out === 240, 'v1 history entry is migrated in place');
    await page.click('#history .shot .open');
    check(await page.locator('#brewNoGraph').isVisible(), 'old entry without samples opens and says there is no graph');
    await page.click('#brewClose');

    await page.click('#demoBtn');
    await page.waitForFunction(() => !document.querySelector('#tareBtn').disabled, null, { timeout: 5000 });
    check(true, 'demo connects and enables controls');
    await page.click('#startBtn');
    await page.waitForTimeout(3000);
    const text = await page.locator('.readout').innerText();
    const grams = parseFloat((text.match(/-?\d+(\.\d)?/) || ['0'])[0]);
    check(grams > 1, `weight rises during simulated pour (readout: ${text.replace(/\s+/g, ' ').slice(0, 60)})`);

    await page.click('#saveBtn');
    await page.waitForSelector('#brewDialog[open]');
    check(await page.locator('#brewChart').isVisible(), 'saved brew opens its details with a pour graph');
    await page.fill('#noteBean', 'Smoke Test Kenya');
    await page.fill('#noteGrind', '18 clicks');
    await page.selectOption('#noteRating', '4');
    await page.click('#brewSave');
    await page.waitForFunction(() => /Smoke Test Kenya/.test(localStorage.getItem('dot.history')));
    const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('dot.history')));
    const brew = hist[hist.length - 1];
    check(hist.length === 2 && brew.samples?.length >= 2 && brew.samples.length <= 150, `brew saved with ${brew.samples?.length} samples`);
    check(brew.notes?.bean === 'Smoke Test Kenya' && brew.notes.rating === 4, 'notes saved with the brew');
    check((await page.locator('#history .shot').first().innerText()).includes('Smoke Test Kenya'), 'history list shows the notes');

    const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('#exportJsonBtn')]);
    const exported = JSON.parse(await readFile(await jsonDl.path(), 'utf8'));
    check(exported.format === 'dot-scale-history' && exported.history.length === 2, `JSON export (${jsonDl.suggestedFilename()})`);
    const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    const csv = await readFile(await csvDl.path(), 'utf8');
    check(csv.startsWith('date,') && csv.includes('Smoke Test Kenya'), 'CSV export');

    // Clear history, then import the export back: everything returns, duplicates merge.
    await page.evaluate(() => localStorage.setItem('dot.history', '[]'));
    await page.setInputFiles('#importFile', await jsonDl.path());
    await page.setInputFiles('#importFile', await jsonDl.path());
    await page.waitForFunction(() => /Imported 2 brews: 0 new/.test(document.querySelector('#historyMsg').textContent));
    const back = await page.evaluate(() => JSON.parse(localStorage.getItem('dot.history')));
    check(back.length === 2 && back[1].samples?.length === brew.samples.length, 'import restores history without duplicates');

    check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
    if (process.env.SCREENSHOT) {
      await page.click('#history .shot .open');
      await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
    }
  } catch (e) { check(false, e.message); }
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
})();
