// The Home screen shows at most ONE nudge. Any module can register a source; the highest priority wins.
//   registerNudge(priority, (data) => nudge | null)
//   data  = { store, scale, profile, brews, beans, now }      (brews = this profile's, newest first)
//   nudge = { id, tone: 'info' | 'warn', text, action?: { label, href } }
// The insights worker plugs in here for "your last 3 shots ran fast…" style nudges (suggested priority 60).
const sources = [];
export function registerNudge(priority, fn) { sources.push({ priority, fn }); sources.sort((a, b) => b.priority - a.priority); }

export function pickNudge(data) {
  for (const { fn } of sources) {
    try { const n = fn(data); if (n) return n; } catch (e) { console.error('nudge source failed', e); }
  }
  return null;
}

const DAY = 86400000;
export function daysOffRoast(roastDate, now = Date.now()) {
  const t = Date.parse(`${roastDate}T12:00:00`);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
}

registerNudge(90, ({ store }) => (store.persistent ? null : {
  id: 'storage', tone: 'warn',
  text: 'This browser isn’t keeping data between visits (private mode?). Brews and profiles will be lost when you close the page.',
}));

registerNudge(50, ({ scale }) => (scale.supported || scale.state.mode === 'demo' ? null : {
  id: 'no-bluetooth', tone: 'info',
  text: 'This browser can’t talk to Bluetooth. On iPhone and iPad open Dot Scale in Bluefy; on Android or desktop use Chrome.',
}));

registerNudge(40, ({ beans, now }) => {
  const dated = beans.filter((b) => !b.archived && b.roastDate).map((b) => ({ b, age: daysOffRoast(b.roastDate, now) })).filter((x) => x.age !== null && x.age >= 0);
  const latest = dated.sort((a, b) => a.age - b.age)[0];
  if (!latest) return null;
  const { b, age } = latest;
  if (age < 5) return { id: `fresh-${b.id}`, tone: 'info', text: `${b.name} is only ${age} day${age === 1 ? '' : 's'} off roast. Espresso can run gassy and erratic until about day 5; wait or let it degas.` };
  if (age > 42) return { id: `stale-${b.id}`, tone: 'info', text: `${b.name} is ${age} days off roast. Expect faster shots, so start a step finer.` };
  return null;
});
