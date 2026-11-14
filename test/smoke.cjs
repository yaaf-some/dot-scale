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
  await browser.close(); server.close();
  process.exit(failed ? 1 : 0);
})();
