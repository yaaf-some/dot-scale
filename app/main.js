// Boot, router and view mounting. Views are plain modules; see "View contract" in CLAUDE.md.
//
//   app/ui/views/<name>.js   →   route #/<name>/<params…>?<query>
//   export const meta = { title: 'Journal', chrome: 'tabs' | 'none', keepOnProfileChange?: true }
//   export function mount(root, ctx) { …; return optionalCleanup }
//
// The shell never needs editing to add a view. Adding a *tab* does (TABS below).
import { openStore } from './core/store.js';
import { runFirstRun } from './core/bootstrap.js';
import { createScale } from './core/scale.js';
import { createRouter } from './ui/router.js';
import { applyTheme } from './ui/theme.js';
import { icon } from './ui/icons.js';
import { h, setChildren } from './ui/dom.js';
import { toast } from './ui/toast.js';
import './modules.js';

const TABS = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'brew', label: 'Brew', icon: 'brew' },
  { name: 'journal', label: 'Journal', icon: 'journal' },
  { name: 'learn', label: 'Learn', icon: 'learn' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];

const shell = document.getElementById('shell');
const host = document.getElementById('view');
const nav = document.getElementById('tabs');

let store, scale, router;
let current = { name: null, key: null, controller: null, cleanup: null, meta: {} };
let navToken = 0;

const sortProfiles = (list) => list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.name.localeCompare(b.name));

function renderTabs(active) {
  setChildren(nav, TABS.map((t) => h('a', { class: 'tab', href: `#/${t.name}`, 'aria-current': t.name === active ? 'page' : undefined }, icon(t.icon), h('span', {}, t.label))));
}

async function loadView(name) {
  try { return await import(`./ui/views/${name}.js`); } catch (e) { console.error(`view "${name}" failed to load`, e); return null; }
}

async function activeProfile() {
  const profiles = sortProfiles(await store.list('profile'));
  const id = store.prefs.get('activeProfile');
  return { profiles, profile: profiles.find((p) => p.id === id) ?? profiles[0] };
}

async function show(route, { sameView = false } = {}) {
  const token = ++navToken;
  if (!store.prefs.get('onboarded') && route.name !== 'onboarding') return router.navigate('/onboarding', { replace: true });

  let name = route.name;
  let mod = await loadView(name);
  if (!mod) { name = 'home'; mod = await loadView('home'); if (route.name !== 'home') router.navigate('/home', { replace: true }); }
  if (token !== navToken) return;

  const { profiles, profile } = await activeProfile();
  if (token !== navToken) return;

  current.controller?.abort();
  try { current.cleanup?.(); } catch (e) { console.error(e); }
  const controller = new AbortController();
  const meta = mod.meta ?? {};
  const scrollY = sameView ? window.scrollY : 0;

  const ctx = {
    store, scale, prefs: store.prefs, profile, profiles,
    route, params: route.params, query: route.query,
    signal: controller.signal,
    navigate: (path, opts) => router.navigate(path, opts),
    setProfile: (id) => store.prefs.set('activeProfile', id),
    setTitle: (t) => { document.title = `${t} · Dot Scale`; },
    toast,
  };
  const root = h('div', { class: 'view', dataset: { view: name } });

  const swap = async () => {
    setChildren(host, root);
    shell.dataset.chrome = meta.chrome ?? 'tabs';
    renderTabs(name);
    ctx.setTitle(meta.title ?? name);
    let cleanup;
    try { cleanup = await mod.mount(root, ctx); } catch (e) {
      console.error(`view "${name}" crashed`, e);
      setChildren(root, h('div', { class: 'empty' }, h('h2', {}, 'Something went wrong'), h('p', {}, 'This screen couldn’t load. Go back to Home and try again.'), h('a', { class: 'btn primary', href: '#/home' }, 'Back to Home')));
    }
    current = { name, key: route.path, controller, cleanup: typeof cleanup === 'function' ? cleanup : null, meta };
    window.scrollTo(0, scrollY);
    if (!sameView) host.focus({ preventScroll: true });
  };

  const animate = !sameView && current.name && current.name !== name && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate) await document.startViewTransition(swap).updateCallbackDone; else await swap();
}

function rerenderSoon() {
  clearTimeout(rerenderSoon.t);
  rerenderSoon.t = setTimeout(() => { if (!current.meta.keepOnProfileChange) show(router.current ?? { name: current.name, params: [], query: {}, path: current.key }, { sameView: true }); }, 30);
}

async function boot() {
  store = await openStore();
  await runFirstRun(store);
  applyTheme(store.prefs.get('theme', 'system'));
  scale = createScale({ prefs: store.prefs });

  store.on('pref', ({ key }) => { if (key === 'theme') applyTheme(store.prefs.get('theme', 'system')); if (key === 'activeProfile') rerenderSoon(); });
  // Profile edits re-mount the current view (ctx.profile is a snapshot). Home also follows data that sync can bring in.
  store.on('change', ({ type }) => { if (type === 'profile' || (current.name === 'home' && ['recipe', 'brew', 'bean'].includes(type))) rerenderSoon(); });
  store.on('reset', () => location.reload());

  router = createRouter((route) => { router.current = route; show(route); });
  router.start();

  // Reconnect to the scale this device used before, once at start and whenever the app comes back to the foreground.
  const tryAuto = () => { if (store.prefs.get('onboarded') && scale.state.status === 'disconnected') scale.autoConnect(); };
  tryAuto();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tryAuto(); });

  window.dotScale = { store, scale }; // handy in the console and in tests
}

boot().catch((e) => {
  console.error(e);
  setChildren(host, h('div', { class: 'view' }, h('div', { class: 'empty' }, h('h2', {}, 'Dot Scale couldn’t start'), h('p', {}, `${e.message}. Reload the page; if it keeps happening, clear this site’s data.`))));
});
