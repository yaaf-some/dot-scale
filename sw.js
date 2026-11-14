// Service worker: keeps the installed app usable offline. There is no file list to maintain.
// - Pages (navigations): network-first, so a new deploy shows up on the next load; cached copy when offline.
// - Other same-origin GETs (app/ modules, CSS, icons, ...): stale-while-revalidate. Served from cache when present,
//   refreshed in the background, so a deploy reaches assets one load after it reaches the page.
// - Never cached: /api/ (sync carries the household code), non-GET requests, other origins.
// The page posts the URLs it loaded before this worker took control (see index.html), so the very first visit is
// also cached. Bump VERSION to drop every old cache at once.
const VERSION = 'v2';
const CACHE = `dot-scale-${VERSION}`;
const SHELL = ['./', 'manifest.webmanifest'];

const cacheable = (url) => url.origin === self.location.origin && !url.pathname.startsWith('/api/')
  && url.href !== self.location.href; // never this worker script itself
const isShellPage = (url) => {
  const scope = new URL('./', self.registration.scope).pathname;
  return url.pathname === scope || url.pathname === scope + 'index.html';
};
const storable = (res) => res && res.ok && res.type === 'basic';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dot-scale-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// { type: 'cache-urls', urls: [...] } from the page: fetch and store anything not cached yet. Replies on the port when done.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'cache-urls' || !Array.isArray(msg.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(msg.urls.map(async (href) => {
      try {
        const url = new URL(href, self.location.href);
        if (!cacheable(url) || (await cache.match(url.href))) return;
        const res = await fetch(url.href);
        if (storable(res)) await cache.put(url.href, res);
      } catch { /* best effort */ }
    }));
    event.ports[0]?.postMessage('done');
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || !cacheable(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (storable(res)) await cache.put(isShellPage(url) ? './' : req, res.clone());
        return res;
      } catch (err) {
        const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req, { cache: 'no-cache' })
      .then(async (res) => { if (storable(res)) await cache.put(req, res.clone()); return res; });
    if (hit) {
      event.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  })());
});
