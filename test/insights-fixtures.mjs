// Synthetic brew generators for insights tests. Deterministic (seeded noise).

export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Espresso shot. flowAt(tSinceFirstDrop) -> g/s while the pump runs. The pump stops when `stopAtG` is reached;
// then `dripG` more grams drain with a short tail (samples continue for `tailS`).
export function espressoShot({
  dose = 16, firstDropS = 7, stopAtG = 32, dripG = 1.5, tailS = 3, hz = 10, seed = 1,
  flowAt = (t) => 1.2 * Math.min(1, t / 3) * (1 + 0.004 * t * 4), noise = 0.05, spikes = [], extra = {},
} = {}) {
  const rand = rng(seed);
  const w = [];
  const f = [];
  let weight = 0;
  let t = 0;
  let stopT = null;
  const dt = 1 / hz;
  while (true) {
    let flow = 0;
    if (stopT == null) {
      if (t >= firstDropS) {
        flow = flowAt(t - firstDropS);
        for (const s of spikes) if (t >= s.at && t < s.at + s.len) flow += s.add;
      }
      if (weight >= stopAtG) stopT = t;
    }
    if (stopT != null) {
      const k = (t - stopT) / tailS;
      flow = k >= 1 ? 0 : (dripG / tailS) * 2 * (1 - k); // triangular tail integrating to dripG
      if (k >= 1) break;
    }
    weight += flow * dt;
    w.push(Math.round(weight * 10) / 10);
    f.push(Math.max(0, Math.round((flow + (rand() - 0.5) * 2 * noise * (flow > 0 ? 1 : 0)) * 100) / 100));
    t += dt;
    if (t > 120) break;
  }
  const finalW = w[w.length - 1];
  return {
    id: `b${seed}`, type: 'brew', method: 'espresso', dose, yield: finalW, targetYield: 32, timeS: Math.round(stopT * 10) / 10,
    gear: { portafilter: 'naked', basketG: 16 },
    samples: { hz, t0: 0, channels: { weight: w, flow: f, ...extra } },
  };
}

export const goodShot = (o = {}) => espressoShot({ firstDropS: 8, stopAtG: 30.5, dripG: 1.5, flowAt: (t) => 1.55 * Math.min(1, t / 4) * (1 + 0.1 * (t / 20)), ...o });
// ~16 s to 32 g with first drops at 4 s
export const fastShot = (o = {}) => espressoShot({ firstDropS: 4, stopAtG: 34.5, dripG: 1.5, flowAt: (t) => 2.6 * Math.min(1, t / 2), ...o });
export const gusherShot = (o = {}) => espressoShot({ firstDropS: 2, stopAtG: 40, dripG: 2, flowAt: (t) => 4 * Math.min(1, t / 1), ...o });
export const slowShot = (o = {}) => espressoShot({ firstDropS: 12, stopAtG: 31, dripG: 1, flowAt: (t) => 0.78 * Math.min(1, t / 5), ...o });
export const channelingShot = (o = {}) =>
  espressoShot({
    firstDropS: 8, stopAtG: 30.5, dripG: 1.5, flowAt: (t) => 1.5 * Math.min(1, t / 4),
    spikes: [{ at: 20, len: 1.4, add: 3.4 }, { at: 25, len: 1, add: 2.8 }], ...o,
  });

// Generic: pour-over / immersion timeline of [startS, endS, gramsAdded] pours.
export function pourTimeline({ method = 'pour-over', dose = 15, pours, totalS, hz = 10, seed = 3, extra = {} }) {
  const rand = rng(seed);
  const n = Math.round(totalS * hz) + 1;
  const w = new Array(n).fill(0);
  const f = new Array(n).fill(0);
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    let flow = 0;
    for (const [a, b, g] of pours) if (t >= a && t < b) flow = g / (b - a);
    weight += flow / hz;
    w[i] = Math.round(weight * 10) / 10;
    f[i] = Math.max(0, Math.round((flow + (rand() - 0.5) * 0.1) * 100) / 100);
  }
  return { id: `p${seed}`, type: 'brew', method, dose, yield: w[n - 1], timeS: totalS, samples: { hz, t0: 0, channels: { weight: w, flow: f, ...extra } } };
}
