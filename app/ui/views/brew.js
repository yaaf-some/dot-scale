// Brew: method → recipe → prep → live → result (docs/PRODUCT.md §3-4). One route, several screens kept in memory:
//   #/brew                         the method picker (last used first)
//   #/brew/<method>                the recipe screen, prefilled from the profile's last brew of that method
//   #/brew/<method>?recipe=<id>    …from a saved recipe  /  ?brew=<id> from a past brew (Home's "Brew again" tickets)
// Screens live in app/ui/brew/. The session logic is app/core/brew-session.js; this file only moves between screens.
import { h, setChildren } from '../dom.js';
import { getMethod } from '../../methods/index.js';
import { startingRecipe } from '../../core/brew-record.js';
import { renderPicker } from '../brew/picker.js';
import { renderRecipe } from '../brew/recipe.js';
import { renderPrep } from '../brew/prep.js';
import { renderLive } from '../brew/live.js';
import { renderResult } from '../brew/result.js';
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

const SCREENS = { recipe: renderRecipe, prep: renderPrep, live: renderLive, result: renderResult };

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
    history: brews.filter((b) => b.profileId === profile?.id && b.method === method.id),
    run: null, brewId: null, taste: null, notes: '',
    stage: null,
    go(name) {
      if (name === 'prep' || name === 'live') wake.start(); else wake.stop();
      if (name === 'prep' && !F.run) F.run = createRunner({ scale: ctx.scale, prefs: ctx.prefs, method, recipe: { ...F.recipe, ...(F.beanId ? { beanId: F.beanId } : {}) }, history: F.history, profileId: profile?.id });
      if (name === 'recipe') endRun();
      closeStage();
      flow.dataset.stage = name; F.stage = name;
      setChildren(stage);
      delete stage.dataset.phase; delete stage.dataset.hit;
      const mine = ++renders;
      const cleanup = SCREENS[name](stage, F);
      if (mine === renders) stageCleanup = cleanup; else try { cleanup?.(); } catch (e) { console.error(e); } // a screen switched again while rendering
      scrollTo(0, 0);
    },
    /** Abandon the brew: nothing is saved. Back to the recipe. */
    cancel() { F.go('recipe'); },
    /** Finished (saved or discarded): leave the flow. */
    done() { ctx.navigate('/home'); },
  };

  let stageCleanup = null, renders = 0;
  const closeStage = () => { try { stageCleanup?.(); } catch (e) { console.error(e); } stageCleanup = null; };
  const endRun = () => { F.run?.destroy(); F.run = null; };

  F.go('recipe');
  return () => { closeStage(); endRun(); wake.stop(); };
}
