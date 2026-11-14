// Settings (PRODUCT.md §3): profiles, gear, beans, scale, appearance, advanced. Other modules add sections through
// registerSettingsSection() (settings-sections.js) without editing this file.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, section, group, row, emptyRow, switchRow, segmented, liveBlock } from '../components.js';
import { scaleLine } from '../scale-line.js';
import { editProfile, editGear, editBean, gearSummary } from '../editors.js';
import { confirmDialog } from '../dialog.js';
import { GEAR_KINDS, methodById } from '../labels.js';
import { registerSettingsSection, settingsSections } from '../settings-sections.js';

export const meta = { title: 'Settings' };

const add = (label, onclick) => h('button', { class: 'btn small', type: 'button', onclick }, icon('plus', { size: 18 }), label);

registerSettingsSection({
  id: 'profiles', title: 'Profiles', order: 10,
  render: (ctx) => section('Profiles', [
    group(...ctx.profiles.map((p) => row({
      lead: avatar(p), title: p.name, sub: p.methods?.length ? p.methods.map((m) => methodById(m).name).join(', ') : 'No methods picked yet',
      end: h('span', { class: 'faint' }, p.id === ctx.profile?.id ? 'Active' : ''),
      onclick: () => editProfile(ctx.store, p, { canDelete: ctx.profiles.length > 1 }),
    })), ctx.profiles.length ? null : emptyRow('No profiles yet.')),
    h('div', {}, add('Add profile', () => editProfile(ctx.store))),
  ], { id: 'profiles' }),
});

registerSettingsSection({
  id: 'gear', title: 'Gear', order: 20,
  render: (ctx) => section('Gear', liveBlock(ctx, ['gear'], async () => {
    const gear = await ctx.store.list('gear');
    const kinds = GEAR_KINDS.filter((k) => gear.some((g) => g.kind === k.id));
    return h('div', { class: 'section' },
      ...kinds.map((k) => h('div', { class: 'section' }, h('p', { class: 'field-label' }, k.plural),
        group(...gear.filter((g) => g.kind === k.id).map((g) => row({ title: g.name, sub: gearSummary(g), end: icon('chevron', { size: 20 }), onclick: () => editGear(ctx.store, g) }))))),
      gear.length ? null : group(emptyRow('No gear yet.')),
      h('div', {}, add('Add gear', () => editGear(ctx.store))));
  }), { id: 'gear', note: 'Used to fill in recipes and tune the tips.' }),
});

registerSettingsSection({
  id: 'beans', title: 'Beans', order: 30,
  render: (ctx) => section('Beans', liveBlock(ctx, ['bean'], async () => {
    const beans = (await ctx.store.list('bean')).sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name));
    return h('div', { class: 'section' },
      group(...(beans.length ? beans.map((b) => row({
        title: b.name, sub: [b.roaster, b.roastDate && `roasted ${b.roastDate}`, b.archived && 'archived'].filter(Boolean).join(' · ') || undefined,
        end: icon('chevron', { size: 20 }), onclick: () => editBean(ctx.store, b),
      })) : [emptyRow('No beans yet. Add the bag you’re using and its roast date.')])),
      h('div', {}, add('Add beans', () => editBean(ctx.store))));
  }), { id: 'beans' }),
});

registerSettingsSection({
  id: 'scale', title: 'Scale', order: 40,
  render: (ctx) => {
    const { scale, prefs } = ctx;
    const info = h('p', { class: 'section-note' });
    const nameIn = h('input', { type: 'text', maxlength: 16, placeholder: 'TIMEMORE DOT', 'aria-label': 'Scale name (max 16 characters)', autocomplete: 'off' });
    const live = [];
    const gate = (b) => { live.push(b); return b; };
    const paint = () => {
      const s = scale.state, on = s.status === 'connected';
      info.textContent = on ? [s.model, s.firmware && `firmware ${s.firmware}`, s.name && `name “${s.name}”`].filter(Boolean).join(' · ') || 'Connected.' : 'Connect to see model and firmware.';
      for (const b of live) b.disabled = !on;
      if (s.name) nameIn.placeholder = s.name;
    };
    for (const ev of ['status', 'info']) scale.on(ev, paint, { signal: ctx.signal });
    const el = section('Scale', [
      group(
        h('div', { class: 'row stack' }, scaleLine(ctx), info),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, nameIn),
          gate(h('button', { class: 'btn small', type: 'button', onclick: () => { if (!nameIn.value.trim()) return ctx.toast('Type a new name first.'); scale.rename(nameIn.value); nameIn.value = ''; ctx.toast('Scale renamed'); } }, 'Rename'))),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Turn scale off')),
          gate(h('button', { class: 'btn small', type: 'button', onclick: () => scale.powerOff() }, 'Turn off'))),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Forget old app pairing'), h('span', { class: 'row-sub' }, 'Clears the pairing the Timemore app left on the scale. It reboots; reconnect afterwards.')),
          gate(h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Forget the old pairing?', message: 'The scale will reboot and you’ll need to reconnect.', confirmLabel: 'Forget pairing', danger: true })) scale.forgetPairing(); } }, 'Forget'))),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Factory reset'), h('span', { class: 'row-sub' }, 'Clears all scale settings, including its name.')),
          gate(h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Factory reset the scale?', message: 'This clears all of its settings, including its name.', confirmLabel: 'Reset scale', danger: true })) scale.factoryReset(); } }, 'Reset')))),
      group(
        switchRow({ title: 'Start the timer when pouring starts', checked: prefs.get('autoStart', true), onchange: (v) => prefs.set('autoStart', v) }),
        switchRow({ title: 'Beep at target', checked: prefs.get('beep', true), onchange: (v) => prefs.set('beep', v) })),
    ], { id: 'scale' });
    paint();
    return el;
  },
});

registerSettingsSection({
  id: 'appearance', title: 'Appearance', order: 60,
  render: (ctx) => section('Appearance', segmented({
    label: 'Theme', value: ctx.prefs.get('theme', 'system'), onchange: (v) => ctx.prefs.set('theme', v),
    options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
  }), { id: 'appearance' }),
});

registerSettingsSection({
  id: 'advanced', title: 'Advanced', order: 90,
  render: (ctx) => {
    const { scale, prefs } = ctx;
    const log = h('pre', { class: 'log', 'aria-label': 'Scale log', tabindex: 0 });
    const fmt = (l) => `${l.time.toLocaleTimeString()}  ${l.text}\n`;
    let scrollPending = false;
    const toBottom = () => { if (!scrollPending) { scrollPending = true; requestAnimationFrame(() => { scrollPending = false; log.scrollTop = log.scrollHeight; }); } };
    const paintAll = () => { log.textContent = scale.logLines.map(fmt).join(''); toBottom(); };
    let details; // set below; the log only does work while the section is open
    scale.on('log', (line) => {
      if (!details?.open) return;
      log.append(fmt(line));
      while (log.childNodes.length > 200) log.firstChild.remove();
      toBottom();
    }, { signal: ctx.signal });
    const raw = h('input', { type: 'text', placeholder: 'opcode cmd payload… e.g. 02 05', 'aria-label': 'Raw command in hex', autocomplete: 'off', autocapitalize: 'off' });
    const sendRaw = () => {
      const b = raw.value.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
      if (b.length < 2 || b.some(Number.isNaN)) return ctx.toast('Enter at least an opcode and a command as hex, like “02 05”.');
      scale.sendRaw(b);
    };
    const demo = switchRow({
      title: 'Demo mode', sub: 'A simulated scale that speaks the real protocol.', checked: scale.state.mode === 'demo',
      onchange: (on) => (on ? scale.startDemo() : scale.disconnect()),
    });
    scale.on('status', () => { const i = demo.querySelector('input'); i.checked = scale.state.mode === 'demo' && scale.state.status === 'connected'; }, { signal: ctx.signal });
    details = h('details', { class: 'adv', ontoggle: () => details.open && paintAll() },
      h('summary', {}, 'Advanced'),
      h('div', { class: 'section' },
        group(demo, switchRow({ title: 'Log weight frames too', sub: 'About ten lines per second.', checked: prefs.get('logWeight', false), onchange: (v) => prefs.set('logWeight', v) })),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Raw command'),
          h('div', { class: 'row-end', style: { width: '100%' } }, raw, h('button', { class: 'btn small', type: 'button', disabled: false, onclick: sendRaw }, 'Send'))),
        h('p', { class: 'field-hint' }, 'The frame header and CRC are added for you. Connect a scale first.'),
        log,
        h('div', {}, h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (await confirmDialog({ title: 'Erase everything on this device?', message: 'Profiles, gear, beans, brews and settings stored in this browser are deleted. Data already synced to a household is not affected.', confirmLabel: 'Erase data', danger: true })) await ctx.store.clearAll();
        } }, 'Erase data on this device'))));
    return h('section', { class: 'section', id: 'advanced' }, details);
  },
});

export async function mount(root, ctx) {
  const sections = await Promise.all(settingsSections().map((s) => s.render(ctx)));
  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Settings')), ...sections);
}
