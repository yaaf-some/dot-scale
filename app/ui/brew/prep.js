// Step 3: prep. At most three checklist lines, then the scale drives it: put the beans (or portafilter) on, "Use as dose",
// then the cup goes on and the scale tares by itself (the session's cues say what to do next). Moka adds a water step.
import { h, append, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { scaleLine } from '../scale-line.js';
import { prepFor } from '../../methods/index.js';
import { demoPanel } from './demo-panel.js';

const INSTRUCTIONS = {
  dose: { espresso: 'Put the portafilter with the ground coffee on the scale', moka: 'Put the basket with the coffee on the scale', default: 'Put the ground coffee on the scale' },
  cup: { espresso: 'Swap the portafilter for the cup. The scale tares itself', moka: 'Put the pot base on the scale. The scale tares itself', default: 'Put the cup on the scale' },
  taring: { default: 'Taring…' },
  water: { default: 'Pour the water into the base' },
};
const say = (step, id) => INSTRUCTIONS[step]?.[id] ?? INSTRUCTIONS[step]?.default ?? '';

export function renderPrep(host, F) {
  const { ctx, method, run } = F;
  const { scale } = ctx;
  run.dispatch({ type: 'begin' });

  const weight = h('div', { class: 'prep-weight num', 'data-testid': 'prep-weight', 'aria-live': 'off' });
  const steady = h('span', { class: 'steady' });
  const instruction = h('p', { class: 'prep-instruction', 'aria-live': 'polite', 'data-testid': 'prep-instruction' });
  const note = h('p', { class: 'prep-note muted' });
  const useBtn = h('button', { class: 'btn primary big block', type: 'button', 'data-testid': 'use-dose', onclick: () => run.dispatch({ type: run.state.prepStep === 'water' ? 'useAsWater' : 'useAsDose' }) });
  const skipBtn = h('button', { class: 'btn quiet', type: 'button', onclick: () => run.dispatch({ type: 'skipDose' }) });
  const tareBtn = h('button', { class: 'btn big block', type: 'button', onclick: () => { scale.tare(); run.dispatch({ type: 'tare' }); } }, 'Tare now');
  const offline = h('div', { class: 'prep-offline' },
    h('p', {}, 'Connect your scale to continue. The weight drives each step.'), scaleLine(ctx));
  const demo = demoPanel(F);

  let cueNote = null;
  const checks = prepFor(F.recipe, method).slice(0, 3);
  const paint = (out = { cues: [] }) => {
    const s = run.state;
    const on = run.connected;
    offline.hidden = on;
    weight.replaceChildren(h('span', {}, s.grams.toFixed(1)), h('small', {}, 'g'));
    steady.textContent = s.stable ? 'steady' : 'settling';
    steady.dataset.stable = String(!!s.stable);
    const step = s.prepStep;
    instruction.textContent = on ? say(step, method.id) : '';
    const cue = out.cues.find((c) => /^(dose:|tare:)/.test(c.id));
    if (cue) cueNote = { text: cue.text, until: performance.now() + 3500 }; // keep a warning readable for a moment
    if (cueNote && performance.now() < cueNote.until) note.textContent = cueNote.text;
    else if (step === 'dose' && s.canUseAsDose) note.textContent = `Reads ${s.grams.toFixed(1)} g. Recipe says ${fmtG(F.recipe.dose, 1)} g.`;
    else note.textContent = '';
    const asking = step === 'dose' || step === 'water';
    useBtn.hidden = !asking; skipBtn.hidden = step !== 'dose';
    useBtn.disabled = !s.canUseAsDose || !on;
    useBtn.textContent = step === 'water' ? `Use ${s.grams.toFixed(1)} g as water` : `Use ${s.grams.toFixed(1)} g as dose`;
    skipBtn.textContent = `Skip: use ${fmtG(F.recipe.dose, 1)} g`;
    tareBtn.hidden = step !== 'cup' && step !== 'taring';
    if (s.phase === 'ready' || s.phase === 'running') F.go('live');
  };
  const off = run.on('update', paint);

  append(host, [
    h('div', { class: 'view-head' },
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => F.go('recipe') }, icon('back', { size: 18 }), 'Recipe'),
      h('span', { class: 'muted' }, `${method.name} · ${fmtG(F.recipe.dose, 1)} → ${fmtG(F.recipe.yield, F.recipe.yield < 100 ? 1 : 0)} g`)),
    h('h1', {}, 'Get ready'),
    h('ol', { class: 'checks' }, checks.map((c) => h('li', {}, c))),
    offline,
    h('div', { class: 'prep-stage' }, weight, steady, instruction, note,
      h('div', { class: 'prep-actions' }, useBtn, tareBtn, skipBtn)),
    demo.el]);
  paint();
  return () => { off(); demo.destroy(); };
}
