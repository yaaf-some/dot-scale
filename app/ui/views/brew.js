// Brew: method → recipe → prep → live → result (docs/PRODUCT.md §3-4). One route, several screens kept in memory:
//   #/brew                         the method picker (last used first)
//   #/brew/<method>                the recipe screen, prefilled from the profile's last brew of that method
//   #/brew/<method>?recipe=<id>    …from a saved recipe  /  ?brew=<id> from a past brew (Home's "Brew again" tickets)
// Screens live in app/ui/brew/. The session logic is app/core/brew-session.js; this file only moves between screens.
import { h, setChildren } from '../dom.js';
import { getMethod } from '../../methods/index.js';
import { startingRecipe, shouldKeepPartial, buildPartialBrew } from '../../core/brew-record.js';
import { uuid } from '../../core/store.js';
import { renderPicker } from '../brew/picker.js';
import { renderRecipe } from '../brew/recipe.js';
import { renderPrep } from '../brew/prep.js';
import { renderLive } from '../brew/live.js';
import { createRunner } from '../brew/runner.js';
import { createWakeLock } from '../brew/wake-lock.js';

// Never re-mount mid-brew when a profile or sync change arrives: the live session would be lost.
export const meta = { title: 'Brew', keepOnProfileChange: true };

// Flow styles live next to the screens. Requested when this module loads (the offline warm-up imports it, which caches the
// file too) and awaited before the first mount so there is no unstyled flash.
const styles = (() => {
  if (typeof document === 'undefined') return Promise.resolve();
  const href = new URL('../brew/brew.css', import.meta.url).href;
  let link = [...document.head.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === href);
  if (!link) { link = h('link', { rel: 'stylesheet', href }); document.head.append(link); }
  if (link.sheet) return Promise.resolve();
  return new Promise((done) => { link.addEventListener('load', done, { once: true }); link.addEventListener('error', done, { once: true }); setTimeout(done, 3000); });
})();

const SCREENS = { recipe: renderRecipe, prep: renderPrep, live: renderLive };
// The result screen pulls in the insights engine (~47 KB), so it loads on demand. It is requested as soon as a brew is being
// prepared, long before it is needed, and the offline warm-up (pwa.js) caches it too.
const loadResult = () => import('../brew/result.js').then((m) => m.renderResult);

export async function mount(root, ctx) {
  await styles;
  const { store, profile } = ctx;
  const [recipes, brews, beans] = await Promise.all([store.list('recipe'), store.list('brew'), store.list('bean')]);
  const methodId = ctx.params[0];
  const method = getMethod(methodId);

  const flow = h('div', { class: 'brew-flow', 'data-stage': 'picker' });
  root.append(flow);
  if (!method) { renderPicker(flow, ctx, { brews }); return; }

  const start = startingRecipe({ method: method.id, profile, recipes, brews, recipeId: ctx.query.recipe ?? ctx.query.recipeId, brewId: ctx.query.brew });
  const wake = createWakeLock();
  const stage = h('div', { class: 'brew-stage' });
  flow.append(stage);

  const F = {
    ctx, method,
    recipe: start.recipe, recipeId: start.recipeId, source: start.source,
    beans, beanId: beans.some((b) => b.id === start.recipe.beanId && !b.deleted) ? start.recipe.beanId : null,
    history: brews.filter((b) => b.profileId === profile?.id && b.method === method.id && !b.incomplete),
    run: null, brewId: null, taste: null, notes: '',
    stage: null,
    go(name) {
      if (name === 'prep' || name === 'live') wake.start(); else wake.stop();
      if (name === 'prep') F.cancelled = false;
      if (name === 'prep' && !F.run) F.run = createRunner({ scale: ctx.scale, prefs: ctx.prefs, method, recipe: { ...F.recipe, ...(F.beanId ? { beanId: F.beanId } : {}) }, history: F.history, profileId: profile?.id });
      if (name === 'recipe') endRun();
      closeStage();
      flow.dataset.stage = name; F.stage = name;
      setChildren(stage);
      delete stage.dataset.phase; delete stage.dataset.hit;
      const mine = ++renders;
      const draw = (render) => {
        const cleanup = render(stage, F);
        if (mine === renders) stageCleanup = cleanup; else try { cleanup?.(); } catch (e) { console.error(e); } // a screen switched again while rendering
      };
      if (name === 'result') loadResult().then((render) => { if (mine === renders) draw(render); }, (e) => { console.error('result screen failed to load', e); ctx.toast('Couldn’t open the result. Check your connection.'); });
      else draw(SCREENS[name]);
      if (name === 'prep') loadResult().catch(() => {}); // warm it up; failure is handled when it is really needed
      scrollTo(0, 0);
    },
    /** Abandon the brew: nothing is saved. Back to the recipe. */
    cancel() {
      F.cancelled = true;
      if (F.brewId) { store.delete(F.brewId).catch(() => {}); F.brewId = null; } // an interrupted copy saved earlier goes too
      F.go('recipe');
    },
    /** Finished (saved or discarded): leave the flow. */
    done() { ctx.navigate('/home'); },
  };

  let stageCleanup = null, renders = 0;
  const closeStage = () => { try { stageCleanup?.(); } catch (e) { console.error(e); } stageCleanup = null; };
  const endRun = () => { F.run?.destroy(); F.run = null; };

  // A shot that has started is never lost: leaving the live screen by any route (Back, swipe-back, tab, page hidden) saves
  // the run so far as an `incomplete` Brew. If the shot carries on, the finished brew replaces it (same id).
  const keepPartial = () => {
    if (F.stage !== 'live' || !F.run || F.cancelled || F.run.state.phase !== 'running') return;
    const record = F.run.session.record();
    if (!shouldKeepPartial(record)) return;
    F.brewId ??= uuid();
    const startedAt = F.run.startedAt ?? Date.now() - record.timeS * 1000;
    store.put(buildPartialBrew({ id: F.brewId, record, profile, recipe: F.recipe, recipeId: F.recipeId, beanId: F.beanId, startedAt })).catch((e) => console.error('saving the interrupted brew failed', e));
  };
  const onHide = () => { if (document.visibilityState === 'hidden') keepPartial(); };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', keepPartial);

  F.go('recipe');
  return () => {
    keepPartial();
    document.removeEventListener('visibilitychange', onHide);
    removeEventListener('pagehide', keepPartial);
    closeStage(); endRun(); wake.stop();
  };
}
