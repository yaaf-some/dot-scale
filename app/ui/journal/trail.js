// Dial-in trail for one bean: the shots in order, what changed between them, and what came of it.
import { h, append, fmtG } from '../dom.js';
import { icon } from '../icons.js';
import { section, segmented } from '../components.js';
import { methodById } from '../labels.js';
import { RULES } from '../../insights/rules.js';
import { buildTrail, groupByBean } from '../../journal/history.js';
import { beanAge } from '../../journal/nudge.js';
import { starsNode, timeText, shortDate } from './shared.js';

const NS = 'http://www.w3.org/2000/svg';
const OUTCOME = { fast: 'Ran fast', slow: 'Ran slow', sweet: 'On target', ok: 'In range', short: 'Steeped short', long: 'Steeped long' };

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Shot time per shot against the sweet window (espresso). null when there is nothing to plot. */
export function timeTrend(shots, win) {
  const pts = shots.map((s, i) => ({ i, t: s.effectiveTimeS ?? s.timeS, hit: s.dialledIn || (s.inRange && (s.stars ?? 0) >= 4) })).filter((p) => Number.isFinite(p.t));
  if (pts.length < 2) return null;
  const W = 320, H = 120, l = 30, r = 8, t = 8, b = 20;
  const top = Math.max(win.slowAboveS + 5, ...pts.map((p) => p.t)) * 1.05;
  const X = (i) => l + (shots.length === 1 ? 0 : (i / (shots.length - 1)) * (W - l - r));
  const Y = (v) => t + (H - t - b) * (1 - v / top);
  const svg = svgEl('svg', { class: 'trend', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Shot time for each shot: ${pts.map((p) => `${Math.round(p.t)} s`).join(', ')}. The target window is ${win.sweetFromS} to ${win.sweetToS} s.` });
  svg.append(svgEl('rect', { class: 'band', x: l, y: Y(win.sweetToS), width: W - l - r, height: Y(win.sweetFromS) - Y(win.sweetToS) }),
    svgEl('line', { class: 'axis', x1: l, y1: H - b, x2: W - r, y2: H - b }),
    svgEl('text', { x: 2, y: Y(win.sweetToS) + 4 }, `${win.sweetToS}s`), svgEl('text', { x: 2, y: Y(win.sweetFromS) + 4 }, `${win.sweetFromS}s`),
    svgEl('text', { x: l, y: H - 5 }, 'first shot'), svgEl('text', { x: W - r, y: H - 5, 'text-anchor': 'end' }, 'latest'),
    svgEl('path', { class: 'line', d: pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(1)} ${Y(p.t).toFixed(1)}`).join('') }));
  for (const p of pts) svg.append(svgEl('circle', { class: `dot${p.hit ? ' hit' : ''}`, cx: X(p.i).toFixed(1), cy: Y(p.t).toFixed(1), r: 4.5 }));
  return svg;
}

function shotItem(s, prev) {
  const g = s.grind;
  const pg = prev?.grind;
  return h('li', { class: s.dialledIn ? 'dialled' : '', 'data-testid': 'trail-shot' },
    h('div', { class: 'trail-head' },
      h('a', { href: `#/journal/brew/${encodeURIComponent(s.id)}` }, shortDate(s.startedAt)),
      s.status ? h('span', { class: `pill ${s.inRange ? 'good' : 'warn'}` }, OUTCOME[s.status] ?? s.status) : null,
      s.dialledIn ? h('span', { class: 'badge' }, icon('check', { size: 16 }), 'Dialled in') : null, starsNode(s.stars)),
    h('div', { class: 'trail-nums' }, [
      g ? (pg && pg !== g ? `Grind ${pg} → ${g}` : `Grind ${g}`) : 'Grind not noted',
      s.change && s.change.kind !== 'same' && s.change.kind !== 'changed' ? s.change.label : s.change?.kind === 'same' ? 'unchanged' : null,
    ].filter(Boolean).join(' · ')),
    s.verdict ? h('p', { class: 'sub' }, s.verdict) // the verdict already carries yield and time
      : h('div', { class: 'trail-nums' }, [timeText(s.timeS), s.yield != null ? `${fmtG(s.yield, 1)} g out` : null].filter(Boolean).join(' · ')));
}

export async function mount(root, ctx, beanId) {
  const { store } = ctx;
  const [bean, brews] = await Promise.all([store.get(beanId), store.list('brew')]);
  // Whose shots: the owner named in the link (so a brew opened from "Everyone" shows its own trail), else the active profile.
  const profile = (ctx.query.profile && ctx.profiles.find((p) => p.id === ctx.query.profile)) || ctx.profile;
  const back = h('a', { class: 'back', href: '#/journal' }, icon('back', { size: 20 }), 'Journal');
  const mine = brews.filter((b) => b.beanId === beanId && (!profile || b.profileId === profile.id));
  if (!bean || !mine.length) {
    append(root, [back, h('div', { class: 'empty' }, h('h2', {}, bean ? `No brews on ${bean.name} yet` : 'Beans not found'),
      h('p', {}, bean ? `${profile?.name ?? 'You'} haven’t brewed these beans yet. Once there are a few shots, their trail shows up here.` : 'These beans may have been removed.'),
      h('a', { class: 'btn primary', href: '#/brew' }, 'Start a brew'))]);
    return;
  }
  const groups = groupByBean(mine).filter((g) => g.beanId === beanId);
  let method = groups.find((g) => g.method === ctx.query.method)?.method ?? groups[0].method;
  const stage = h('div', { class: 'section' });
  ctx.setTitle(`${bean.name} trail`);

  const paint = () => {
    const brewsOfMethod = groups.find((g) => g.method === method).brews;
    const trail = buildTrail(brewsOfMethod, { bean, method });
    const at = trail.shots.findIndex((s) => s.dialledIn);
    const win = RULES.espresso.time;
    const trend = method === 'espresso' ? timeTrend(trail.shots, win) : null;
    stage.replaceChildren(...[
      trail.dialledIn
        ? h('p', {}, h('span', { class: 'badge' }, icon('check', { size: 16 }), 'Dialled in'), ' ', `at shot ${at + 1}${trail.shots[at].grind ? `, grind ${trail.shots[at].grind}` : ''}.`)
        : h('p', { class: 'sub' }, 'Dialled in means two shots in a row on target and rated 4 stars or more.'),
      trend ? section('Shot time', [trend, h('p', { class: 'sub' }, `The shaded band is the ${win.sweetFromS}–${win.sweetToS} s target. Dots in crema are good shots.`)], { id: 'trend' }) : null,
      section('Shots, oldest first', h('ol', { class: 'trail' }, trail.shots.map((s, i) => shotItem(s, trail.shots[i - 1]))), { id: 'shots' }),
    ].filter(Boolean));
  };

  const age = bean.roastDate ? beanAge(bean, Date.now()) : null;
  append(root, [
    back,
    h('header', { class: 'section' }, h('h1', {}, bean.name),
      h('p', { class: 'sub' }, [bean.roaster, age != null && age >= 0 ? `${age} days off roast` : null, `${profile?.name ?? ''}’s shots`.trim()].filter(Boolean).join(' · '))),
    groups.length > 1 ? segmented({ label: 'Method', value: method, options: groups.map((g) => ({ value: g.method, label: methodById(g.method).name })), onchange: (v) => { method = v; paint(); } }) : null,
    stage,
  ]);
  paint();
}
