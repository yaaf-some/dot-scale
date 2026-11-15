// Step 4: the live screen. Readable from 1 m: weight huge, timer large, flow medium, target progress, the one thing to do now.
// Hands-off (auto-tare, auto-start, auto-stop come from the session); every manual button stays available (>= 64 px).
import { h, append, fmtG, fmtTime } from '../dom.js';
import { icon } from '../icons.js';
import { confirmDialog } from '../dialog.js';
import { stepsFor } from '../../methods/index.js';
import { createChart } from './chart.js';
import { demoPanel } from './demo-panel.js';
import { unlockAudio } from './audio.js';

const ESPRESSO_PHASES = [
  { id: 'waiting', label: 'Waiting' }, { id: 'first-drops', label: 'First drops' },
  { id: 'main-flow', label: 'Main flow' }, { id: 'finishing', label: 'Finishing' },
];
const READY_TEXT = {
  espresso: (auto) => (auto ? 'Ready. Start the pump; the timer starts by itself at the first drops' : 'Ready. Tap Start with the pump'),
  pour: (auto, F) => `Ready. Start pouring the bloom${F.firstTarget ? ` to ${fmtG(F.firstTarget)} g` : ''}`,
  immersion: () => 'Ready. Pour in the water',
  moka: () => 'Ready. Put it on the heat, then tap Start',
};
const CUE_SHOW_MS = 9000;

// paint() runs about 10x a second. Writing the same value to the DOM still costs style work, so only write what changed.
const setText = (el, text) => {
  const n = el.firstChild;
  if (n && n.nodeType === 3 && !n.nextSibling) { if (n.data !== text) n.data = text; } else if (el.textContent !== text) el.textContent = text; // edit the text node in place
};
const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden; };
const setData = (el, key, value) => { if (el.dataset[key] !== value) el.dataset[key] = value; };

export function renderLive(host, F) {
  const { ctx, method, run } = F;
  const { scale } = ctx;
  const kind = method.kind;
  const steps = kind === 'espresso' ? [] : stepsFor(F.recipe, method);
  F.firstTarget = steps.find((s) => Number.isFinite(s.targetG))?.targetG;
  const isPour = kind === 'pour';

  const cue = h('p', { class: 'live-cue', 'aria-live': 'assertive', 'data-testid': 'live-cue' });
  const weightNum = h('span', {});
  const weight = h('div', { class: 'live-weight num', 'data-testid': 'live-weight' }, weightNum, h('small', {}, 'g'));
  const timer = h('b', { class: 'num', 'data-testid': 'live-timer' }, '0:00');
  const flow = h('b', { class: 'num' }, '0.0');
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progress to target', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i'));
  const progressText = h('p', { class: 'progress-text' });
  const phases = kind === 'espresso' ? h('ol', { class: 'phases', 'aria-label': 'Shot phases' }, ESPRESSO_PHASES.map((p) => h('li', { dataset: { phase: p.id } }, p.label))) : null;
  const stepName = h('p', { class: 'step-name' });
  const stepBig = h('div', { class: 'step-big num' });
  const stepSub = h('p', { class: 'step-sub muted' });
  const stepCard = kind === 'espresso' ? null : h('div', { class: 'step-card' }, stepName, stepBig, stepSub);
  const chart = createChart({ label: 'Live weight and flow' });
  const warn = h('p', { class: 'live-warn', role: 'status', hidden: true }, 'The scale is disconnected. Reconnecting…');

  const primary = h('button', { class: 'btn primary big', type: 'button', 'data-testid': 'live-primary' });
  const tare = h('button', { class: 'btn big', type: 'button', onclick: () => { unlockAudio(); scale.tare(); run.dispatch({ type: 'tare' }); } }, 'Tare');
  const finish = h('button', { class: 'btn big', type: 'button', 'data-testid': 'live-finish', onclick: () => run.dispatch({ type: 'finish' }) }, 'Done');
  const cancel = h('button', { class: 'btn quiet', type: 'button', 'data-testid': 'live-cancel', onclick: async () => {
    if (run.state.phase === 'running' && !(await confirmDialog({ title: 'Cancel this brew?', message: 'Nothing will be saved.', confirmLabel: 'Cancel brew', danger: true }))) return;
    if (F.stage === 'live' && run.state.phase !== 'done') F.cancel(); // the shot may have finished while the dialog was open
  } }, 'Cancel');
  const demo = demoPanel(F);

  let shownCue = null;
  const showCue = (text, ms = CUE_SHOW_MS) => { shownCue = { text, until: performance.now() + ms }; };
  let hitTimer = null;
  const hit = () => {
    host.dataset.hit = '';
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => delete host.dataset.hit, 1600);
  };

  const statusText = (s) => {
    if (s.phase === 'ready') return READY_TEXT[kind](s.settings.autoStart, F);
    if (kind === 'espresso') {
      const e = s.espresso;
      return { waiting: 'Waiting for the first drops', 'first-drops': 'First drops', 'main-flow': 'Main flow', finishing: 'Stop the pump' }[e?.phase] ?? 'Running';
    }
    return s.brew?.step?.label ?? 'Running';
  };

  let lastP = -1, primaryMode = null;
  const paint = (out) => {
    const s = run.state;
    if (out) for (const c of out.cues) {
      if (c.id === 'espresso:stop') { showCue(c.text, 60000); hit(); } else if (/^step:\d+:reached$/.test(c.id)) { showCue(c.text); hit(); } else if (c.id !== 'done') showCue(c.text);
    }
    if (s.phase === 'done') return F.go('result');
    const running = s.phase === 'running';
    setData(host, 'phase', s.phase);
    setText(weightNum, s.grams.toFixed(1));
    setText(timer, fmtTime(running ? s.elapsedS : 0));
    setText(flow, s.flow.toFixed(1));
    // the cue shows for a while, then the plain status takes over again
    const live = shownCue && performance.now() < shownCue.until && !(s.phase === 'ready');
    const cueText = live ? shownCue.text : statusText(s);
    if (cue.textContent !== cueText) cue.textContent = cueText; // replace the node (not edit it): screen readers announce that reliably
    setData(cue, 'tone', live && s.espresso?.stopCueSent ? 'stop' : '');
    // progress toward the target
    const target = kind === 'espresso' ? s.targetYield : s.brew?.targetG ?? F.firstTarget ?? null;
    const p = Math.round((target ? Math.min(1, Math.max(0, s.grams / target)) : s.progress) * 100);
    if (p !== lastP) { lastP = p; progress.firstChild.style.setProperty('--p', String(p / 100)); progress.setAttribute('aria-valuenow', String(p)); }
    setText(progressText, target ? `${s.grams.toFixed(1)} of ${fmtG(target, target < 100 ? 1 : 0)} g${s.grams < target ? ` · ${Math.max(0, target - s.grams).toFixed(1)} g to go` : ''}` : kind === 'moka' ? 'Dose and water are logged; now the heat' : '');
    if (phases) for (const li of phases.children) {
      const i = ESPRESSO_PHASES.findIndex((x) => x.id === li.dataset.phase);
      const cur = ESPRESSO_PHASES.findIndex((x) => x.id === s.espresso?.phase);
      setData(li, 'state', !running || cur < 0 ? 'todo' : i < cur ? 'done' : i === cur ? 'now' : 'todo');
      if (li.dataset.state === 'now') { if (!li.hasAttribute('aria-current')) li.setAttribute('aria-current', 'step'); } else if (li.hasAttribute('aria-current')) li.removeAttribute('aria-current');
    }
    if (stepCard) paintStep(s, running);
    // buttons
    setHidden(finish, !running); setHidden(tare, running);
    const mode = s.phase === 'ready' ? 'start' : kind === 'espresso' ? 'pump' : 'none';
    if (mode !== primaryMode) { // label and handler only change when the mode does
      primaryMode = mode;
      setHidden(primary, mode === 'none');
      if (mode === 'start') { primary.textContent = kind === 'espresso' ? 'Start timer (pump on)' : 'Start timer'; primary.onclick = () => { unlockAudio(); run.dispatch({ type: 'start' }); }; primary.disabled = false; }
      else if (mode === 'pump') { primary.textContent = 'I stopped the pump'; primary.onclick = () => run.dispatch({ type: 'pumpOff' }); primary.disabled = false; }
    }
    if (running) chart.set({ points: run.points, targetG: kind === 'espresso' ? s.targetYield : steps.at(-1) && lastTarget(steps), tEnd: kind === 'espresso' ? 35 : s.brew?.planEndS, steps: kind === 'espresso' ? null : steps });
  };
  const lastTarget = (list) => [...list].reverse().find((x) => Number.isFinite(x.targetG))?.targetG;

  function paintStep(s, running) {
    const b = s.brew;
    if (!b) return;
    if (!running) {
      stepName.textContent = kind === 'moka' ? 'Heat' : isPour ? 'First pour' : 'Plan';
      stepBig.textContent = isPour && b.targetG != null ? `${fmtG(b.targetG)} g` : kind === 'moka' ? '' : fmtTime(b.planEndS);
      stepSub.textContent = steps[0]?.label ?? '';
      return;
    }
    setText(stepName, `Step ${b.index + 1} of ${b.count}`);
    const wantsWeight = isPour && b.targetG != null && !b.reached;
    setText(stepBig, wantsWeight ? `${b.remainingG.toFixed(0)} g to go` : b.countdownS != null ? fmtTime(Math.ceil(b.countdownS)) : '');
    setText(stepSub, [b.step?.label, b.nextCue ? `Next in ${fmtTime(Math.ceil(b.nextCue.inS))}: ${b.nextCue.label}` : null].filter(Boolean).join(' · '));
    setData(stepCard, 'kind', b.step?.kind ?? '');
  }

  const connection = () => { warn.hidden = run.connected; };
  const offs = [run.on('update', paint), run.on('connection', connection)];
  const tick = setInterval(() => paint(), 500); // keeps cues expiring and the timer ticking if samples stop arriving
  const tabsOff = (() => { const sh = document.getElementById('shell'); const prev = sh?.dataset.chrome; if (sh) sh.dataset.chrome = 'none'; return () => { if (sh) sh.dataset.chrome = prev ?? 'tabs'; }; })();

  append(host, [
    h('div', { class: 'live-top' }, h('span', { class: 'live-method' }, icon(method.icon, { size: 20 }), method.name), cancel),
    warn, cue,
    h('div', { class: 'live-main' },
      weight,
      h('div', { class: 'live-stats' }, h('span', {}, timer, h('small', {}, 'time')), h('span', {}, flow, h('small', {}, 'g/s')))),
    progress, progressText, phases, stepCard,
    h('div', { class: 'chart-wrap' }, chart.el),
    h('div', { class: 'live-actions' }, primary, tare, finish),
    demo.el]);
  paint();
  return () => { offs.forEach((o) => o()); clearInterval(tick); clearTimeout(hitTimer); chart.destroy(); demo.destroy(); tabsOff(); };
}
