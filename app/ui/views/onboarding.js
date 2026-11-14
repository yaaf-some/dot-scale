// First-run onboarding (PRODUCT.md §5): who → what you brew → espresso gear (if espresso) → scale. Under a minute, skippable.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { avatar } from '../components.js';
import { scaleLine } from '../scale-line.js';
import { editProfile } from '../editors.js';
import { METHODS } from '../labels.js';

export const meta = { title: 'Welcome', chrome: 'none', keepOnProfileChange: true };

export async function mount(root, ctx) {
  const { store, scale } = ctx;
  let profiles = ctx.profiles;
  const gear = await store.list('gear');
  const machines = gear.filter((g) => g.kind === 'espresso-machine');
  const startProfile = ctx.profile ?? profiles[0];

  const answers = {
    profileId: startProfile?.id,
    methods: new Set(startProfile?.methods ?? []),
    machineId: startProfile?.defaults?.machineId ?? machines[0]?.id,
    portafilter: startProfile?.defaults?.portafilter ?? 'naked',
    basketG: startProfile?.defaults?.basketG ?? 16,
    grinder: '',
  };
  let step = 0;
  const steps = () => (answers.methods.has('espresso') ? ['who', 'methods', 'gear', 'scale'] : ['who', 'methods', 'scale']);

  async function finish() {
    const profile = profiles.find((p) => p.id === answers.profileId);
    if (profile) {
      let grinderId = profile.defaults?.grinderId;
      if (answers.grinder) {
        const existing = (await store.list('gear')).find((g) => g.kind === 'grinder' && g.name.toLowerCase() === answers.grinder.toLowerCase());
        grinderId = (existing ?? (await store.put({ type: 'gear', kind: 'grinder', name: answers.grinder, props: {} }))).id;
      }
      const ordered = METHODS.map((m) => m.id).filter((id) => answers.methods.has(id));
      await store.put({ ...profile, methods: ordered, defaults: { ...profile.defaults, machineId: answers.machineId, portafilter: answers.portafilter, basketG: answers.basketG, ...(grinderId ? { grinderId } : {}) } });
      await ctx.setProfile(profile.id);
    }
    await store.prefs.set('onboarded', true);
    ctx.navigate('/home', { replace: true });
  }
  const skip = async () => {
    if (answers.profileId) await ctx.setProfile(answers.profileId);
    await store.prefs.set('onboarded', true);
    ctx.navigate('/home', { replace: true });
  };

  const choice = (name, options, value, onchange, { cols } = {}) => h('div', { class: 'chip-group', role: 'radiogroup' },
    options.map((o) => h('label', { class: 'chip-choice' },
      h('input', { type: 'radio', name, value: o.value, checked: String(o.value) === String(value), onchange: () => onchange(o.value) }), h('span', {}, o.label))));

  const views = {
    who: () => [
      h('h1', {}, 'Who’s brewing?'),
      h('p', { class: 'muted' }, 'Pick your profile. Your recipes and brews are kept per person.'),
      h('div', { class: 'profile-bar', style: { flexWrap: 'wrap', overflow: 'visible' }, role: 'radiogroup', 'aria-label': 'Profile' },
        profiles.map((p) => h('button', { class: 'profile-chip', type: 'button', role: 'radio', 'aria-checked': String(p.id === answers.profileId),
          onclick: () => { answers.profileId = p.id; answers.methods = new Set(p.methods ?? []); draw(); } }, avatar(p), p.name)),
        h('button', { class: 'profile-chip add', type: 'button', onclick: async () => {
          const created = await editProfile(store);
          if (created) { profiles = [...profiles, created]; answers.profileId = created.id; answers.methods = new Set(); draw(); }
        } }, icon('plus', { size: 20 }), 'Someone else')),
    ],
    methods: () => [
      h('h1', {}, 'What do you brew?'),
      h('p', { class: 'muted' }, 'Pick any that apply. They set the order of your brew tiles, and you can change them later.'),
      h('div', { class: 'tiles' }, METHODS.map((m) => h('label', { class: 'tile' },
        h('input', { type: 'checkbox', value: m.id, checked: answers.methods.has(m.id), onchange: (e) => { e.target.checked ? answers.methods.add(m.id) : answers.methods.delete(m.id); } }),
        h('span', {}, icon(m.icon, { size: 28 }), m.name)))),
    ],
    gear: () => [
      h('h1', {}, 'Your espresso setup'),
      h('p', { class: 'muted' }, 'These are the defaults for new shots. The Stilosa and an unpressurized basket are already filled in.'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ob-machine' }, 'Machine'),
        h('select', { id: 'ob-machine', onchange: (e) => { answers.machineId = e.target.value; } }, machines.map((m) => h('option', { value: m.id, selected: m.id === answers.machineId }, m.name)))),
      h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Basket'), choice('ob-basket', [{ value: 16, label: '16 g double' }, { value: 16.5, label: '16.5 g' }, { value: 18, label: '18 g' }], answers.basketG, (v) => { answers.basketG = Number(v); }),
        h('p', { class: 'field-hint' }, 'Unpressurized baskets only. They make shot time a real grind signal.')),
      h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Portafilter you reach for first'), choice('ob-pf', [{ value: 'naked', label: 'Naked' }, { value: 'spouted', label: '2-spout' }], answers.portafilter, (v) => { answers.portafilter = v; })),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ob-grinder' }, 'Grinder (optional)'),
        h('input', { id: 'ob-grinder', type: 'text', value: answers.grinder, placeholder: 'Make and model', autocomplete: 'off', oninput: (e) => { answers.grinder = e.target.value.trim(); } })),
    ],
    scale: () => [
      h('h1', {}, 'Connect your scale'),
      h('p', { class: 'muted' }, scale.supported
        ? 'Turn on your Timemore Dot and connect. No scale nearby? Try the demo to see how it works.'
        : 'This browser can’t use Bluetooth. On iPhone and iPad open Dot Scale in Bluefy. You can still try the demo.'),
      scaleLine(ctx),
    ],
  };

  function draw() {
    const list = steps();
    const key = list[Math.min(step, list.length - 1)];
    const last = step >= list.length - 1;
    const needsProfile = key === 'who' && !answers.profileId;
    root.classList.add('onboard');
    root.replaceChildren(
      h('div', { class: 'view-head' },
        h('div', { class: 'steps', role: 'img', 'aria-label': `Step ${step + 1} of ${list.length}`, style: { flex: 1 } }, list.map((_, i) => h('i', { 'data-done': i <= step ? '' : undefined }))),
        h('button', { class: 'btn quiet small', type: 'button', onclick: skip }, 'Skip')),
      ...views[key](),
      h('div', { class: 'onboard-actions' },
        step > 0 ? h('button', { class: 'btn quiet', type: 'button', onclick: () => { step--; draw(); } }, 'Back') : h('span'),
        h('button', { class: 'btn primary big', type: 'button', disabled: needsProfile, onclick: () => (last ? finish() : (step++, draw())) }, last ? 'Done' : 'Next')));
    root.querySelector('h1')?.setAttribute('tabindex', '-1');
    if (step > 0 || !draw.first) { root.querySelector('h1')?.focus({ preventScroll: true }); }
    draw.first = true;
  }
  draw();
}
