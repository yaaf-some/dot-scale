// Method registry. Each method: { id, name, icon, defaults, steps, prep, learn } (docs/PRODUCT.md §9) plus
// { kind, tareAfterDose, captures, timeRangeS, unverified?, note? } used by the brew session.
// `steps` are templates (see resolveSteps); use stepsFor(recipe) to get concrete steps with absolute grams.
import espresso from './espresso.js';
import pourOver from './pour-over.js';
import frenchPress from './french-press.js';
import aeropress from './aeropress.js';
import moka from './moka.js';
import prestina from './prestina.js';
import { resolveSteps, fillPrep, round } from './recipe.js';

export * from './recipe.js';

export const METHODS = [espresso, pourOver, frenchPress, aeropress, moka, prestina];
const byId = new Map(METHODS.map((m) => [m.id, m]));

export const getMethod = (id) => byId.get(id) ?? null;

/** A fresh default recipe for a method (a copy, safe to edit). */
export function defaultRecipe(id) {
  const m = getMethod(id);
  return m ? JSON.parse(JSON.stringify(m.defaults)) : null;
}

/**
 * Concrete steps for a recipe: the recipe's own `steps` if it has any, else the method's templates resolved against
 * the recipe's dose and yield. Labels may use {t} for the step's target grams.
 */
export function stepsFor(recipe, method = getMethod(recipe?.method)) {
  if (!recipe) return [];
  const steps = Array.isArray(recipe.steps) && recipe.steps.length
    ? resolveSteps(recipe.steps, recipe)
    : method ? resolveSteps(method.steps, recipe) : [];
  return steps.map((s) => (s.label ? { ...s, label: s.label.replace('{t}', Number.isFinite(s.targetG) ? round(s.targetG, 0) : '') } : s));
}

/** Prep checklist for a recipe, with dose/temperature filled in. At most 3 lines. */
export function prepFor(recipe, method = getMethod(recipe?.method)) {
  return method ? fillPrep(method.prep, recipe) : [];
}
