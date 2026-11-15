// Demo-mode controls: with the simulated scale there's no real beans, cup or kettle, so this panel does what your hands would.
// It appears only while the demo scale is connected and lets every method run end to end (and the smoke test drive it).
// Each button calls a demo-only helper on the transport (app/core/demo-scale.js); the app itself still speaks the real protocol.
import { h } from '../dom.js';

const CUP_G = { espresso: 95, moka: 280, default: 120 };

/** Which demo buttons make sense right now. Pure: state in, button list out. */
export function demoActions({ method, recipe, state }) {
  const kind = method.kind;
  const out = [];
  if (state.phase === 'prep' || state.phase === 'idle') {
    if (state.prepStep === 'dose' || state.prepStep == null) out.push({ id: 'dose', label: `Put ${recipe.dose} g of coffee on`, do: (d) => { d.remove(); d.place(recipe.dose); } });
    if (state.prepStep === 'cup') out.push({ id: 'cup', label: kind === 'moka' ? 'Put the pot base on' : 'Swap in the cup', do: (d) => { d.remove(); d.place(CUP_G[method.id] ?? CUP_G.default); } });
    if (state.prepStep === 'water') out.push({ id: 'water', label: `Pour ${recipe.yield} g of water`, do: (d) => d.dispense(recipe.yield, 20) });
  } else if (state.phase === 'ready' || state.phase === 'running') {
    if (kind === 'espresso') {
      if (state.phase === 'ready' || !state.espresso?.stopCueSent) out.push({ id: 'pump', label: 'Start the shot', do: (d) => { d.setScenario('espresso-1to2'); d.startFlow(); } });
    } else if (kind === 'pour') {
      const b = state.brew;
      const target = b?.targetG;
      if (target != null) out.push({ id: 'pour', label: `Pour to ${Math.round(target)} g`, do: (d, s) => d.dispense(target - s.grams, 6) });
    } else if (kind === 'immersion' && state.phase === 'ready') {
      out.push({ id: 'pour', label: `Pour ${recipe.yield} g of water`, do: (d) => d.dispense(recipe.yield, 12) });
    }
  }
  return out;
}

export function demoPanel(F) {
  const { ctx, method, run } = F;
  const { scale } = ctx;
  const buttons = h('div', { class: 'demo-actions' });
  const el = h('details', { class: 'demo-panel', open: true, 'data-testid': 'demo-panel' },
    h('summary', {}, h('span', { class: 'demo-tag' }, 'demo'), 'Scale simulator'), buttons,
    h('p', { class: 'field-hint' }, 'Stands in for beans, cup and kettle. Real brews never show this.'));
  let key = '';
  const paint = () => {
    const demo = scale.demo;
    el.hidden = !demo;
    if (!demo) return;
    const state = run.state;
    const acts = demoActions({ method, recipe: F.recipe, state });
    const k = acts.map((a) => `${a.id}:${a.label}`).join('|');
    if (k === key) return;
    key = k;
    buttons.replaceChildren(...acts.map((a) => h('button', { class: 'btn small', type: 'button', 'data-demo': a.id, onclick: () => a.do(scale.demo, run.state) }, a.label)));
  };
  const off1 = run.on('update', paint);
  const off2 = scale.on('status', paint);
  paint();
  return { el, destroy() { off1(); off2(); } };
}
