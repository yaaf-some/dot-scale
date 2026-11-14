// Guards for the Cloudflare static hosting config (no Cloudflare needed): private files stay private,
// and security headers stay in place.
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
    'wrangler.jsonc', 'package.json', 'CLAUDE.md', '.assetsignore', '.github']) {
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
  assert.match(h, /Strict-Transport-Security: max-age=31536000\s*$/m, 'HSTS: one year, no includeSubDomains, no preload');
  assert.ok(!/includeSubDomains|preload/i.test(h.replace(/#.*$/gm, '')), 'no includeSubDomains/preload in the headers');
  assert.match(h, /bluetooth=\(self\)/);
  assert.match(h, /connect-src 'self'/);
  assert.match(h, /object-src 'none'/);
  assert.match(h, /base-uri 'none'/);
  assert.match(h, /frame-ancestors 'none'/);
  // Everything the current shell loads is same-origin: no third-party hosts in the policy.
  assert.ok(!/https?:\/\//.test(h.split('\n').filter((l) => /Content-Security-Policy:/.test(l)).join('')), 'no external origins in the CSP');
});

test('wrangler.jsonc: Worker + assets from the repo root; only /api/* runs the Worker first', () => {
  const cfg = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.name, 'dot-scale');
  assert.equal(cfg.assets.directory, './');
  assert.equal(cfg.main, 'worker/index.js');
  assert.deepEqual(cfg.assets.run_worker_first, ['/api/*'], 'static files must never invoke the Worker');
  // Sync is optional: the D1 block may be commented out (the Worker answers 503 "sync not set up"). If it is enabled it must be
  // the right binding and must not still carry the placeholder id, which would make every deploy fail.
  if (cfg.d1_databases) {
    assert.equal(cfg.d1_databases[0].binding, 'DB');
    assert.equal(cfg.d1_databases[0].migrations_dir, 'migrations');
    assert.notEqual(cfg.d1_databases[0].database_id, 'REPLACE_WITH_D1_DATABASE_ID', 'D1 is enabled but the id is still the placeholder');
  }
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(cfg.previews && typeof cfg.previews === 'object', 'Workers Builds runs `wrangler preview` on non-production branches, which needs a previews block');
});

test('the app shell is in the repo root (what gets uploaded)', () => {
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

test("CSP stays tight: no 'unsafe-inline' unless something inline needs it", () => {
  const use = inlineUse();
  assert.ok(!(allowsInline('script-src') && !use.script), "script-src allows 'unsafe-inline' but nothing inline remains: use script-src 'self'");
  assert.ok(!(allowsInline('style-src') && !use.style), "style-src allows 'unsafe-inline' but nothing inline remains: use style-src 'self'");
});
