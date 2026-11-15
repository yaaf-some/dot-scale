// Settings → Sync: create or join a household, see the status, sync now, leave. The client itself lives in boot.js.
import { h } from '../ui/dom.js';
import { section, group } from '../ui/components.js';
import { confirmDialog } from '../ui/dialog.js';
import { registerSettingsSection } from '../ui/settings-sections.js';
import { loadSync } from './boot.js';

const btn = (label, onclick, cls = '') => h('button', { class: `btn small ${cls}`.trim(), type: 'button', onclick }, label);
const rowOf = (...kids) => h('div', { class: 'row' }, ...kids);

registerSettingsSection({
  id: 'sync', title: 'Sync', order: 55,
  render: async (ctx) => {
    const sync = await loadSync(ctx.store);
    if (!sync) return section('Sync', h('p', { class: 'section-note' }, 'Sync is not available.'), { id: 'sync' });
    const body = h('div', {});
    const code = h('code', { class: 'sync-code' });
    let shown = false;
    const run = async (fn, done) => { try { await fn(); if (done) ctx.toast(done); } catch (e) { ctx.toast(e.message || 'Something went wrong.'); } };
    const paint = () => {
      const s = sync.getStatus(), has = sync.hasHousehold();
      const rows = [h('div', { class: 'row stack' },
        h('span', { class: 'row-title' }, s.label),
        s.error && h('span', { class: 'row-sub' }, s.error.message),
        s.skipped ? h('span', { class: 'row-sub' }, `${s.skipped} item${s.skipped === 1 ? '' : 's'} too large or invalid to sync.`) : null)];
      if (!has && s.state === 'unavailable') rows.push(rowOf(h('div', { class: 'row-main' }, h('span', { class: 'row-sub' }, 'The app works fine without it.')), btn('Check again', () => run(() => sync.probe({ force: true })))));
      if (!has && s.state !== 'unavailable') {
        const input = h('input', { type: 'text', placeholder: 'maple-tiger-orbit-river-4271', 'aria-label': 'Household code', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
        rows.push(
          rowOf(h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Create a household'), h('span', { class: 'row-sub' }, 'Shows a code. Enter it on your other devices to share data.')),
            btn('Create', () => run(async () => { shown = true; try { await sync.createHousehold(); } catch (e) { shown = false; throw e; } }, 'Household created'))),
          rowOf(h('div', { class: 'row-main' }, input), btn('Join', () => run(() => sync.joinHousehold(input.value), 'Joined household'))));
      }
      if (has) {
        code.textContent = shown ? sync.getHouseholdCode() : '•••• •••• •••• •••• ••••';
        rows.push(
          h('div', { class: 'row stack' }, h('span', { class: 'row-title' }, 'Household code'), code,
            h('span', { class: 'row-sub' }, 'Anyone with this code can read and change this household’s data. Share it only with people you trust.')),
          rowOf(btn(shown ? 'Hide code' : 'Show code', () => { shown = !shown; paint(); }), btn('Sync now', () => run(() => sync.syncNow())),
            btn('Leave', async () => { if (await confirmDialog({ title: 'Leave this household?', message: 'Your data stays on this device; it just stops syncing.', confirmLabel: 'Leave', danger: true })) { shown = false; sync.leaveHousehold(); } }, 'danger')));
      }
      body.replaceChildren(group(...rows));
    };
    const probeSection = () => {
      const result = h('p', { class: 'row-title', role: 'status' }), sub = h('span', { class: 'row-sub' });
      const say = (line, note = '') => { result.textContent = line; sub.textContent = note; };
      const log = (t) => ctx.scale.note?.(t);
      let busy = false, mod = null;
      const buttons = [];
      const load = () => import('./passkey-probe.js').then((m) => (mod = m), () => null);
      load(); // preload now, so the tap can call create() right away (WebKit needs the user gesture to be fresh)
      const go = (test) => async () => {
        if (busy) return;
        busy = true; buttons.forEach((b) => { b.disabled = true; });
        try {
          if (!mod && !(await load())) return say('Couldn\u2019t load the check (no connection?). Try again.');
          say('Checking\u2026');
          if (test) {
            const r = await mod.testPasskeys({ log });
            say(r.line, r.ok ? 'Nothing was sent. A \u201cPasskey test\u201d entry may remain in your Passwords app for this site; you can delete it there.' : 'Nothing was sent.');
          } else say((await mod.detectPasskeys({ log })).summary.line);
        } catch (e) { say(`The check itself failed: ${e?.name || 'Error'}: ${e?.message || ''}`); }
        finally { busy = false; buttons.forEach((b) => { b.disabled = false; }); }
      };
      return h('details', { class: 'adv' }, h('summary', {}, 'Face ID / passkey support'),
        h('div', { class: 'row stack' }, result, sub,
          h('span', { class: 'row-sub' }, 'Experimental check for a possible future sign-in with Face ID. It changes nothing about how sync works today. Results also go to Settings \u2192 Advanced \u2192 log.')),
        rowOf(...[btn('Check support', go(false)), btn('Test Face ID passkey', go(true))].map((b) => (buttons.push(b), b))));
    };
    const off = sync.onStatus(paint), tick = setInterval(paint, 30000);
    ctx.signal.addEventListener('abort', () => { off(); clearInterval(tick); }, { once: true });
    if (!sync.hasHousehold()) sync.probe(); // sets "Sync not set up" when there is no server side
    paint();
    return section('Sync', h('div', {}, body, probeSection()), { id: 'sync', note: 'Keeps this household’s profiles, beans and brews in step across devices. Works offline; changes sync when you are back online.' });
  },
});
