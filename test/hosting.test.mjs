// Guards for the Cloudflare static hosting config (no Cloudflare needed): private files stay private,
// security headers stay in place, and Vercel's deploy keeps ignoring the Cloudflare-only files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const lines = (f) => read(f).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// `.assetsignore` uses gitignore syntax: "/docs" ignores only the root folder, "docs" would also hide app/docs/.
const ignored = (name) => lines('.assetsignore').some((l) => l === name || l === `/${name}`);
const ignoredAtRootOnly = (name) => lines('.assetsignore').includes(`/${name}`);

test('.assetsignore keeps private files out of the public site, and not the app itself', () => {
  for (const must of ['.git', '.claude', '.env*', 'node_modules', 'test', 'docs', 'scripts', 'worker', 'migrations',
    'wrangler.jsonc', 'package.json', 'CLAUDE.md', '.assetsignore', '.vercelignore', '.github']) {
    assert.ok(ignored(must), `.assetsignore must list ${must}`);
  }
  for (const pub of ['index.html', 'protocol.js', 'app', 'sw.js', 'icons', 'manifest.webmanifest', 'icon.svg']) {
    assert.ok(!ignored(pub), `${pub} is part of the app and must be served`);
  }
  // Root-only folders must be anchored so app/docs/, app/test/, app/scripts/ (future modules) are still served.
  for (const dir of ['test', 'docs', 'scripts', 'worker', 'migrations']) assert.ok(ignoredAtRootOnly(dir), `anchor it as /${dir}`);
});

// Workers Builds deploys from git, so only TRACKED files can ever be published. Every tracked top-level entry must be a
// conscious choice: public on purpose (listed here) or ignored. A new file/folder at the top level fails this until someone
// decides; add public ones to PUBLIC below, private ones to .assetsignore.
const PUBLIC = new Set(['index.html', 'protocol.js', 'app', 'sw.js', 'icons', 'manifest.webmanifest', 'icon.svg', '_headers']);
test('every tracked top-level file or folder is either public on purpose or listed in .assetsignore', () => {
  const top = [...new Set(execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: new URL('../', import.meta.url) })
    .split('\n').filter(Boolean).map((f) => f.split('/')[0]))];
  const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const patterns = lines('.assetsignore').map((l) => globToRe(l.replace(/^\//, '')));
  const unaccounted = top.filter((n) => !PUBLIC.has(n) && !patterns.some((re) => re.test(n)));
  assert.deepEqual(unaccounted, [], `these top-level entries would be PUBLISHED on Cloudflare: ${unaccounted.join(', ')}. ` +
    'Add private ones to .assetsignore, or add public ones to PUBLIC in test/hosting.test.mjs.');
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

test('wrangler.jsonc: Worker + assets from the repo root; only /api/* runs the Worker first', () => {
  const cfg = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.name, 'dot-scale');
  assert.equal(cfg.assets.directory, './');
  assert.equal(cfg.main, 'worker/index.js');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*'], 'static files must never invoke the Worker');
  assert.equal(cfg.d1_databases[0].binding, 'DB');
  assert.equal(cfg.d1_databases[0].migrations_dir, 'migrations');
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

// --- CSP must match what the shell actually does -----------------------------------------------------------------
const directive = (name) => (read('_headers').match(new RegExp(`Content-Security-Policy:.*?\\b${name} ([^;]*)`)) || [])[1] || '';
const allowsInline = (name) => directive(name).includes("'unsafe-inline'");

function appJsFiles(dir = new URL('../app/', import.meta.url).pathname) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? appJsFiles(p) : n.endsWith('.js') ? [p] : [];
  });
}
/** What the page does that a strict CSP would block. */
function inlineUse() {
  const html = read('index.html');
  const js = appJsFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
  return {
    script: /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html) || /\son(click|input|change|submit|load|error)\s*=/i.test(html),
    style: /<style[\s>]/i.test(html) || /\sstyle\s*=/i.test(html)
      || /\sstyle\s*=\s*["'\\]/.test(js) || /setAttribute\(\s*['"]style['"]/.test(js),
  };
}

test("CSP doesn't block what index.html and app/ actually do (inline script/style need 'unsafe-inline')", () => {
  const use = inlineUse();
  if (use.script) assert.ok(allowsInline('script-src'), "index.html has an inline script: script-src needs 'unsafe-inline' or the app is blank on Cloudflare");
  if (use.style) assert.ok(allowsInline('style-src'), "the page uses inline styles: style-src needs 'unsafe-inline' or they are dropped");
});

test("CSP can be tightened: no 'unsafe-inline' for script/style once nothing needs it", { todo: 'tighten _headers (see the TODO there) after the new app shell lands' }, () => {
  const use = inlineUse();
  assert.ok(!(allowsInline('script-src') && !use.script), "script-src still allows 'unsafe-inline' but nothing inline remains: use script-src 'self'");
  assert.ok(!(allowsInline('style-src') && !use.style), "style-src still allows 'unsafe-inline' but nothing inline remains: use style-src 'self'");
});
