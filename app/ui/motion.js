// Motion helpers. Everything here degrades to "no animation": no View Transitions, reduced motion, a hidden page, or an
// error all just run the update immediately. Durations and easings are CSS tokens (tokens.css); the CSS for each effect
// lives in app.css under `@media (prefers-reduced-motion: no-preference)`.

/** True when the person asked for less motion. Checked per call, so a changed setting applies without a reload. */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run `update` (sync or async) inside a View Transition when the browser supports it, otherwise just run it.
 * `kind` picks the animation in CSS through <html data-vt="…">: 'tab' (crossfade), 'push' (new screen enters from the end),
 * 'pop' (back), 'result' (the result rises in). Resolves when `update` is done, never rejects because of the animation.
 * Safari 18+ and Chromium have the API; older WebKit (Bluefy on older iOS) takes the instant path.
 */
export async function transition(update, { kind = 'tab' } = {}) {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== 'function' || reducedMotion() || document.visibilityState === 'hidden') return update();
  let vt;
  root.dataset.vt = kind;
  try { vt = document.startViewTransition(update); } catch { delete root.dataset.vt; return update(); }
  const clear = () => { if (root.dataset.vt === kind) delete root.dataset.vt; };
  vt.finished.then(clear, clear);
  await vt.updateCallbackDone;
}

/** Re-run a one-shot CSS animation on `el` by toggling a data attribute (the CSS keys off `[data-<name>]`). */
export function replay(el, name, ms = 1000) {
  el.removeAttribute(`data-${name}`);
  void el.offsetWidth; // restart the animation
  el.setAttribute(`data-${name}`, '');
  clearTimeout(replay.t?.get(el));
  (replay.t ??= new WeakMap()).set(el, setTimeout(() => el.removeAttribute(`data-${name}`), ms));
}

/**
 * Leave animation for an element that is about to be removed or closed: sets `data-leaving` (CSS animates it out), then calls
 * `done` after the exit time, or at once when there is nothing to wait for. Uses a timer so it never depends on animationend.
 */
export function leave(el, done, ms = 140) {
  if (reducedMotion() || !el.isConnected) return done();
  el.setAttribute('data-leaving', '');
  setTimeout(done, ms);
}

/**
 * Show a soft placeholder if `promise` takes longer than `delay` ms and `root` is still empty (so fast screens never flash
 * one). The placeholder is removed when the promise settles. Resolves to the promise's value.
 */
export async function withPlaceholder(root, promise, { delay = 140, lines = 3 } = {}) {
  let sk = null;
  const t = setTimeout(() => {
    if (root.firstChild) return;
    sk = document.createElement('div');
    sk.className = 'skeleton'; sk.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < lines; i++) sk.append(document.createElement('i'));
    root.append(sk);
  }, delay);
  try { return await promise; } finally { clearTimeout(t); sk?.remove(); }
}
