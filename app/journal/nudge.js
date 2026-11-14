// The Home nudge from history: ONE suggestion for the active profile, or null. Pure; registered in app/ui/journal-nudges.js.
// Candidates in order: a "dialled in" congratulation, a run of same-way shots on the latest bean, "past its peak soon".
import { buildTrail, grindText } from './history.js';

const DAY = 86400000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function beanAge(bean, now) {
  const t = Date.parse(`${bean?.roastDate}T12:00:00`);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
}

// What to say about a run of shots that all landed on the same side of the target.
const RUN = {
  fast: { text: 'ran fast', change: (steps, v, fh) => `start ${steps} step finer${hint(v, -steps, fh)}` },
  slow: { text: 'ran slow', change: (steps, v, fh) => `start ${steps} step coarser${hint(v, steps, fh)}` },
  short: { text: 'steeped short', change: () => 'steep a little longer' },
  long: { text: 'steeped long', change: () => 'steep a little shorter' },
};
// Grind numbers: lower is finer unless the gear says otherwise (same convention as the insights engine).
function hint(value, towardsCoarser, finerIsHigher) {
  if (!finite(value)) return '';
  const next = value + (finerIsHigher ? -towardsCoarser : towardsCoarser);
  return ` (try ${Math.round(next * 10) / 10})`;
}

/** All candidates for this profile, best first. `brews` = this profile's brews (any order). */
export function nudgeCandidates({ brews, beans = [], now = Date.now() }) {
  const out = [];
  const live = (brews ?? []).filter((b) => b && !b.deleted && b.beanId && finite(b.startedAt)).sort((a, b) => b.startedAt - a.startedAt);
  const last = live[0];
  const bean = last && beans.find((b) => b.id === last.beanId && !b.archived);
  if (!bean) return out;
  const trail = buildTrail(live.filter((b) => b.beanId === bean.id && b.method === last.method).slice(0, 12), { bean, method: last.method });
  const shots = trail.shots;
  const unit = last.method === 'espresso' ? 'shot' : 'brew';

  // 1. Dialled in recently (within the last 3 shots): say so, and what to keep.
  if (trail.dialledInId) {
    const at = shots.findIndex((s) => s.id === trail.dialledInId);
    if (at >= shots.length - 3) {
      const g = grindText(shots[at].brew);
      out.push({ id: `dialled-${bean.id}-${trail.dialledInId}`, tone: 'info',
        text: `${bean.name} is dialled in${g ? `: grind ${g}` : ''}. Two good ${unit}s in a row, so keep it there and just enjoy it.`,
        action: { label: 'See the trail', href: `#/journal/bean/${bean.id}?method=${last.method}` } });
    }
  }

  // 2. The latest run of same-way shots (2 or more).
  const run = [];
  for (let i = shots.length - 1; i >= 0 && shots[i].status && shots[i].status === shots[shots.length - 1].status; i--) run.unshift(shots[i]);
  const kind = RUN[shots[shots.length - 1]?.status];
  if (kind && run.length >= 2) {
    const n = Math.min(run.length, 3);
    const v = last.grind?.value;
    out.push({ id: `run-${shots[shots.length - 1].status}-${bean.id}-${last.id}`, tone: 'info',
      text: `Your last ${n} ${unit}s on ${bean.name} ${kind.text}; ${kind.change(1, v, !!last.gear?.grinderFinerIsHigher)}.`,
      action: { label: 'See the trail', href: `#/journal/bean/${bean.id}?method=${last.method}` } });
  }

  // 3. Beans getting old (the shell's own nudge covers very fresh and very old; this one is the heads-up in between).
  const age = beanAge(bean, now);
  if (age != null && age >= 28 && age <= 42) {
    out.push({ id: `peak-${bean.id}`, tone: 'info', text: `${bean.name} is ${age} days off roast. Still fine, but past its peak soon, so use it up and expect shots to run a little faster.` });
  }
  return out;
}

/** The single nudge to show, skipping ids the user dismissed. */
export function journalNudge(data) {
  const dismissed = data.dismissed ?? {};
  return nudgeCandidates(data).find((n) => !dismissed[n.id]) ?? null;
}
