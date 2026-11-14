// A fake Timemore Dot that speaks the REAL protocol: it parses the command frames the app writes and answers with
// frames built by protocol.js, split into chunks to exercise the parser's reassembly.
// Teach it here whenever you add a protocol feature (CLAUDE.md rule).
//
// Demo-only controls (not part of the real transport): setScenario(), place(g), remove(), startFlow().
import { OP, CMD, TIMER, frame } from '../../protocol.js';

const enc = (s) => [...new TextEncoder().encode(s)];

// Flow (g/s) as a function of seconds since the pour started. Rough shapes, good enough to drive the UI.
export const SCENARIOS = {
  // bloom, two pours, drawdown (the old demo)
  'pour-over': (t) => (t < 5 ? 6 : t < 35 ? 0.3 : t < 60 ? 4.5 : t < 75 ? 0.5 : t < 110 ? 3.8 : 0),
  // EC260 on a 16 g dose: ~7 s to first drops, ~1.2 g/s main flow, tail-off after ~27 s
  espresso: (t) => (t < 7 ? 0 : t < 9 ? 0.5 : t < 27 ? 1.25 : t < 30 ? 0.4 : 0.05),
};

export function createDemoTransport(onBytes, { tickMs = 100, scenario = 'pour-over' } = {}) {
  const sim = { grams: 0, tareOffset: 0, timer: 0, running: false, pumping: false, ms: 0, flowMs: 0, scenario, prev: 0 };
  const timeouts = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms); timeouts.add(id); };

  const emit = (op, cmd, payload) => {
    const f = frame(op, cmd, payload);
    f[f.length - 2] = 0; f[f.length - 1] = 0; // the real scale sends 00 00 instead of a CRC
    onBytes(f.slice(0, 5)); onBytes(f.slice(5));
  };

  const tick = setInterval(() => {
    if (sim.running) { sim.ms += tickMs; sim.timer = Math.floor(sim.ms / 1000); }
    if (sim.pumping) {
      sim.flowMs += tickMs;
      const flow = (SCENARIOS[sim.scenario] ?? SCENARIOS['pour-over'])(sim.flowMs / 1000);
      sim.grams += (flow * tickMs) / 1000 + (Math.random() - 0.5) * 0.04;
    }
    const net = sim.grams - sim.tareOffset;
    const flow = ((net - sim.prev) * 1000) / tickMs;
    sim.prev = net;
    const w = Math.round(net * 10), f = Math.round(Math.max(0, flow) * 10);
    emit(OP.NOTIFY, CMD.WEIGHT, [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (f >> 8) & 255, f & 255, (sim.timer >> 8) & 255, sim.timer & 255, 0]);
  }, tickMs);

  return {
    kind: 'demo',
    deviceName: 'DEMO DOT',
    info: { model: 'Simulated TES017', maker: 'Dot Scale' },

    /** Receives a command frame exactly as BLE would. */
    async write(b) {
      const op = b[2], cmd = b[3], p = b.slice(6, b.length - 2);
      if (op === OP.WRITE) {
        if (cmd === CMD.TARE) sim.tareOffset = sim.grams;
        if (cmd === CMD.TIMER) {
          if (p[0] === TIMER.START) { sim.running = true; sim.pumping = true; }
          if (p[0] === TIMER.PAUSE) { sim.running = false; sim.pumping = false; }
          if (p[0] === TIMER.RESET) { sim.running = false; sim.pumping = false; sim.timer = 0; sim.ms = 0; sim.flowMs = 0; }
          later(() => emit(OP.NOTIFY, CMD.TIMER, [p[0]]), 50);
        }
        later(() => emit(OP.WRITE, cmd, [1]), 30);
      } else if (op === OP.READ) {
        if (cmd === CMD.BATTERY) later(() => emit(OP.READ, CMD.BATTERY, [3, 78]), 30);
        if (cmd === CMD.FIRMWARE) later(() => emit(OP.READ, CMD.FIRMWARE, enc('v1.0.4')), 30);
        if (cmd === CMD.NAME) later(() => emit(OP.READ, CMD.NAME, enc('DEMO DOT')), 30);
      }
    },

    async readInfo() { return this.info; },
    disconnect() { clearInterval(tick); for (const id of timeouts) clearTimeout(id); timeouts.clear(); },

    // ---- demo-only ----
    setScenario(name) { if (SCENARIOS[name]) sim.scenario = name; },
    /** Put something on the scale (beans, portafilter, cup): a sudden weight step, no flow. */
    place(g) { sim.grams += g; },
    remove() { sim.grams = sim.tareOffset; },
    /** Start the flow without the scale timer, like pressing the pump: lets auto-start logic be tested. */
    startFlow() { sim.pumping = true; },
    get sim() { return sim; },
  };
}
