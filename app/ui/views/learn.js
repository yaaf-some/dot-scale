// Learn: short cards, filterable by topic and method, with per-profile "seen" marks.
//   #/learn                list      #/learn?card=<id>  (or #/learn/<id>)   one card, as a readable page
// The Brew result screen links tips to cards this way: href="#/learn?card=why-fast-sour".
import { h, append } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState } from '../components.js';
import { methodById, METHODS } from '../labels.js';
import { CARDS, getCard } from '../../learn/cards.js';
import { filterCards, topicsIn, topicLabel, relatedCards, seenSet, markSeen, progress } from '../../learn/progress.js';
import { diagramNode } from '../learn/diagram.js';
import { ensureStyles, cardHref } from '../journal/shared.js';

export const meta = { title: 'Learn' };

const methodsOf = (card) => card.methods.length >= METHODS.length ? 'All brewing' : card.methods.map((m) => methodById(m).name).join(', ');
const kicker = (card) => [topicLabel(card.topic), methodsOf(card)].filter((x, i, a) => a.indexOf(x) === i).join(' · '); // "Espresso · Espresso" → "Espresso"

function cardLink(card, seen) {
  const read = seen.has(card.id);
  return h('a', { class: 'card-link', href: cardHref(card.id), 'data-testid': 'learn-card' },
    h('span', { class: `dot-new${read ? ' read' : ''}`, role: 'img', 'aria-label': read ? 'Seen' : 'New' }),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, card.title), h('span', { class: 'row-sub' }, kicker(card))),
    icon('chevron', { size: 20 }));
}

function readCard(root, ctx, card, seen) {
  ctx.setTitle(card.title);
  const diagram = card.diagram ? diagramNode(card.diagram) : null;
  const next = relatedCards(CARDS, card, 3);
  append(root, [
    h('a', { class: 'back', href: '#/learn' }, icon('back', { size: 20 }), 'Learn'),
    h('article', { class: 'article' },
      h('p', { class: 'sub' }, kicker(card)),
      h('h1', {}, card.title),
      diagram,
      h('p', { class: 'body' }, card.body)),
    next.length ? h('section', { class: 'section' }, h('h2', {}, 'Read next'), h('div', { class: 'cards' }, next.map((c) => cardLink(c, seen)))) : null,
  ]);
  // Opening a card counts as reading it (for this profile, on this device).
  markSeen(ctx.prefs, ctx.profile?.id, card.id);
}

export async function mount(root, ctx) {
  await ensureStyles();
  const wanted = ctx.query.card || ctx.params[0];
  const seen = seenSet(ctx.prefs, ctx.profile?.id);
  if (wanted) {
    const card = getCard(wanted);
    if (card) return readCard(root, ctx, card, seen);
    ctx.toast('That lesson isn’t available.');
  }

  const state = { topic: 'all', method: 'all' };
  const body = h('div', { class: 'section' });
  const paint = () => {
    const shown = filterCards(CARDS, state);
    const p = progress(CARDS, seen);
    const topics = topicsIn(CARDS);
    body.replaceChildren();
    append(body, [
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Topic' }, [{ id: 'all', label: 'All' }, ...topics].map((t) =>
        h('button', { class: 'pill', type: 'button', 'aria-pressed': String(state.topic === t.id), onclick: () => { state.topic = t.id; paint(); } }, t.label))),
      h('div', { class: 'filters' }, h('label', {}, 'Method',
        h('select', { onchange: (e) => { state.method = e.target.value; paint(); } },
          [{ id: 'all', name: 'All methods' }, ...METHODS].map((m) => h('option', { value: m.id, selected: m.id === state.method }, m.name))))),
      shown.length
        ? h('div', { class: 'cards' }, shown.map((c) => cardLink(c, seen)))
        : emptyState({ iconName: 'learn', title: 'No lessons match', text: 'Try another topic or method.', actions: [h('button', { class: 'btn secondary', type: 'button', onclick: () => { state.topic = state.method = 'all'; paint(); } }, 'Show all')] }),
      h('p', { class: 'learn-progress sub' }, `You’ve read ${p.seen} of ${p.total} lessons${ctx.profile ? `, ${ctx.profile.name}` : ''}.`),
    ]);
  };
  append(root, [h('div', { class: 'view-head' }, h('h1', {}, 'Learn')), body]);
  paint();
}
