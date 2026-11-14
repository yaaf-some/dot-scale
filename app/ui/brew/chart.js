// Weight + flow curve on a <canvas>. Used live (points appended 10x per second) and on the Result screen.
// Colours come from the design tokens (read at draw time, so the theme can change); nothing is hard-coded.
//
//   const chart = createChart({ label: 'Brew curve' });   chart.el is the <canvas>
//   chart.set({ points: [{ t, g, f }], targetG, tEnd, steps: [{ atS, targetG }] })   // draws (throttled to a frame)
//   points: seconds on the brew timer, grams, flow g/s.
import { h } from '../dom.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const niceMax = (v, steps) => { for (const s of steps) if (v <= s) return s; return Math.ceil(v / 100) * 100; };

/** Pure: the scales and paths for the data, so tests don't need a canvas. Returns null with fewer than 2 points. */
export function layout(points, { targetG, tEnd, w, hgt, pad = { l: 8, r: 8, t: 8, b: 22 } } = {}) {
  if (!points || points.length < 2) return null;
  const t1 = Math.max(tEnd ?? 0, points[points.length - 1].t, 10);
  const t0 = Math.min(0, points[0].t);
  const gMax = niceMax(Math.max(targetG ?? 0, ...points.map((p) => p.g), 1) * 1.08, [10, 20, 40, 60, 100, 150, 250, 400, 600, 1000]);
  const fMax = niceMax(Math.max(...points.map((p) => p.f), 0.5) * 1.15, [1, 2, 3, 5, 8, 12, 20, 40]);
  const iw = w - pad.l - pad.r, ih = hgt - pad.t - pad.b;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * iw;
  const yG = (g) => pad.t + ih - (Math.max(0, g) / gMax) * ih;
  const yF = (f) => pad.t + ih - (Math.max(0, f) / fMax) * ih * 0.6; // flow uses the lower 60 % so the two lines don't tangle
  return { x, yG, yF, t0, t1, gMax, fMax, pad, iw, ih };
}

export function createChart({ label = 'Weight and flow over time', height } = {}) {
  const canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': label });
  if (height) canvas.style.height = `${height}px`;
  let data = { points: [] };
  let queued = false;

  function draw() {
    queued = false;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const ink = css('--ink', '#222'), soft = css('--ink-faint', '#777'), line = css('--line', '#ccc');
    const cobalt = css('--cobalt', '#2342b5'), crema = css('--crema', '#e3a63b');
    const L = layout(data.points, { targetG: data.targetG, tEnd: data.tEnd, w, hgt });
    g.font = `12px ${css('--font-ui', 'system-ui')}`;
    if (!L) { g.fillStyle = soft; g.fillText('The curve appears when the timer starts', 10, hgt / 2); return; }
    const { x, yG, yF, pad } = L;
    // baseline + time ticks
    g.strokeStyle = line; g.lineWidth = 1; g.beginPath(); g.moveTo(pad.l, hgt - pad.b + 0.5); g.lineTo(w - pad.r, hgt - pad.b + 0.5); g.stroke();
    g.fillStyle = soft; g.textAlign = 'center';
    const stepS = L.t1 > 240 ? 60 : L.t1 > 90 ? 30 : L.t1 > 40 ? 10 : 5;
    for (let t = 0; t <= L.t1; t += stepS) g.fillText(`${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`, Math.min(w - 14, Math.max(14, x(t))), hgt - 6);
    // planned step targets (pour-over): faint steps
    if (data.steps?.length) {
      g.strokeStyle = line; g.setLineDash([2, 4]);
      for (const s of data.steps) if (Number.isFinite(s.targetG)) { g.beginPath(); g.moveTo(x(s.atS), yG(s.targetG)); g.lineTo(w - pad.r, yG(s.targetG)); g.stroke(); }
      g.setLineDash([]);
    }
    // target line
    if (Number.isFinite(data.targetG)) {
      g.strokeStyle = crema; g.lineWidth = 2; g.setLineDash([6, 5]);
      g.beginPath(); g.moveTo(pad.l, yG(data.targetG)); g.lineTo(w - pad.r, yG(data.targetG)); g.stroke(); g.setLineDash([]);
      g.fillStyle = css('--crema-ink', crema); g.textAlign = 'left'; g.fillText(`${Math.round(data.targetG)} g`, pad.l + 2, yG(data.targetG) - 5);
    }
    // flow (thin), then weight (bold)
    const path = (fy, key) => { g.beginPath(); data.points.forEach((p, i) => (i ? g.lineTo(x(p.t), fy(p[key])) : g.moveTo(x(p.t), fy(p[key])))); g.stroke(); };
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = soft; g.lineWidth = 1.5; path(yF, 'f');
    g.strokeStyle = cobalt; g.lineWidth = 3; path(yG, 'g');
    const last = data.points[data.points.length - 1];
    g.fillStyle = cobalt; g.beginPath(); g.arc(x(last.t), yG(last.g), 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink;
  }

  const schedule = () => { if (queued) return; queued = true; (globalThis.requestAnimationFrame ?? setTimeout)(draw); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  ro?.observe(canvas);
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', schedule);

  return {
    el: canvas,
    set(next) { data = { ...data, ...next }; schedule(); },
    destroy() { ro?.disconnect(); mq?.removeEventListener?.('change', schedule); },
  };
}

/** Brew record samples → chart points. */
export function pointsFromSamples(samples) {
  const w = samples?.channels?.weight, f = samples?.channels?.flow;
  if (!w?.length) return [];
  const hz = samples.hz || 10, t0 = samples.t0 || 0;
  return w.map((g, i) => ({ t: t0 + i / hz, g, f: f?.[i] ?? 0 }));
}
