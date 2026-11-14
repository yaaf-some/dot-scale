// Hash router: "#/brew/espresso?recipe=abc" → { name: 'brew', params: ['espresso'], query: { recipe: 'abc' } }.
// Pure parse/format functions are exported for tests; the DOM listener is in createRouter().
export const DEFAULT_ROUTE = 'home';

export function parseRoute(hash = '') {
  const raw = String(hash).replace(/^#/, '');
  const [path, qs = ''] = raw.split('?');
  const segs = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const name = /^[a-z][a-z0-9-]*$/.test(segs[0] ?? '') ? segs[0] : DEFAULT_ROUTE;
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { name, params: segs[0] === name ? segs.slice(1) : [], query, path: `/${[name, ...(segs[0] === name ? segs.slice(1) : [])].join('/')}` };
}

export function formatRoute(path, query) {
  const base = '#' + (path.startsWith('/') ? path : `/${path}`);
  const qs = query ? new URLSearchParams(query).toString() : '';
  return qs ? `${base}?${qs}` : base;
}

export function createRouter(onRoute) {
  const run = () => onRoute(parseRoute(location.hash));
  addEventListener('hashchange', run);
  return {
    start: run,
    navigate(path, { replace = false } = {}) {
      const next = path.startsWith('#') ? path : formatRoute(path);
      if (replace) { history.replaceState(null, '', next); run(); } else if (location.hash === next) run(); else location.hash = next;
    },
  };
}
