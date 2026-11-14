// Learn: topic labels, filtering and per-profile "seen" tracking. Pure except for the small prefs object it is given
// (store.prefs: get(key, fallback) / async set(key, value)). "Seen" is device-local on purpose (PRODUCT.md §6 keeps prefs unsynced).
export const TOPICS = [
  { id: 'basics', label: 'The basics' },
  { id: 'espresso', label: 'Espresso' },
  { id: 'beans', label: 'Beans' },
  { id: 'pour-over', label: 'Pour-over' },
  { id: 'immersion', label: 'Immersion' },
  { id: 'moka', label: 'Moka pot' },
];
export const topicLabel = (id) => TOPICS.find((t) => t.id === id)?.label ?? (String(id).charAt(0).toUpperCase() + String(id).slice(1));

/** Topics that actually have cards, in the display order above (unknown topics last). */
export function topicsIn(cards) {
  const present = new Set(cards.map((c) => c.topic));
  const known = TOPICS.filter((t) => present.has(t.id));
  return [...known, ...[...present].filter((t) => !TOPICS.some((k) => k.id === t)).map((id) => ({ id, label: topicLabel(id) }))];
}

/** { topic, method } where '' / 'all' mean any. */
export function filterCards(cards, { topic, method } = {}) {
  const any = (v) => !v || v === 'all';
  return cards.filter((c) => (any(topic) || c.topic === topic) && (any(method) || c.methods?.includes(method)));
}

/** Other cards worth reading next: same topic first, then same methods; never the card itself. */
export function relatedCards(cards, card, limit = 3) {
  const score = (c) => (c.topic === card.topic ? 2 : 0) + (c.methods?.some((m) => card.methods?.includes(m)) ? 1 : 0);
  return cards.filter((c) => c.id !== card.id && score(c) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit);
}

export const seenKey = (profileId) => `learnSeen:${profileId || 'none'}`;

export function seenSet(prefs, profileId) {
  const v = prefs.get(seenKey(profileId), []);
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}

/** Returns true when the card was new to this profile. */
export async function markSeen(prefs, profileId, cardId) {
  const seen = seenSet(prefs, profileId);
  if (seen.has(cardId)) return false;
  seen.add(cardId);
  await prefs.set(seenKey(profileId), [...seen]);
  return true;
}

export const progress = (cards, seen) => ({ seen: cards.filter((c) => seen.has(c.id)).length, total: cards.length });
