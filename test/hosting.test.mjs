// Guards for the Cloudflare static hosting config (no Cloudflare needed): private files stay private,
// security headers stay in place, and Vercel's deploy keeps ignoring the Cloudflare-only files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const lines = (f) => read(f).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('.assetsignore keeps private files out of the public site, and not the app itself', () => {
  const ignore = lines('.assetsignore');
  for (const must of ['.git', '.claude', '.env*', 'node_modules', 'test', 'docs', 'scripts', 'worker', 'migrations',
    'wrangler.jsonc', 'package.json', 'CLAUDE.md', '.assetsignore', '.vercelignore']) {
    assert.ok(ignore.includes(must), `.assetsignore must list ${must}`);
  }
  for (const pub of ['index.html', 'protocol.js', 'app', 'manifest.webmanifest', 'icon.svg']) {
    assert.ok(!ignore.includes(pub), `${pub} is part of the app and must be served`);
  }
});

test('_headers: security headers, Bluetooth stays allowed for the app, CSP is as tight as the shell allows', () => {
  const h = read('_headers');
  for (const name of ['Strict-Transport-Security', 'X-Content-Type-Options: nosniff', 'Referrer-Policy', 'Content-Security-Policy', 'Permissions-Policy']) {
    assert.ok(h.includes(name), name);
  }
  assert.match(h, /bluetooth=\(self\)/);
  assert.match(h, /connect-src 'self'/);
  assert.match(h, /object-src 'none'/);
  assert.match(h, /base-uri 'none'/);
  assert.match(h, /frame-ancestors 'none'/);
  assert.match(h, /TODO/, 'the unsafe-inline CSP must carry a TODO to tighten it');
  // Everything the current shell loads is same-origin: no third-party hosts in the policy.
  assert.ok(!/https?:\/\//.test(h.split('\n').filter((l) => /Content-Security-Policy:/.test(l)).join('')), 'no external origins in the CSP');
});

test('wrangler.jsonc: assets-only Worker serving the repo root', () => {
  const cfg = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.name, 'dot-scale');
  assert.equal(cfg.assets.directory, './');
  assert.equal(cfg.main, undefined, 'no Worker code in the hosting-only setup');
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('Vercel keeps deploying the static app and ignores the Cloudflare-only files', () => {
  const v = lines('.vercelignore');
  for (const f of ['wrangler.jsonc', '.assetsignore', '_headers']) assert.ok(v.includes(f), `.vercelignore must list ${f}`);
  assert.ok(!existsSync(new URL('../api/', import.meta.url)), 'no api/ directory: Vercel would treat it as functions');
  assert.ok(!existsSync(new URL('../vercel.json', import.meta.url)));
  assert.ok(readdirSync(new URL('../', import.meta.url)).includes('index.html'));
});

test('the pages the app loads exist in the repo root (what gets uploaded)', () => {
  const html = read('index.html');
  for (const ref of ['manifest.webmanifest', 'icon.svg']) {
    assert.ok(html.includes(ref) && existsSync(new URL(`../${ref}`, import.meta.url)), ref);
  }
});
