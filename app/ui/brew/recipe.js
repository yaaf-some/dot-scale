// Step 2: the recipe, prefilled from the profile's last brew of this method (or the method defaults). Dose, ratio and yield
// stay linked. "Save as my recipe" keeps it as the profile's favourite for this method (Brew again shows it on Home).
import { h, append, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { segmented } from '../components.js';
import { editBean } from '../editors.js';
import { editRecipe, saveProfileRecipe } from '../../core/brew-record.js';
import { unlockAudio } from './audio.js';

const SOURCE_NOTE = {
  default: 'A starting point from community recipes. Adjust it to your beans and taste.',
  last: 'Filled in from your last brew of this method.',
  brew: 'Filled in from that brew.',
  recipe: 'Your saved recipe.',
};
const YIELD_LABEL = { espresso: 'Yield (g)', pour: 'Water (g)', immersion: 'Water (g)', moka: 'Water in the base (g)' };

export function renderRecipe(host, F) {
  const { ctx, method } = F;
  const num = (id, label, { step = '0.1', min = '0', hint, prefix } = {}) => {
    const input = h('input', { id, type: 'number', inputMode: 'decimal', step, min, autocomplete: 'off' });
    return { input, el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), prefix ? h('div', { class: 'with-prefix' }, h('span', { 'aria-hidden': 'true' }, prefix), input) : input, hint ? h('p', { class: 'field-hint' }, hint) : null) };
  };
  const dose = num('r-dose', 'Coffee (g)');
  const ratio = num('r-ratio', 'Ratio', { prefix: '1 :' });
  const yld = num('r-yield', YIELD_LABEL[method.kind] ?? 'Yield (g)');
  const temp = num('r-temp', 'Water temperature (°C)', { step: '1', hint: 'For your reference; the scale can’t measure it.' });
  const grindText = h('input', { id: 'r-grind', type: 'text', maxlength: 40, placeholder: 'e.g. 14 clicks, medium-fine', autocomplete: 'off' });
  const grindVal = h('input', { id: 'r-grindv', type: 'number', inputMode: 'decimal', step: 'any', autocomplete: 'off', placeholder: 'optional' });
  const bean = h('select', { id: 'r-bean' });

  const sync = () => {
    const r = F.recipe;
    const set = (el, v) => { if (document.activeElement !== el) el.value = Number.isFinite(v) ? String(v) : ''; };
    set(dose.input, r.dose); set(ratio.input, r.ratio); set(yld.input, r.yield); set(temp.input, r.tempC);
    if (document.activeElement !== grindText) grindText.value = r.grind?.text ?? '';
    if (document.activeElement !== grindVal) grindVal.value = Number.isFinite(r.grind?.value) ? String(r.grind.value) : '';
    summary.textContent = `${fmtG(r.dose, 1)} g → ${fmtG(r.yield, r.yield < 100 ? 1 : 0)} g`;
  };
  const edit = (field, input) => input.addEventListener('input', () => {
    const v = input.valueAsNumber;
    if (Number.isFinite(v) && v > 0) { F.recipe = editRecipe(F.recipe, field, v); sync(); }
  });
  edit('dose', dose.input); edit('ratio', ratio.input); edit('yield', yld.input);
  temp.input.addEventListener('input', () => { F.recipe = { ...F.recipe, tempC: Number.isFinite(temp.input.valueAsNumber) ? temp.input.valueAsNumber : null }; });
  const grind = () => {
    const text = grindText.value.trim();
    const value = Number.isFinite(grindVal.valueAsNumber) ? grindVal.valueAsNumber : undefined;
    F.recipe = { ...F.recipe, grind: { text, ...(value !== undefined ? { value } : {}) } };
  };
  grindText.addEventListener('input', grind); grindVal.addEventListener('input', grind);

  const fillBeans = () => {
    const live = F.beans.filter((b) => !b.archived || b.id === F.beanId);
    bean.replaceChildren(h('option', { value: '' }, 'No beans picked'), ...live.map((b) => h('option', { value: b.id, selected: b.id === F.beanId }, b.roaster ? `${b.name} · ${b.roaster}` : b.name)));
  };
  fillBeans();
  bean.addEventListener('change', () => { F.beanId = bean.value || null; });
  const addBean = async () => {
    const rec = await editBean(ctx.store);
    if (rec) { F.beans = await ctx.store.list('bean'); F.beanId = rec.id; fillBeans(); bean.value = rec.id; }
  };

  const summary = h('b', { class: 'num' });
  const saveRecipe = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!ctx.profile) return ctx.toast('Pick a profile on Home first.');
    const rec = await saveProfileRecipe(ctx.store, { profile: ctx.profile, recipe: F.recipe, beanId: F.beanId });
    F.recipeId = rec.id;
    ctx.toast(`Saved as ${ctx.profile.name}’s ${method.name.toLowerCase()} recipe`);
  } }, 'Save as my recipe');

  const portafilter = method.id === 'espresso' ? h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Portafilter'),
    segmented({ label: 'Portafilter', value: F.recipe.portafilter, options: [{ value: 'naked', label: 'Naked' }, { value: 'spouted', label: 'Spouted' }], onchange: (v) => { F.recipe = { ...F.recipe, portafilter: v }; } }),
    h('p', { class: 'field-hint' }, 'A naked portafilter shows channeling; the result screen asks about spurts.')) : null;

  const start = h('button', { class: 'btn primary big block', type: 'button', 'data-testid': 'start-brew', onclick: () => {
    unlockAudio();
    if (!(dose.input.valueAsNumber > 0) || !(yld.input.valueAsNumber > 0)) return ctx.toast('Enter the coffee and the yield first.');
    F.go('prep');
  } }, 'Start brewing', icon('chevron', { size: 22 }));

  append(host, [
    h('div', { class: 'view-head' },
      h('div', { class: 'head-with-icon' }, h('span', { class: 'method-art sm' }, icon(method.icon, { size: 28 })), h('h1', {}, method.name)),
      h('a', { class: 'btn quiet small', href: '#/brew' }, 'Change')),
    h('p', { class: 'section-note' }, SOURCE_NOTE[F.source] ?? ''),
    h('div', { class: 'recipe-sum' }, summary, h('span', { class: 'muted' }, ' for this brew')),
    h('div', { class: 'recipe-grid' }, dose.el, ratio.el, yld.el, method.kind !== 'espresso' && method.kind !== 'moka' ? temp.el : null),
    portafilter,
    h('div', { class: 'recipe-grid' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'r-grind' }, 'Grind'), grindText),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'r-grindv' }, 'Grind setting (number)'), grindVal, h('p', { class: 'field-hint' }, 'A number lets the coach see trends.'))),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'r-bean' }, 'Beans'), bean,
      h('button', { class: 'link', type: 'button', onclick: addBean }, 'Add new beans')),
    h('div', { class: 'recipe-actions' }, start, saveRecipe)]);
  sync();
  return () => {};
}
