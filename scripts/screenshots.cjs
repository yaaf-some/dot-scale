// Regenerates docs/design/*.png (iPhone and iPad viewports, deviceScaleFactor 2) from the running app with demo data.
// Usage: node scripts/screenshots.cjs   (needs the preinstalled Playwright)
const { chromium } = require('playwright');
const path = require('path');
const out = path.resolve(__dirname, '../docs/design');

(async () => {
  const { start } = await import('./serve.mjs');
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const shots = [
    { name: 'iphone-light-onboarding', vp: { width: 390, height: 844 }, scheme: 'light', go: 'onboarding' },
    { name: 'iphone-light-home', vp: { width: 390, height: 844 }, scheme: 'light', go: 'home' },
    { name: 'iphone-dark-home', vp: { width: 390, height: 844 }, scheme: 'dark', go: 'home' },
    { name: 'ipad-light-home', vp: { width: 1024, height: 768 }, scheme: 'light', go: 'home' },
    { name: 'ipad-dark-settings', vp: { width: 1024, height: 768 }, scheme: 'dark', go: 'settings' },
  ];
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: 2, colorScheme: s.scheme });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector('.onboard');
    if (s.go !== 'onboarding') {
      await page.click('button:has-text("Skip")');
      await page.waitForSelector('.home-title');
      await page.evaluate(async () => {
        const { store, scale } = window.dotScale;
        const yaaf = (await store.list('profile')).find((p) => p.name === 'Yaaf');
        await store.setMeta('noop', 1);
        const bean = await store.put({ type: 'bean', name: 'Ethiopia Guji', roaster: 'Dak', roastDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10), process: 'Natural' });
        await store.put({ type: 'recipe', profileId: yaaf.id, method: 'espresso', name: 'House shot', dose: 16, yield: 32, ratio: 2, favorite: true, beanId: bean.id });
        await store.put({ type: 'brew', profileId: yaaf.id, method: 'pour-over', gear: {}, startedAt: Date.now() - 2 * 86400000, dose: 15, yield: 250, targetYield: 250, ratio: 16.7, timeS: 190, metrics: {}, insights: {} });
        await store.put({ type: 'brew', profileId: yaaf.id, method: 'espresso', gear: {}, startedAt: Date.now() - 86400000, dose: 16.2, yield: 36, targetYield: 36, ratio: 2.2, timeS: 24, metrics: {}, insights: {}, beanId: bean.id });
        await scale.startDemo();
      });
      await page.waitForSelector('.ticket:has-text("Pour-over")');
      if (s.go === 'settings') { await page.click('a.tab:has-text("Settings")'); await page.waitForSelector('#profiles'); }
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(out, `${s.name}.png`) });
    console.log('wrote', s.name);
    await ctx.close();
  }
  await browser.close(); server.close();
})();
