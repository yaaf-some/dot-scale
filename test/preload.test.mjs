// index.html preloads the critical module graph so the browser fetches it in parallel instead of discovering it level by
// level. There is no build step to generate that list, so this test keeps it honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { criticalModules, importGraph, rel } from './helpers/import-graph.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);

test('index.html modulepreload list matches the static import graph (run: node scripts/preload-links.mjs)', () => {
  const want = criticalModules(root);
  assert.deepEqual([...preloaded].sort(), [...want].sort(),
    'preload list drifted from the imports of app/main.js + views/home.js. Regenerate with: node scripts/preload-links.mjs');
});

test('the main stylesheets are fetched at high priority', () => {
  for (const css of ['app/ui/tokens.css', 'app/ui/app.css']) assert.match(html, new RegExp(`<link rel="stylesheet" href="${css}" fetchpriority="high">`));
});

test('cold start is shallow and heavy code stays out of it', () => {
  const g = importGraph(join(root, 'app/main.js'));
  const files = [...g.files.keys()].map((f) => rel(root, f));
  assert.ok(g.depth <= 4, `static import chain from main.js is ${g.depth} deep`);
  for (const lazy of ['app/insights/analyze.js', 'app/sync/client.js', 'app/ui/brew/result.js', 'app/ui/brew/live.js']) {
    assert.ok(!files.includes(lazy) && !preloaded.includes(lazy), `${lazy} must be loaded on demand, not at start`);
  }
});

// Every dynamic import() of a literal path in app/ (other than views, which TAB_VIEWS covers) must be warmed by pwa.js,
// or the feature would not work offline on a device that never used it online.
test('pwa.js warms every lazily imported module', () => {
  const pwa = readFileSync(join(root, 'app/pwa.js'), 'utf8');
  const warm = new Set([...pwa.matchAll(/'\.\/([^']+\.js)'/g)].map((m) => `app/${m[1]}`));
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.js') ? [join(d, n)] : []));
  for (const f of walk(join(root, 'app'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bimport\(\s*(?:\n\s*)?'([^']+)'/g)) {
      const target = rel(root, join(f, '..', m[1]));
      assert.ok(warm.has(target), `${rel(root, f)} lazily imports ${target}; add it to LAZY in app/pwa.js`);
    }
  }
});
