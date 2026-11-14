// Journal: STUB with its empty state. History by day, detail, compare and per-bean dial-in trail are built by another worker.
import { h } from '../dom.js';
import { emptyState } from '../components.js';

export const meta = { title: 'Journal' };

export async function mount(root, ctx) {
  const brews = (await ctx.store.list('brew')).filter((b) => b.profileId === ctx.profile?.id);
  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Journal')),
    brews.length
      ? emptyState({ iconName: 'journal', title: `${brews.length} saved brew${brews.length === 1 ? '' : 's'}`, text: 'They’re safe in this browser. The journal that shows them, with curves and what to change next, is being built.',
        actions: [h('a', { class: 'btn primary', href: '#/brew' }, 'Start a brew')] })
      : emptyState({ iconName: 'journal', title: 'No brews yet', text: 'Each brew you save lands here with its curve, a takeaway, and what to try next. Your bean dial-in trail builds up over time.',
        actions: [h('a', { class: 'btn primary', href: '#/brew' }, 'Start a brew')] }));
}
