// Service worker: keeps the app shell available offline.
// Network-first for everything same-origin, so a new Vercel deploy shows up on the next load;
// the cache is only the fallback when the network is unavailable. Bump VERSION when the shell list changes.
const VERSION = 'v1';
const CACHE = `dot-scale-${VERSION}`;
const SHELL = [
  './', 'index.html', 'protocol.js', 'icon.svg', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Bypass the HTTP cache so the network copy is always the deployed one.
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req.mode === 'navigate' ? './' : req, res.clone());
      return res;
    } catch (err) {
      const hit = req.mode === 'navigate'
        ? (await cache.match('./')) || (await cache.match('index.html'))
        : await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
