import { createBrewSession } from '../app/core/brew-session.js';
import { defaultRecipe } from '../app/methods/index.js';

// ---------- a tiny simulated scale ----------
// `load` is the true weight on the scale; the rig quantises to 0.1 g, adds noise, applies tare commands (0.3 s lag),
// and feeds the session at `dt`. Scenarios script the world with rig.at(t, fn) and rig.physics.
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function makeRig(session, { noise = 0.04, seed = 7, dt = 0.1 } = {}) {
  const rng = mulberry32(seed);
  const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.73; // ~N(0,1)
  const rig = {
    recorder: () => session.record(),
    t: 0, dt, load: 0, offset: 0, tareAt: null, prev: 0, physics: null, sched: [],
    events: [], cues: [], commands: [], states: [], last: null,
    at(t, fn) { rig.sched.push([t, fn]); rig.sched.sort((a, b) => a[0] - b[0]); },
    take(out) {
      rig.last = out; rig.states.push(out.state);
      rig.events.push(...out.events); rig.cues.push(...out.cues);
      for (const c of out.commands) { rig.commands.push(c); if (c.cmd === 'tare') rig.tareAt = rig.t + 0.3; }
    },
    send(e) { rig.take(session.dispatch({ ...e, t: rig.t })); },
    tick() {
      rig.t = Math.round((rig.t + rig.dt) * 1000) / 1000;
      while (rig.sched.length && rig.sched[0][0] <= rig.t + 1e-9) rig.sched.shift()[1](rig);
      rig.physics?.(rig.t, rig.dt, rig);
      if (rig.tareAt != null && rig.t >= rig.tareAt) { rig.offset = rig.load; rig.tareAt = null; }
      const grams = Math.round((rig.load - rig.offset + noise * gauss()) * 10) / 10;
      const flow = Math.max(0, (grams - rig.prev) / rig.dt); // like the real scale: coarse and clamped
      rig.prev = grams;
      rig.take(session.feed({ t: rig.t, grams, flow }));
    },
    run(until) { while (rig.t < until - 1e-9) rig.tick(); },
    runWhile(cond, max = 600) { const end = rig.t + max; while (cond() && rig.t < end) rig.tick(); },
    when: (type) => rig.events.find((e) => e.type === type),
    cmds: (name) => rig.commands.filter((c) => c.cmd === name),
    cueIds: () => rig.cues.map((c) => c.id),
    get state() { return rig.last.state; },
  };
  return rig;
}

// Espresso world: portafilter with beans on the scale, then removed, cup placed, pump on. Flow comes from a simple pump model.
export function espressoRig(opts = {}) {
  const { recipe = defaultRecipe('espresso'), history, stallAtG, stallS = 4, stallForever = false, seed = 7, reaction = 0.5, settings } = opts;
  const session = createBrewSession({ method: 'espresso', recipe, history, settings });
  const rig = makeRig(session, { seed });
  const w = { cup: 0, cupOn: false, pf: 0, pump: false, pumpT: null, offT: null, stall: null, stalled: false, flow: 0, firstFlowT: null };
  rig.w = w;
  rig.physics = (t, dt) => {
    let f = 0;
    if (w.pump) {
      const tau = t - w.pumpT;
      f = tau < 7 ? 0 : Math.min(1.3, 0.25 + (tau - 7) * 0.35);
      if (w.firstFlowT == null && f > 0) w.firstFlowT = t;
      if (stallAtG != null && !w.stalled && w.cup >= stallAtG) { w.stalled = true; w.stall = { from: t, to: stallForever ? Infinity : t + stallS }; }
      if (w.stall && t >= w.stall.from && t < w.stall.to) f = 0.02;
    } else if (w.offT != null) f = 1.3 * Math.exp(-(t - w.offT) / 1.2);
    if (w.offT != null && f < 0.02) f = 0;
    w.flow = f;
    w.cup += f * dt;
    rig.load = w.pf + (w.cupOn ? 110 + w.cup : 0);
  };
  // stop the pump `reaction` s after the "stop the pump" cue
  const origTake = rig.take;
  rig.take = (out) => {
    origTake(out);
    if (out.cues.some((c) => c.id === 'espresso:stop') && w.pump && w.offT == null) rig.at(rig.t + reaction, () => { w.pump = false; w.offT = rig.t; });
  };
  if (settings) rig.settings = settings;
  // script: begin, beans in the portafilter, use as dose, remove it, put the cup on
  rig.send({ type: 'begin' });
  w.pf = 16;
  rig.run(3);
  return rig;
}
export function espressoToReady(rig, cupAt = 8) {
  const w = rig.w;
  rig.send({ type: 'useAsDose' });
  rig.at(5, () => { w.pf = 0; });
  rig.at(cupAt, () => { w.cupOn = true; });
  rig.runWhile(() => rig.state.phase !== 'ready', 120);
}
export const pumpOn = (rig) => { rig.w.pump = true; rig.w.pumpT = rig.t; };

