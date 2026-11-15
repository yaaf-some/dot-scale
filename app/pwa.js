// Offline support (sw.js). Not available in every browser (e.g. some iOS WebViews); the app works without it.
// Lives in a module, not inline in index.html, so the page can run under a strict CSP (script-src 'self').
//
// sw.js has no file list: it caches what the page loaded. Views load lazily, so once the page is idle we import the tab
// views (pulling in their whole module graph through the normal fetch path) and then hand the worker the list of
// everything that was loaded. Importing a view only runs its module-level code; nothing is mounted.
const TAB_VIEWS = ['home', 'brew', 'journal', 'learn', 'settings', 'onboarding'];
// Modules loaded on demand (dynamic import) that the views above do not import statically. Keep in step with the
// import() calls in app/; test/preload.test.mjs fails when one is missing here.
const LAZY = ['./ui/brew/result.js', './journal/nudge.js', './sync/client.js', './sync/store-adapter.js', './sync/passkey-probe.js'];

// Warm-up is background work: wait for real idle time, one import at a time, and skip it when the user asked to save data.
const saveData = () => navigator.connection?.saveData === true;
const whenIdle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 1500));

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      // Resolves when the worker has stored everything it was given (it replies on the port).
      const share = () => new Promise((done) => {
        const urls = [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]
          .filter((u) => new URL(u).origin === location.origin);
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => done();
        if (!reg.active) return done();
        reg.active.postMessage({ type: 'cache-urls', urls }, [port2]);
        setTimeout(done, 10000);
      });
      share();
      const warm = async () => {
        for (const m of [...TAB_VIEWS.map((v) => `./ui/views/${v}.js`), ...LAZY]) {
          try { await import(m); } catch { /* best effort */ }
        }
        await share();
        document.documentElement.dataset.offlineReady = ''; // everything the app needs offline is cached (also used by the smoke test)
      };
      const idle = () => { if (!saveData()) whenIdle(warm); };
      if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
    })
    .catch((e) => console.warn('Service worker not registered:', e));
}
