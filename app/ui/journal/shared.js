// Small helpers shared by the Journal and Learn views.
import { h } from '../dom.js';
import { fmtTime } from '../dom.js';

let stylesReady;
/** Add journal.css once and wait for it, so the first paint isn't unstyled. Never rejects (a missing sheet just means plainer styling). */
export function ensureStyles() {
  stylesReady ??= new Promise((done) => {
    const link = h('link', { rel: 'stylesheet', href: new URL('../journal.css', import.meta.url).href });
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    document.head.append(link);
    setTimeout(done, 3000);
  });
  return stylesReady;
}

/** "★★★★☆" as text with an accessible label; null when unrated. */
export function starsNode(n) {
  if (!n) return null;
  return h('span', { class: 'stars', role: 'img', 'aria-label': `${n} of 5 stars` },
    '★'.repeat(n), h('span', { class: 'off', 'aria-hidden': 'true' }, '★'.repeat(5 - n)));
}

/** "27 s" for short shots, "3:10" for longer brews. */
export const timeText = (s) => (typeof s !== 'number' || !Number.isFinite(s) ? '–' : s < 100 ? `${Math.round(s)} s` : fmtTime(s));

export const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const fullDate = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export const BALANCE = { '-2': 'Very sour', '-1': 'A little sour', 0: 'Balanced', 1: 'A little bitter', 2: 'Very bitter' };
export const STRENGTH = { '-2': 'Weak', '-1': 'A little weak', 0: 'Just right', 1: 'A little strong', 2: 'Very strong' };

export function cardHref(id) { return `#/learn?card=${encodeURIComponent(id)}`; }

/** Hands text to the user as a downloaded file. */
export function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  if ('download' in a) a.click(); else window.open(url, '_blank'); // very old WebViews ignore download=
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export async function loadAll(store) {
  const [brews, beans, profiles] = await Promise.all([store.list('brew'), store.list('bean'), store.list('profile')]);
  profiles.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.name.localeCompare(b.name));
  return { brews, beans, profiles };
}
