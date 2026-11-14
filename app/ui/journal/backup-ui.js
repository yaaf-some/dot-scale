// Backup dialog: export JSON / CSV, import JSON. The logic is in app/journal/backup.js.
import { h } from '../dom.js';
import { openDialog } from '../dialog.js';
import { BACKUP_TYPES, exportJSON, exportCSV, parseImport, planImport } from '../../journal/backup.js';
import { saveFile } from './shared.js';

const MAX_BYTES = 60 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

async function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => fail(r.error); r.readAsText(file); });
}

async function allRecords(store, { includeDeleted = false } = {}) {
  return (await Promise.all(BACKUP_TYPES.map((t) => store.list(t, { includeDeleted })))).flat();
}

export async function importText(store, text, { profileId } = {}) {
  const incoming = parseImport(text, { profileId });
  const plan = planImport(await allRecords(store, { includeDeleted: true }), incoming);
  if (plan.apply.length) await store.applyRemote(plan.apply);
  return plan;
}

export function openBackup(ctx) {
  const { store } = ctx;
  const status = h('p', { class: 'sub', role: 'status', 'aria-live': 'polite' }, 'Export keeps a copy of your brews, beans and profiles. Import merges a backup into what’s here: nothing is overwritten unless the backup has a newer edit.');
  const say = (t) => { status.textContent = t; };
  const body = h('div', { class: 'section' },
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        saveFile(`dot-scale-backup-${today()}.json`, exportJSON(await allRecords(store)), 'application/json');
        say('Backup saved (JSON).');
      } }, 'Export JSON'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        const [brews, beans, profiles] = await Promise.all([store.list('brew'), store.list('bean'), store.list('profile')]);
        saveFile(`dot-scale-brews-${today()}.csv`, exportCSV({ brews, beans, profiles }), 'text/csv');
        say('Spreadsheet saved (CSV).');
      } }, 'Export CSV'),
      h('label', { class: 'btn secondary file-btn' }, 'Import JSON',
        h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import a JSON backup', onchange: async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            if (file.size > MAX_BYTES) throw new Error('That file is too big to be a Dot Scale backup.');
            const plan = await importText(store, await readText(file), { profileId: ctx.profile?.id });
            say(`Imported: ${plan.added} new, ${plan.updated} updated, ${plan.skipped} already here.`);
          } catch (err) { say(err.message || 'That file couldn’t be imported.'); }
        } }))),
    status);
  return openDialog({ title: 'Backup', body, actions: [{ label: 'Done', value: 'close', kind: 'primary' }] });
}
