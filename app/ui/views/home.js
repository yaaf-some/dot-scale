// Home: profile switcher, scale status, one nudge, and Brew again tickets (PRODUCT.md §3).
import { h, fmtG, append } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, section, ago } from '../components.js';
import { scaleLine } from '../scale-line.js';
import { editProfile } from '../editors.js';
import { methodById } from '../labels.js';
import { pickNudge, dismissNudge } from '../nudges.js';

export const meta = { title: 'Home' };

const greeting = (d = new Date()) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');

/** Recipes and brews → the tickets to show. Favourite per method first, then the most recent per method. */
export function brewAgainItems(recipes, brews, beans) {
  const beanName = (id) => beans.find((b) => b.id === id)?.name;
  const items = [];
  const methods = new Set([...recipes.map((r) => r.method), ...brews.map((b) => b.method)]);
  for (const method of methods) {
    const fav = recipes.find((r) => r.method === method && r.favorite);
    const lastBrew = brews.filter((b) => b.method === method).sort((a, b) => b.startedAt - a.startedAt)[0];
    const lastRecipe = recipes.filter((r) => r.method === method).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const recent = lastBrew && (!lastRecipe || lastBrew.startedAt >= lastRecipe.updatedAt)
      ? { id: lastBrew.id, kind: 'brew', dose: lastBrew.dose, yield: lastBrew.yield, at: lastBrew.startedAt, bean: beanName(lastBrew.beanId), label: 'Last brew' }
      : lastRecipe && { id: lastRecipe.id, kind: 'recipe', dose: lastRecipe.dose, yield: lastRecipe.yield, at: lastRecipe.updatedAt, bean: beanName(lastRecipe.beanId), label: lastRecipe.name || 'Recipe' };
    if (fav) items.push({ method, id: fav.id, kind: 'recipe', dose: fav.dose, yield: fav.yield, at: fav.updatedAt, bean: beanName(fav.beanId), label: 'Favourite', favorite: true });
    if (recent && !(fav && recent.dose === fav.dose && recent.yield === fav.yield)) items.push({ method, ...recent });
  }
  return items.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.at - a.at).slice(0, 6);
}

function ticket(item) {
  const m = methodById(item.method);
  const ratio = item.dose > 0 ? `1:${(item.yield / item.dose).toFixed(1).replace(/\.0$/, '')}` : '';
  return h('a', { class: 'ticket', href: `#/brew/${item.method}?${item.kind}=${encodeURIComponent(item.id)}`, 'aria-label': `Brew again: ${m.name}, ${fmtG(item.dose, 1)} g to ${fmtG(item.yield)} g` },
    h('div', { class: 'ticket-method' }, icon(m.icon, { size: 20 }), m.name),
    h('div', { class: 'ticket-nums num' }, fmtG(item.dose, 1), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), fmtG(item.yield), h('span', { class: 'unit' }, 'g')),
    h('div', { class: 'ticket-meta' }, [item.label, ratio, item.bean, item.kind === 'brew' || !item.favorite ? ago(item.at) : null].filter(Boolean).join(' · ')),
    h('span', { class: 'ticket-go', 'aria-hidden': 'true' }, icon('chevron', { size: 28 })));
}

function nudgeNode(nudge, store) {
  const el = h('div', { class: 'nudge', 'data-tone': nudge.tone, 'data-nudge': nudge.id },
    h('p', {}, nudge.text),
    h('div', { class: 'chip-group' },
      nudge.action ? h('a', { class: 'link', href: nudge.action.href }, nudge.action.label) : null,
      nudge.tone === 'warn' ? null : h('button', { class: 'link', type: 'button', onclick: () => { el.remove(); dismissNudge(store, nudge.id); } }, 'Dismiss')));
  return el;
}

export async function mount(root, ctx) {
  const { store, profile, profiles } = ctx;

  const [recipes, brews, beans] = await Promise.all([
    store.list('recipe'), store.list('brew'), store.list('bean'),
  ]);
  const mine = (r) => r.profileId === profile?.id;
  const myRecipes = recipes.filter(mine), myBrews = brews.filter(mine);
  const brewable = myBrews.filter((b) => !b.incomplete); // an interrupted shot isn't a recipe to repeat
  const items = brewAgainItems(myRecipes, brewable, beans);
  const nudge = pickNudge({ store, scale: ctx.scale, profile, brews: myBrews, beans, now: Date.now() });

  const switcher = h('div', { class: 'profile-bar', role: 'group', 'aria-label': 'Who’s brewing' },
    profiles.map((p) => h('button', { class: 'profile-chip', type: 'button', 'aria-pressed': String(p.id === profile?.id), onclick: () => p.id !== profile?.id && ctx.setProfile(p.id) }, avatar(p), p.name)),
    h('button', {
      class: 'profile-chip add', type: 'button', 'aria-label': 'Add a profile',
      onclick: async () => { const created = await editProfile(store); if (created) ctx.setProfile(created.id); },
    }, icon('plus', { size: 20 }), 'Add'));

  append(root, [
    switcher,
    h('h1', { class: 'home-title' }, profile ? `${greeting()}, ${profile.name}` : 'Welcome'),
    scaleLine(ctx),
    nudge ? nudgeNode(nudge, store) : null,
    items.length
      ? section('Brew again', h('div', { class: 'tickets' }, items.map(ticket)), { id: 'again' })
      : h('a', { class: 'ticket first', href: '#/brew', 'data-testid': 'first-brew' },
        h('div', { class: 'ticket-method' }, icon('brew', { size: 20 }), 'Your first brew'),
        h('div', { class: 'ticket-nums num' }, 'Start your first brew'),
        h('div', { class: 'ticket-meta' }, 'Pick a method, check the recipe, and let the scale do the rest.'),
        h('span', { class: 'ticket-go', 'aria-hidden': 'true' }, icon('chevron', { size: 28 }))),
  ]);
}
