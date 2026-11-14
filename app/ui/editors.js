// Create/edit/delete flows for profiles, gear and beans, shared by Home, Onboarding and Settings.
// Each returns the saved record, or null if the user cancelled or deleted.
import { formDialog, confirmDialog } from './dialog.js';
import { METHODS, GEAR_KINDS } from './labels.js';
import { PROFILE_COLORS, PROFILE_EMOJI } from '../core/seeds.js';

const opt = (list) => list.map((v) => ({ value: v, label: v }));

export async function editProfile(store, profile, { canDelete = false } = {}) {
  const isNew = !profile;
  const v = await formDialog({
    title: isNew ? 'Add a profile' : `Edit ${profile.name}`, submitLabel: isNew ? 'Add profile' : 'Save', deletable: !isNew && canDelete,
    values: profile ?? { color: PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)], emoji: '☕', methods: [] },
    fields: [
      { name: 'name', label: 'Name', required: true, maxlength: 24 },
      { name: 'emoji', label: 'Icon', type: 'choice', options: opt(PROFILE_EMOJI) },
      { name: 'color', label: 'Colour', type: 'choice', swatch: true, options: PROFILE_COLORS.map((c) => ({ value: c, label: c })) },
      { name: 'methods', label: 'What do you brew?', type: 'multi', options: METHODS.map((m) => ({ value: m.id, label: m.name })), hint: 'Sets the order of your brew tiles.' },
    ],
  });
  if (!v) return null;
  if (v.__delete) {
    const ok = await confirmDialog({ title: `Delete ${profile.name}?`, message: 'This removes the profile. Their brews and recipes are kept.', confirmLabel: 'Delete profile', danger: true });
    if (ok) await store.delete(profile.id);
    return null;
  }
  return store.put({ ...(profile ?? { type: 'profile', createdAt: Date.now(), defaults: { machineId: (await store.list('gear')).find((g) => g.kind === 'espresso-machine')?.id, portafilter: 'naked', basketG: 16 } }), ...v });
}

// Kind-specific gear fields (stored in `props`).
const GEAR_PROPS = {
  'espresso-machine': [{ name: 'groupMm', label: 'Group size (mm)', type: 'number', inputMode: 'decimal' }],
  basket: [{ name: 'doseG', label: 'Dose (g)', type: 'number', inputMode: 'decimal', step: '0.1' },
    { name: 'pressurized', label: 'Type', type: 'select', options: [{ value: 'no', label: 'Unpressurized' }, { value: 'yes', label: 'Pressurized' }] }],
  portafilter: [{ name: 'style', label: 'Style', type: 'select', options: [{ value: 'naked', label: 'Naked (bottomless)' }, { value: 'spouted', label: '2-spout' }] }],
  grinder: [{ name: 'notes', label: 'Notes', type: 'textarea', hint: 'Burrs, settings range, quirks.' }],
  brewer: [{ name: 'notes', label: 'Notes', type: 'textarea' }],
};

export function gearSummary(g) {
  const p = g.props ?? {};
  switch (g.kind) {
    case 'espresso-machine': return [p.groupMm && `${p.groupMm} mm group`, p.pumpBar && `${p.pumpBar} bar pump`].filter(Boolean).join(', ');
    case 'basket': return [p.doseG && `${p.doseG} g`, p.pressurized ? 'pressurized' : 'unpressurized'].join(', ');
    case 'portafilter': return p.style === 'naked' ? 'Naked' : p.style === 'spouted' ? '2-spout' : '';
    default: return p.notes ?? '';
  }
}

export async function editGear(store, gear, { kind = 'grinder' } = {}) {
  const isNew = !gear;
  let k = gear?.kind ?? kind;
  if (isNew) {
    const picked = await formDialog({ title: 'Add gear', submitLabel: 'Next', fields: [{ name: 'kind', label: 'What kind?', type: 'select', options: GEAR_KINDS.map((g) => ({ value: g.id, label: g.name })) }], values: { kind } });
    if (!picked) return null;
    k = picked.kind;
  }
  const props = gear?.props ?? {};
  const v = await formDialog({
    title: isNew ? 'Add gear' : `Edit ${gear.name}`, submitLabel: isNew ? 'Add' : 'Save', deletable: !isNew,
    values: { name: gear?.name, ...props, pressurized: props.pressurized ? 'yes' : 'no' },
    fields: [{ name: 'name', label: 'Name', required: true, maxlength: 60 }, ...(GEAR_PROPS[k] ?? [])],
  });
  if (!v) return null;
  if (v.__delete) {
    if (await confirmDialog({ title: `Delete ${gear.name}?`, message: 'Past brews keep their record of it.', confirmLabel: 'Delete', danger: true })) await store.delete(gear.id);
    return null;
  }
  const { name, ...rest } = v;
  if ('pressurized' in rest) rest.pressurized = rest.pressurized === 'yes';
  const next = { ...props };
  for (const [key, val] of Object.entries(rest)) { if (val === undefined || val === '') delete next[key]; else next[key] = val; } // an emptied field clears the value
  return store.put({ ...(gear ?? { type: 'gear', kind: k }), name, props: next });
}

export async function editBean(store, bean) {
  const isNew = !bean;
  const v = await formDialog({
    title: isNew ? 'Add beans' : `Edit ${bean.name}`, submitLabel: isNew ? 'Add beans' : 'Save', deletable: !isNew,
    values: { ...bean, archived: bean?.archived ? 'yes' : 'no' },
    fields: [
      { name: 'name', label: 'Name', required: true, maxlength: 60 },
      { name: 'roaster', label: 'Roaster', maxlength: 60 },
      { name: 'roastDate', label: 'Roast date', type: 'date', hint: 'Lets the app warn about very fresh or old beans.' },
      { name: 'process', label: 'Process', placeholder: 'Washed, natural…', maxlength: 40 },
      { name: 'origin', label: 'Origin', maxlength: 60 },
      { name: 'notes', label: 'Notes', type: 'textarea' },
      { name: 'archived', label: 'Status', type: 'select', options: [{ value: 'no', label: 'In use' }, { value: 'yes', label: 'Archived' }] },
    ],
  });
  if (!v) return null;
  if (v.__delete) {
    if (await confirmDialog({ title: `Delete ${bean.name}?`, message: 'Past brews keep the bean’s name.', confirmLabel: 'Delete', danger: true })) await store.delete(bean.id);
    return null;
  }
  const rec = { ...(bean ?? { type: 'bean' }), ...v, archived: v.archived === 'yes' };
  for (const k of ['roaster', 'roastDate', 'process', 'origin', 'notes']) if (!rec[k]) delete rec[k];
  if (!rec.archived) delete rec.archived;
  return store.put(rec);
}
