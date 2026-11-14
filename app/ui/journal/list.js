// Journal list: brews grouped by day, filters, backup button.
import { h, append } from '../dom.js';
import { icon } from '../icons.js';
import { group, emptyState } from '../components.js';
import { methodById } from '../labels.js';
import { groupByDay, filterBrews, filterChoices, ratioText, stars, beanOf, grindText, NO_BEAN } from '../../journal/history.js';
import { sparkline } from './chart.js';
import { starsNode, timeText, clock, loadAll } from './shared.js';
import { openBackup } from './backup-ui.js';

export function brewTitle(b, beans) { return beanOf(beans, b)?.name ?? methodById(b.method).name; }

function row(b, beans) {
  const m = methodById(b.method);
  const bean = beanOf(beans, b);
  const sub = [bean ? m.name : null, ratioText(b), timeText(b.timeS), b.legacy ? 'Earlier app' : (grindText(b) ? `grind ${grindText(b)}` : null), clock(b.startedAt)].filter(Boolean).join(' · ');
  const s = stars(b);
  return h('a', { class: 'jrow', href: `#/journal/brew/${encodeURIComponent(b.id)}`, 'data-testid': 'brew-row' },
    h('span', { class: 'jrow-icon' }, icon(m.icon, { size: 22 })),
    h('span', { class: 'jrow-main' }, h('span', { class: 'jrow-title' }, brewTitle(b, beans)), h('span', { class: 'jrow-sub' }, sub)),
    h('span', { class: 'jrow-end' }, sparkline(b), starsNode(s)));
}

function select(label, value, options, onchange) {
  const el = h('select', { onchange: () => onchange(el.value) }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return h('label', {}, label, el);
}

export async function mount(root, ctx) {
  const filters = { profileId: ctx.profile?.id ?? 'all', method: 'all', beanId: 'all' };
  const body = h('div', { class: 'journal-body' });
  let data = await loadAll(ctx.store);

  const paint = () => {
    const { brews, beans, profiles } = data;
    const byProfile = filterBrews(brews, { profileId: filters.profileId });
    const choices = filterChoices(byProfile);
    if (filters.method !== 'all' && !choices.methods.includes(filters.method)) filters.method = 'all';
    const beanOk = (id) => id === 'all' || (id === NO_BEAN ? choices.noBean : choices.beanIds.includes(id));
    if (!beanOk(filters.beanId)) filters.beanId = 'all';

    if (!brews.length) {
      body.replaceChildren(emptyState({ iconName: 'journal', title: 'No brews yet', text: 'Each brew you save lands here with its curve, a takeaway, and what to try next. Your bean dial-in trail builds up over time.',
        actions: [h('a', { class: 'btn primary', href: '#/brew' }, 'Start a brew')] }));
      return;
    }
    const shown = filterBrews(brews, filters);
    const beanName = (id) => beans.find((b) => b.id === id)?.name ?? 'Unknown beans';
    const bar = h('div', { class: 'filters' },
      select('Who', filters.profileId, [{ value: 'all', label: 'Everyone' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))], (v) => { filters.profileId = v; paint(); }),
      select('Method', filters.method, [{ value: 'all', label: 'All methods' }, ...choices.methods.map((id) => ({ value: id, label: methodById(id).name }))], (v) => { filters.method = v; paint(); }),
      select('Beans', filters.beanId, [{ value: 'all', label: 'All beans' }, ...choices.beanIds.map((id) => ({ value: id, label: beanName(id) })), ...(choices.noBean ? [{ value: NO_BEAN, label: 'No beans noted' }] : [])], (v) => { filters.beanId = v; paint(); }));
    const trail = filters.beanId !== 'all' && filters.beanId !== NO_BEAN
      ? h('a', { class: 'btn secondary small trail-link', href: `#/journal/bean/${encodeURIComponent(filters.beanId)}?${new URLSearchParams({ ...(filters.method !== 'all' ? { method: filters.method } : {}), ...(filters.profileId !== 'all' ? { profile: filters.profileId } : {}) })}` }, icon('chevron', { size: 18 }), `Dial-in trail for ${beanName(filters.beanId)}`)
      : null;
    const days = groupByDay(shown);
    body.replaceChildren();
    append(body, [
      bar, trail,
      days.length
        ? h('div', { class: 'days' }, days.map((d) => h('section', { class: 'day', 'aria-label': d.label },
          h('h2', { class: 'day-head' }, d.label), group(d.brews.map((b) => row(b, beans))))))
        : emptyState({ iconName: 'journal', title: 'No brews match', text: 'Try a different person, method or beans.',
          actions: [h('button', { class: 'btn secondary', type: 'button', onclick: () => { Object.assign(filters, { profileId: 'all', method: 'all', beanId: 'all' }); paint(); } }, 'Show everything')] }),
    ]);
  };

  append(root, [
    h('div', { class: 'view-head' }, h('h1', {}, 'Journal'),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => openBackup(ctx) }, 'Backup')),
    body,
  ]);
  paint();
  // New brews, edits, imports and synced changes repaint the list in place (filters stay).
  // An import or sync batch fires one event per record: coalesce them, and ignore a slow load that a newer one has overtaken.
  let timer, load = 0;
  ctx.store.on('change', (e) => {
    if (!['brew', 'bean', 'profile'].includes(e.type)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => { const mine = ++load; const fresh = await loadAll(ctx.store); if (mine === load && !ctx.signal.aborted) { data = fresh; paint(); } }, 80);
  }, { signal: ctx.signal });
  ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}
