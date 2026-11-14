// Curves on canvas (detail + compare) and the little SVG sparkline for list rows. Colours come from the CSS tokens, so
// light/dark and any future theme just work; the chart repaints on resize and when the theme changes.
import { sparkPath } from '../../journal/history.js';

const NS = 'http://www.w3.org/2000/svg';

export function sparkline(brew) {
  const d = sparkPath(brew, { w: 72, h: 24 });
  const span = document.createElement('span');
  if (!d) { span.className = 'spark none'; span.textContent = '–'; span.setAttribute('aria-label', 'No curve'); return span; }
  span.className = 'spark';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 72 24', width: 72, height: 24, 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  span.append(svg);
  return span;
}

/** A "nice" tick step so an axis has about `want` ticks. */
export function niceStep(range, want = 5) {
  if (!(range > 0)) return 1;
  const raw = range / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * series: [{ curve, channel: 'weight'|'flow', color: 'cobalt'|'crema', dash?: boolean, width?: number, axis?: 'left'|'right' }]
 * opts:   { target?: grams (dashed line on the weight axis), stopS?: seconds (vertical tick), signal }
 * Returns a <canvas>; call .redraw() to repaint.
 */
export function curveCanvas(series, { target, stopS, label, signal } = {}) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  if (label) canvas.setAttribute('aria-label', label);
  const draw = () => {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const colors = { cobalt: css('--cobalt', '#2342b5'), crema: css('--crema', '#e3a63b') };
    const ink = css('--ink-soft', '#46534d'), line = css('--line', '#c9cfc8');
    const hasRight = series.some((s) => s.axis === 'right');
    const m = { l: 40, r: hasRight ? 40 : 12, t: 14, b: 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const tOf = (s, i) => s.curve.t0 + i / s.curve.hz;
    const tMin = Math.min(0, ...series.map((s) => s.curve.t0));
    const tMax = Math.max(1, ...series.map((s) => tOf(s, s.curve.weight.length - 1)), stopS ?? 0);
    const maxOf = (axis) => Math.max(axis === 'left' ? (target ?? 0) * 1.05 : 0.5, ...series.filter((s) => (s.axis ?? 'left') === axis).map((s) => Math.max(...s.curve[s.channel])));
    const yMax = { left: maxOf('left'), right: maxOf('right') };
    const stepY = { left: niceStep(yMax.left), right: niceStep(yMax.right, 4) };
    const top = { left: Math.ceil(yMax.left / stepY.left) * stepY.left, right: Math.ceil(yMax.right / stepY.right) * stepY.right };
    const X = (t) => m.l + ((t - tMin) / (tMax - tMin)) * pw;
    const Y = (v, axis) => m.t + ph - (v / top[axis]) * ph;

    g.font = `12px ${css('--font-ui', 'system-ui, sans-serif')}`;
    g.lineWidth = 1; g.strokeStyle = line; g.fillStyle = ink;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let v = 0; v <= top.left + 1e-9; v += stepY.left) {
      const y = Math.round(Y(v, 'left')) + 0.5;
      g.beginPath(); g.moveTo(m.l, y); g.lineTo(W - m.r, y); g.stroke();
      g.fillText(String(Math.round(v * 10) / 10), m.l - 6, y);
    }
    if (hasRight) {
      g.textAlign = 'left';
      for (let v = 0; v <= top.right + 1e-9; v += stepY.right) g.fillText(String(Math.round(v * 10) / 10), W - m.r + 6, Y(v, 'right'));
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const stepT = niceStep(tMax - tMin, Math.max(3, Math.floor(pw / 70)));
    for (let t = Math.ceil(tMin / stepT) * stepT; t <= tMax + 1e-9; t += stepT) g.fillText(t >= 100 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`, X(t), H - m.b + 6);

    if (target > 0) {
      g.save(); g.setLineDash([2, 4]); g.strokeStyle = ink; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(m.l, Y(target, 'left')); g.lineTo(W - m.r, Y(target, 'left')); g.stroke(); g.restore();
    }
    if (stopS > 0) { g.save(); g.setLineDash([2, 4]); g.strokeStyle = ink; g.beginPath(); g.moveTo(X(stopS), m.t); g.lineTo(X(stopS), m.t + ph); g.stroke(); g.restore(); }

    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const s of series) {
      const axis = s.axis ?? 'left';
      g.save();
      g.beginPath();
      s.curve[s.channel].forEach((v, i) => (i ? g.lineTo(X(tOf(s, i)), Y(v, axis)) : g.moveTo(X(tOf(s, i)), Y(v, axis))));
      g.strokeStyle = colors[s.color] ?? ink; g.lineWidth = s.width ?? 2.5;
      if (s.dash) g.setLineDash([7, 5]);
      g.stroke(); g.restore();
    }
  };
  canvas.redraw = draw;
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    signal?.addEventListener('abort', () => ro.disconnect(), { once: true });
  } else { addEventListener('resize', draw, { signal }); requestAnimationFrame(draw); }
  // Theme: the OS scheme, or the app's own override on <html data-theme>.
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', draw, { signal });
  const mo = new MutationObserver(draw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  signal?.addEventListener('abort', () => mo.disconnect(), { once: true });
  return canvas;
}
