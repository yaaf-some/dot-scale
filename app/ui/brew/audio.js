// Beeps with WebAudio. Browsers (and WebKit in Bluefy above all) only let audio start from a user gesture, so
// unlockAudio() is called on the first tap of the flow; until then beep() is a silent no-op. Pure oscillators, no files.
let ctx = null;

function context() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** Call from a click/touch handler. Safe to call many times. */
export function unlockAudio() {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  try { // an inaudible blip, the classic iOS unlock
    const o = c.createOscillator(); const g = c.createGain();
    g.gain.value = 0.0001; o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.01);
  } catch { /* ignore */ }
}

/** Patterns: 'target' (two high beeps), 'step' (one), 'done' (one low, longer). Returns false if audio isn't available. */
export function beep(kind = 'step') {
  const c = context();
  if (!c || c.state !== 'running') return false;
  const notes = { target: [[880, 0], [880, 0.22]], step: [[740, 0]], done: [[520, 0]] }[kind] ?? [[740, 0]];
  const len = kind === 'done' ? 0.4 : 0.14;
  for (const [freq, at] of notes) {
    const o = c.createOscillator(); const g = c.createGain();
    const t = c.currentTime + at;
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + len + 0.02);
  }
  return true;
}

/** A short vibration with the same pattern names as beep(), where the browser has navigator.vibrate (Android, desktop Chrome;
 *  not iOS/Bluefy, where the sound and the on-screen cue carry the message). Returns false when there is nothing to vibrate. */
export function buzz(kind = 'step') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try { return navigator.vibrate({ target: [90, 70, 90], step: 60, done: 160 }[kind] ?? 60); } catch { return false; }
}
