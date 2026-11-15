// The runner connects one brew session to the real world: scale weight events in, scale commands out, beeps, and the
// curve collected for the live chart. The session itself stays pure (app/core/brew-session.js); screens only talk to the runner.
//
//   const run = createRunner({ scale, prefs, method, recipe, history, profileId });
//   run.on('update', ({ state, events, cues }) => …)     // after every sample or user event
//   run.dispatch({ type: 'useAsDose' })                  // session events (begin, useAsDose, start, finish, pumpOff, …)
//   run.state / run.points / run.startedAt / run.connected
//   run.destroy()
import { Emitter } from '../../core/events.js';
import { createBrewSession } from '../../core/brew-session.js';
import { beep, buzz } from './audio.js';

/** Is there a manual "Done" button on the live screen? Espresso ends by itself (flow detection), so there is none, unless the
 *  person turned "Finish espresso by itself" off in Settings: then it is the only way to end the shot short of the 2 minute limit. */
export const showsManualEnd = (kind, settings) => kind !== 'espresso' || settings?.autoStop === false;

/** What a cue sounds like, or null for silent. Pure, so it can be tested. */
export function beepFor(cue) {
  if (cue.id === 'espresso:stop') return 'target';
  if (/^step:\d+:reached$/.test(cue.id)) return 'step';
  if (/^step:[1-9]\d*$/.test(cue.id)) return 'step';
  if (cue.id === 'done') return 'done';
  return null;
}

export function createRunner({ scale, prefs, method, recipe, history = [], profileId }) {
  const bus = new Emitter();
  const settings = {
    profileId,
    autoTare: prefs.get('autoTare', true), autoStart: prefs.get('autoStart', true), autoStop: prefs.get('autoStop', true),
  };
  const session = createBrewSession({ method, recipe, history, settings });
  const points = [];
  let startedAt = null;
  let last = session.state;
  let closed = false;
  let pumpTimer = null, pumpArmed = false;
  // In Demo the flow comes from the demo panel, not from the scale's timer. The demo may be started after this runner exists.
  let decoupled = null;
  const decouple = () => { const d = scale.demo; if (d && d !== decoupled?.d) { decoupled = { d, was: d.sim.coupled }; d.coupleTimer(false); } };
  decouple();

  function applyCommands(commands) {
    for (const c of commands) {
      if (c.cmd === 'tare') scale.tare();
      else if (c.cmd === 'timer:reset') scale.timer.reset();
      else if (c.cmd === 'timer:start') scale.timer.start();
      else if (c.cmd === 'timer:stop') scale.timer.pause();
    }
  }

  function apply(out) {
    if (closed) return out;
    last = out.state;
    applyCommands(out.commands);
    for (const e of out.events) if (e.type === 'start') startedAt = Date.now() - Math.max(0, (out.state.t - (e.t0 ?? out.state.t)) * 1000);
    if (out.state.phase === 'running' && out.state.startT != null) {
      points.push({ t: out.state.t - out.state.startT, g: out.state.grams, f: out.state.flow });
    }
    if (prefs.get('beep', true)) for (const c of out.cues) { const k = beepFor(c); if (k) { beep(k); buzz(k); } }
    bus.emit('update', out);
    return out;
  }

  const offWeight = scale.on('weight', ({ grams, flow, at }) => {
    if (scale.state.status !== 'connected') return; // the shell sends a zero reading on disconnect; it is not a measurement
    apply(session.feed({ t: at / 1000, grams, flow }));
  });
  const offStatus = scale.on('status', () => { decouple(); bus.emit('connection', { connected: scale.state.status === 'connected', status: scale.state.status, text: scale.state.text }); });

  return {
    session,
    on: bus.on.bind(bus),
    get state() { return last; },
    get points() { return points; },
    get startedAt() { return startedAt; },
    get connected() { return scale.state.status === 'connected'; },
    dispatch(e) {
      const first = e.type === 'pumpOff' && !pumpArmed;
      const out = apply(session.dispatch(e));
      if (first) { pumpArmed = true; // the drip after the pump stops is part of the curve: give it a few seconds, then finish
        clearTimeout(pumpTimer);
        pumpTimer = setTimeout(() => { if (!closed && session.state.phase === 'running') apply(session.dispatch({ type: 'finish' })); }, 3500);
      }
      return out;
    },
    destroy() {
      if (closed) return;
      const running = last.phase === 'running';
      closed = true; clearTimeout(pumpTimer); offWeight(); offStatus();
      if (running) scale.timer.reset();
      if (decoupled) decoupled.d.coupleTimer(decoupled.was);
    },
  };
}
