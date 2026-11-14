// One-off icon generator: renders icon.svg to the PNGs in icons/ with the preinstalled Playwright.
// Not a build step — the PNGs are committed. Re-run after editing icon.svg: node scripts/make-icons.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  .replace(/<rect width="64" height="64" rx="14" fill="([^"]+)"\/>/, ''); // drop the rounded background
const bg = (svg.match(/<rect width="64" height="64" rx="14" fill="([^"]+)"/) || [, '#16120f'])[1];

// full: square background (iOS/Android apply their own corner mask). maskable: art scaled into the 80% safe zone.
const variants = {
  full: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>${inner}</svg>`,
  any: svg,
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><g transform="translate(6.4 6.4) scale(0.8)">${inner}</g></svg>`,
};
const outputs = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['icon-maskable-192.png', 192, 'maskable'],
  ['icon-maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'full'],
];

(async () => {
  const browser = await chromium.launch();
  for (const [name, size, variant] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const html = `<html><body style="margin:0;background:transparent">${variants[variant].replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
    await page.setContent(html);
    await page.screenshot({ path: path.join(root, 'icons', name), omitBackground: true });
    await page.close();
    console.log('wrote icons/' + name);
  }
  await browser.close();
})();
