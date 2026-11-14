// Pure recipe helpers: ratio <-> yield link, scaling to a dose, and step templates -> concrete steps.
// No DOM, no imports. "ratio" always means yield / dose (water or liquid per gram of coffee), so 1:2 is 2 and 1:16.7 is 16.7.

export const round = (x, d = 1) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

const pos = (x) => Number.isFinite(x) && x > 0;

export const ratioOf = (dose, yld) => (pos(dose) && pos(yld) ? round(yld / dose, 2) : null);
export const yieldFor = (dose, ratio) => (pos(dose) && pos(ratio) ? round(dose * ratio, 1) : null);

/**
 * Change one of dose / yield / ratio and keep the three consistent. Returns a new recipe.
 *  - dose  changed: ratio is kept, yield follows (what you want when you grind a bit more or less)
 *  - ratio changed: dose is kept, yield follows
 *  - yield changed: dose is kept, ratio follows
 */
export function linkRecipe(recipe, field, value) {
  const r = { ...recipe };
  if (!Number.isFinite(value) || value <= 0) return r;
  if (field === 'dose') {
    const ratio = pos(r.ratio) ? r.ratio : ratioOf(r.dose, r.yield);
    r.dose = round(value, 1);
    if (pos(ratio)) { r.yield = yieldFor(r.dose, ratio); r.ratio = ratio; }
  } else if (field === 'ratio') {
    r.ratio = round(value, 2);
    if (pos(r.dose)) r.yield = yieldFor(r.dose, r.ratio);
  } else if (field === 'yield') {
    r.yield = round(value, 1);
    if (pos(r.dose)) r.ratio = ratioOf(r.dose, r.yield);
  }
  return r;
}

/** Scale a recipe to a new dose, keeping the ratio. Custom steps with absolute targets are scaled by the same factor. */
export function scaleRecipe(recipe, dose) {
  if (!pos(dose) || !pos(recipe.dose)) return { ...recipe };
  const f = dose / recipe.dose;
  const out = linkRecipe(recipe, 'dose', dose);
  if (Array.isArray(recipe.steps)) {
    out.steps = recipe.steps.map((s) => (Number.isFinite(s.targetG) ? { ...s, targetG: round(s.targetG * f, 1) } : { ...s }));
  }
  return out;
}

/**
 * Turn step templates into concrete Steps for a recipe.
 * A template may carry `of: { dose: k }` or `of: { yield: k }` instead of `targetG`;
 * targets are cumulative weights on the scale (water only, the vessel is tared).
 * `atS` is when the step starts (seconds on the brew timer). If omitted it follows the previous step's end.
 */
export function resolveSteps(templates, recipe) {
  let cursor = 0;
  return templates.map((t) => {
    const { of, ...step } = t;
    if (of?.dose != null && pos(recipe.dose)) step.targetG = round(recipe.dose * of.dose, 1);
    else if (of?.yield != null && pos(recipe.yield)) step.targetG = round(recipe.yield * of.yield, 1);
    if (!Number.isFinite(step.atS)) step.atS = cursor;
    cursor = step.atS + (Number.isFinite(step.durationS) ? step.durationS : 0);
    return step;
  });
}

/** Fill `{dose}`, `{yield}` and `{temp}` in prep lines. */
export function fillPrep(lines, recipe) {
  const sub = { dose: pos(recipe.dose) ? round(recipe.dose, 1) : '', yield: pos(recipe.yield) ? round(recipe.yield, 0) : '', temp: recipe.tempC ?? '' };
  return lines.map((l) => l.replace(/\{(dose|yield|temp)\}/g, (_, k) => sub[k]));
}
