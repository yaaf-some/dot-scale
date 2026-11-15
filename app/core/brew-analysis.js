// Runs the insights engine on a brew with the right context. Split from brew-record.js so the big engine
// (insights/analyze.js) is only loaded with the result screen, not with the rest of the Brew flow.
import { analyze } from '../insights/analyze.js';

const live = (b) => b && !b.deleted;

/** analyze() with this brew's context. `history` = earlier brews (any), `bean` = the Bean record, `recipe` supplies planned steps. */
export function analyzeBrew(brew, { history = [], bean = null, recipe = null, steps = null } = {}) {
  const earlier = history.filter((b) => live(b) && !b.incomplete && b.id !== brew.id && (b.startedAt ?? 0) < brew.startedAt);
  return analyze(brew, { method: brew.method, gear: brew.gear, history: earlier, bean, recipe, steps: steps ?? recipe?.steps ?? null });
}

/** Re-run the analysis and attach it. Returns { brew, analysis }. */
export function withAnalysis(brew, ctx) {
  const analysis = analyzeBrew(brew, ctx);
  return { analysis, brew: { ...brew, metrics: analysis.metrics, insights: { verdict: analysis.verdict, tips: analysis.tips, learn: analysis.learn } } };
}
