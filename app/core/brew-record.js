// Glue between the brew session, the insights engine and the store (docs/PRODUCT.md §6). Pure functions plus two small
// store writers; no DOM. The Brew flow (app/ui/views/brew.js and app/ui/brew/*) is the only caller.
//
//   methodOrder(profile, brews)                   method ids, last-used first
//   startingRecipe({ method, profile, recipes, brews, recipeId, brewId })   what the Recipe screen is prefilled with
//   buildBrew({ id, ... record, ... })            a Brew record from session.record() + the screen's choices
//   saveBrew(store, brew) / saveProfileRecipe(store, ...)
import { METHODS, defaultRecipe, getMethod, linkRecipe, ratioOf, round } from '../methods/index.js';
import { uuid } from './store.js';

const live = (r) => r && !r.deleted;
const newest = (a, b) => (b.startedAt ?? b.updatedAt ?? 0) - (a.startedAt ?? a.updatedAt ?? 0);

/** Method ids for the picker: methods this profile brewed (most recent first), then the ones it chose in onboarding, then the rest. */
export function methodOrder(profile, brews = []) {
  const out = [];
  const add = (id) => { if (getMethod(id) && !out.includes(id)) out.push(id); };
  for (const b of brews.filter((x) => live(x) && (!profile || x.profileId === profile.id)).sort(newest)) add(b.method);
  for (const id of profile?.methods ?? []) add(id);
  for (const m of METHODS) add(m.id);
  return out;
}

/** A recipe (not a record) rebuilt from a past brew: its *target* yield is what the brew aimed for. */
export function recipeFromBrew(brew) {
  const m = getMethod(brew.method);
  if (!m) return null;
  const base = defaultRecipe(brew.method);
  const dose = brew.dose > 0 ? brew.dose : base.dose;
  const yld = brew.targetYield > 0 ? brew.targetYield : brew.yield > 0 ? brew.yield : base.yield;
  const out = { ...base, dose, yield: yld, ratio: ratioOf(dose, yld) ?? base.ratio };
  if (brew.tempC != null) out.tempC = brew.tempC;
  if (brew.grind) out.grind = { ...brew.grind };
  if (brew.gear?.portafilter) out.portafilter = brew.gear.portafilter;
  if (brew.beanId) out.beanId = brew.beanId;
  return out;
}

/** A recipe from a stored Recipe record: method defaults underneath, so older records missing fields still work. */
export function recipeFromRecord(rec) {
  const base = defaultRecipe(rec.method);
  if (!base) return null;
  const out = { ...base, ...rec };
  for (const k of ['id', 'type', 'updatedAt', 'profileId', 'favorite', 'deleted']) delete out[k];
  out.method = rec.method;
  out.name = rec.name ?? base.name;
  if (!(rec.ratio > 0)) out.ratio = ratioOf(out.dose, out.yield) ?? base.ratio;
  return out;
}

/**
 * The recipe to prefill: an explicit recipe record or past brew (Brew again), else the profile's last brew of the method,
 * else the method's defaults. Espresso always carries a portafilter (the profile's default, else spouted).
 * Returns { recipe, recipeId, source: 'recipe'|'brew'|'last'|'default' }.
 */
export function startingRecipe({ method, profile, recipes = [], brews = [], recipeId, brewId }) {
  const mine = (r) => live(r) && (!profile || r.profileId === profile.id) && r.method === method;
  let recipe = null, source = 'default', usedRecipeId = null;
  const rec = recipeId && recipes.find((r) => live(r) && r.id === recipeId && r.method === method);
  const past = brewId && brews.find((b) => live(b) && !b.incomplete && b.id === brewId && b.method === method);
  if (rec) { recipe = recipeFromRecord(rec); source = 'recipe'; usedRecipeId = rec.id; }
  else if (past) { recipe = recipeFromBrew(past); source = 'brew'; usedRecipeId = past.recipeId ?? null; }
  else {
    const last = brews.filter((b) => mine(b) && !b.incomplete).sort(newest)[0];
    if (last) { recipe = recipeFromBrew(last); source = 'last'; usedRecipeId = last.recipeId ?? null; }
    else {
      const fav = recipes.filter(mine).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.updatedAt - a.updatedAt)[0];
      if (fav) { recipe = recipeFromRecord(fav); source = 'recipe'; usedRecipeId = fav.id; }
    }
  }
  recipe ??= defaultRecipe(method);
  if (method === 'espresso' && (source === 'default' || !recipe.portafilter)) recipe.portafilter = profile?.defaults?.portafilter ?? recipe.portafilter ?? 'spouted';
  return { recipe, recipeId: usedRecipeId, source };
}

/** Edit one recipe field the way the form does: dose/ratio/yield stay linked, steps scale with the dose. */
export function editRecipe(recipe, field, value) {
  if (field === 'dose' || field === 'ratio' || field === 'yield') {
    const next = linkRecipe(recipe, field, value);
    const was = field === 'dose' ? recipe.dose : recipe.yield, now = field === 'dose' ? next.dose : next.yield; // ratio changes the water too
    if (Array.isArray(recipe.steps) && was > 0 && now > 0) {
      const f = now / was;
      next.steps = recipe.steps.map((s) => (Number.isFinite(s.targetG) ? { ...s, targetG: round(s.targetG * f, 1) } : { ...s }));
    }
    return next;
  }
  return { ...recipe, [field]: value };
}

/** Gear ids to remember on a brew: what the profile brews espresso on, and the portafilter used this time. */
export function gearFor({ profile, recipe, method }) {
  const d = profile?.defaults ?? {};
  const gear = {};
  if (d.grinderId) gear.grinder = d.grinderId;
  if (method === 'espresso') {
    if (d.machineId) gear.machine = d.machineId;
    if (recipe?.portafilter) gear.portafilter = recipe.portafilter;
    if (d.basketG) gear.basketG = d.basketG;
  }
  return gear;
}

const FROM_SESSION = ['startSource', 'doneReason', 'firstDropS', 'stopLeadG', 'stopS', 'dripAfterStopG', 'stepLog', 'pourEndS', 'water'];

/**
 * A Brew record (§6) from `session.record()` and what the screens know. `taste`, `notes` and the analysis can be added later;
 * keep the same `id` and save again to update it.
 */
export function buildBrew({ id = uuid(), record, profile, recipe, recipeId, beanId, startedAt = Date.now(), taste, notes, analysis, tempC }) {
  if (!record) throw new Error('buildBrew: the session has no record yet');
  const brew = {
    id, type: 'brew', profileId: profile?.id ?? null, method: record.method, startedAt,
    gear: gearFor({ profile, recipe, method: record.method }),
    dose: record.dose, yield: record.yield, targetYield: record.targetYield, ratio: record.ratio, timeS: record.timeS,
    samples: record.samples,
  };
  if (recipeId) brew.recipeId = recipeId;
  if (beanId) brew.beanId = beanId;
  if (recipe?.grind && (recipe.grind.text || recipe.grind.value != null)) brew.grind = { ...recipe.grind };
  const t = tempC ?? recipe?.tempC;
  if (t != null) brew.tempC = t;
  for (const k of FROM_SESSION) if (record[k] !== undefined && record[k] !== null) brew[k] = record[k];
  if (taste && Object.keys(taste).length) brew.taste = { ...taste };
  if (notes) brew.notes = notes;
  if (analysis) { brew.metrics = analysis.metrics; brew.insights = { verdict: analysis.verdict, tips: analysis.tips, learn: analysis.learn }; }
  return brew;
}

/** A shot that has started is worth keeping even if the user leaves before it ends (Back, swipe-back, tab, page hidden). */
export function shouldKeepPartial(record) {
  return !!record && (record.timeS >= 2 || (record.yield > 0 && record.method !== 'moka')); // moka's yield is the water, known before the heat is on
}

/** What is saved when a started brew is interrupted: the run so far, marked `incomplete`. Saving the finished brew under the same id replaces it. */
export function buildPartialBrew(args) {
  return { ...buildBrew(args), incomplete: true };
}

export async function saveBrew(store, brew) {
  return store.put(brew);
}

/**
 * "Save as my recipe": the profile keeps one favourite recipe per method. Updates it if there is one, else creates it.
 * Returns the stored record.
 */
export async function saveProfileRecipe(store, { profile, recipe, beanId }) {
  const existing = (await store.list('recipe')).find((r) => r.profileId === profile.id && r.method === recipe.method && r.favorite);
  const rec = {
    ...(existing ?? {}), type: 'recipe', profileId: profile.id, method: recipe.method, favorite: true,
    name: recipe.name && recipe.name !== getMethod(recipe.method)?.defaults.name ? recipe.name : getMethod(recipe.method)?.name ?? recipe.method, // default names embed the default amounts
    dose: recipe.dose, yield: recipe.yield, ratio: recipe.ratio ?? ratioOf(recipe.dose, recipe.yield),
  };
  for (const k of ['tempC', 'grind', 'steps', 'portafilter']) { if (recipe[k] != null) rec[k] = recipe[k]; else delete rec[k]; }
  if (beanId) rec.beanId = beanId; else delete rec.beanId;
  return store.put(rec);
}
