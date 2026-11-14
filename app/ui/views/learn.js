// Learn: STUB with its empty state. Cards, unlocked by what you brew, are built by another worker.
import { h } from '../dom.js';
import { emptyState } from '../components.js';

export const meta = { title: 'Learn' };

export function mount(root) {
  root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Learn')),
    emptyState({ iconName: 'learn', title: 'Short lessons, as you brew', text: 'Small cards explain why a fast shot tastes sour or why flow matters. They unlock from what you brew, and you’ll find each one here afterwards.',
      actions: [h('a', { class: 'btn primary', href: '#/brew' }, 'Start a brew')] }));
}
