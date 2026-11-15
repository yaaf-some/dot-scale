import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScale, uuid16, REQUESTS, isRequestProblem } from '../app/core/scale.js';
import { createDemoTransport, SCENARIOS } from '../app/core/demo-scale.js';
import { Parser, commands, hex } from '../protocol.js';

const instant = () => Promise.resolve();
const until = async (pred, ms = 3000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

test('demo transport answers commands with real protocol frames', async () => {
  const parser = new Parser();
  const msgs = [];
  const demo = createDemoTransport((b) => msgs.push(...parser.push(b)), { tickMs: 20 });
  await demo.write(commands.readBattery());
  await demo.write(commands.readFirmware());
  await demo.write(commands.readName());
  await until(() => ['battery', 'firmware', 'name'].every((t) => msgs.some((m) => m.type === t)));
  assert.equal(msgs.find((m) => m.type === 'battery').percent, 78);
  assert.equal(msgs.find((m) => m.type === 'firmware').version, 'v1.0.4');
  assert.equal(msgs.find((m) => m.type === 'name').name, 'DEMO DOT');
  assert.ok(msgs.some((m) => m.type === 'weight'), 'streams weight frames');
  demo.disconnect();
});

test('scale over demo: connect, tare, timer, weight events, disconnect', async () => {
  const scale = createScale({ bluetooth: undefined, sleep: instant });
  assert.equal(scale.supported, false);
  const statuses = [], weights = [];
  scale.on('status', (s) => statuses.push(s.status));
  scale.on('weight', (w) => weights.push(w));
  await scale.startDemo('pour-over');
  assert.equal(scale.connected, true);
  assert.equal(scale.state.mode, 'demo');
  await until(() => scale.state.battery === 78);
  assert.ok(scale.demo);
  scale.demo.place(20);
  await until(() => scale.state.grams > 19);
  await scale.tare();
  await until(() => Math.abs(scale.state.grams) < 0.5);
  const timerEvents = [];
  scale.on('timer', (t) => timerEvents.push(t.running));
  await scale.timer.start();
  await until(() => scale.state.grams > 0.5 && scale.state.seconds >= 1, 4000);
  assert.equal(scale.state.timerRunning, true);
  await scale.timer.reset();
  assert.equal(scale.state.timerRunning, false);
  assert.deepEqual(timerEvents.slice(0, 2), [true, false]);
  await scale.disconnect();
  assert.equal(scale.state.status, 'disconnected');
  assert.equal(scale.state.grams, 0);
  assert.equal(scale.demo, null);
  assert.deepEqual([statuses[0], statuses.at(-1)], ['connected', 'disconnected']);
  assert.ok(weights.length > 5);
  assert.ok(scale.logLines.some((l) => l.text.includes('unit = grams')), 'init sequence is logged');
});

test('scale.sendRaw adds header and CRC; log keeps at most logLimit lines', async () => {
  const scale = createScale({ bluetooth: undefined, sleep: instant, logLimit: 5 });
  await scale.startDemo();
  await scale.sendRaw([0x02, 0x05]);
  const raw = scale.logLines.find((l) => l.text.includes('(raw)'));
  assert.ok(raw && raw.text.includes(hex(commands.readBattery())));
  for (let i = 0; i < 20; i++) await scale.tare();
  assert.equal(scale.logLines.length, 5);
  await scale.disconnect();
});

test('connect() without Web Bluetooth throws a clear error; autoConnect() is a quiet false', async () => {
  const scale = createScale({ bluetooth: undefined, sleep: instant });
  await assert.rejects(scale.connect(), /no Web Bluetooth/);
  assert.equal(await scale.autoConnect(), false);
});

test('espresso scenario: nothing for 7 s, then flow ~1.25 g/s', () => {
  assert.equal(SCENARIOS.espresso(3), 0);
  assert.equal(SCENARIOS.espresso(15), 1.25);
});

// A strict stand-in for Web Bluetooth. Like Bluefy (iOS), it refuses bare-number UUIDs; `requestError(options, n)` lets a test make
// the chooser request itself fail (n counts calls from 1).
function fakeBluetooth({ failFirst = 0, requestError = null } = {}) {
  let notifyHandler, connects = 0;
  const requests = [];
  const mustBeString = (u) => { if (typeof u !== 'string') throw new TypeError(`UUID must be a string, got ${typeof u}`); };
  const device = {
    id: 'dev-1', name: 'TIMEMORE DOT', listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    gatt: {
      async connect() {
        if (connects++ < failFirst) throw new Error('out of range');
        const chars = {
          [uuid16(0xfff1)]: { addEventListener: (_, fn) => { notifyHandler = fn; }, startNotifications: async () => {} },
          [uuid16(0xfff2)]: { writeValueWithoutResponse: async () => {} },
        };
        return { getPrimaryService: async (s) => { mustBeString(s); return { getCharacteristic: async (u) => { mustBeString(u); return chars[u]; } }; } };
      },
      disconnect() { device.listeners.gattserverdisconnected?.(); },
    },
  };
  const requestDevice = async (options) => {
    requests.push(options);
    const err = requestError?.(options, requests.length);
    if (err) throw err;
    return device;
  };
  return { device, requests, get connects() { return connects; }, bluetooth: { requestDevice, getDevices: async () => [device] }, notify: (bytes) => notifyHandler({ target: { value: new DataView(bytes.buffer) } }) };
}

test('BLE: connect remembers the known scale, then auto-reconnects after a drop', async () => {
  const fb = fakeBluetooth();
  const saved = {};
  const prefs = { get: (k, d) => saved[k] ?? d, set: (k, v) => { saved[k] = v; } };
  const scale = createScale({ bluetooth: fb.bluetooth, prefs, sleep: instant });
  await scale.connect();
  assert.equal(scale.state.status, 'connected');
  assert.equal(scale.state.mode, 'ble');
  assert.deepEqual(saved.knownScale, { id: 'dev-1', name: 'TIMEMORE DOT' });
  const statuses = [];
  scale.on('status', (s) => statuses.push(s.status));
  fb.device.listeners.gattserverdisconnected(); // link loss, not user initiated
  await until(() => scale.state.status === 'connected');
  assert.ok(statuses.includes('reconnecting'));
  assert.equal(fb.connects, 2);
  await scale.disconnect();
  assert.equal(scale.state.status, 'disconnected');
  fb.device.listeners.gattserverdisconnected(); // echo from our own disconnect must not trigger retries
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fb.connects, 2);
});

test('BLE: reconnect gives up after the retry budget', async () => {
  const fb = fakeBluetooth();
  const scale = createScale({ bluetooth: fb.bluetooth, sleep: instant });
  await scale.connect();
  fb.device.gatt.connect = async () => { throw new Error('gone'); };
  fb.device.listeners.gattserverdisconnected();
  await until(() => scale.state.status === 'disconnected' && scale.state.text === 'Disconnected');
});

test('BLE: autoConnect uses getDevices() and the remembered id', async () => {
  const fb = fakeBluetooth();
  const prefs = { get: (k) => (k === 'knownScale' ? { id: 'dev-1' } : undefined), set() {} };
  const scale = createScale({ bluetooth: fb.bluetooth, prefs, sleep: instant });
  assert.equal(await scale.autoConnect(), true);
  assert.equal(scale.state.status, 'connected');
  await scale.disconnect();
  const other = createScale({ bluetooth: fb.bluetooth, prefs: { get: () => ({ id: 'someone-else' }), set() {} }, sleep: instant });
  assert.equal(await other.autoConnect(), false);
});

test('BLE: parser reassembles frames notified in pieces', async () => {
  const fb = fakeBluetooth();
  const scale = createScale({ bluetooth: fb.bluetooth, sleep: instant });
  await scale.connect();
  const got = [];
  scale.on('weight', (w) => got.push(w.grams));
  const p = [0, 0, 1, 0x2c, 0, 5, 0, 3, 0]; // 30.0 g
  const { frame } = await import('../protocol.js');
  const f = frame(1, 1, p); f[f.length - 2] = 0; f[f.length - 1] = 0;
  fb.notify(f.slice(0, 4)); fb.notify(f.slice(4));
  assert.deepEqual(got, [30]);
  await scale.disconnect();
});

test('BLE: autoConnect does not reconnect after a deliberate disconnect', async () => {
  const fb = fakeBluetooth();
  const prefs = { get: (k) => (k === 'knownScale' ? { id: 'dev-1' } : undefined), set() {} };
  const scale = createScale({ bluetooth: fb.bluetooth, prefs, sleep: instant });
  await scale.connect();
  await scale.disconnect();
  assert.equal(await scale.autoConnect(), false);
  assert.equal(scale.state.status, 'disconnected');
});

// ---- Bluefy (iOS): "Request payload could not be parsed" --------------------------------------------------------------
const payloadError = () => new Error('(11) RequestDevice: Request payload could not be parsed.');
const memoryPrefs = () => { const saved = {}; return { saved, get: (k, d) => saved[k] ?? d, set: (k, v) => { saved[k] = v; } }; };

test('uuid16 builds the canonical 128-bit string', () => {
  assert.equal(uuid16(0xfff0), '0000fff0-0000-1000-8000-00805f9b34fb');
  assert.equal(uuid16(0x2a24), '00002a24-0000-1000-8000-00805f9b34fb');
});

test('BLE: every UUID sent to the browser is a canonical string, never a bare number', async () => {
  const fb = fakeBluetooth();
  const scale = createScale({ bluetooth: fb.bluetooth, prefs: memoryPrefs(), sleep: instant });
  await scale.connect();
  assert.equal(scale.state.status, 'connected'); // the strict fake would throw on a numeric GATT UUID
  const uuids = fb.requests.flatMap((o) => [...(o.optionalServices ?? []), ...(o.filters ?? []).flatMap((f) => f.services ?? [])]);
  assert.ok(uuids.length >= 3);
  for (const u of uuids) assert.match(u, /^[0-9a-f]{8}-0000-1000-8000-00805f9b34fb$/);
});

test('BLE: a chooser request the browser cannot parse falls back to simpler ones, and the one that works is remembered', async () => {
  const prefs = memoryPrefs();
  const fb = fakeBluetooth({ requestError: (_, n) => (n <= 2 ? payloadError() : null) }); // rejects "full" and "service"
  const scale = createScale({ bluetooth: fb.bluetooth, prefs, sleep: instant });
  await scale.connect();
  assert.equal(scale.state.status, 'connected');
  assert.equal(fb.requests.length, 3);
  assert.deepEqual(fb.requests[2].filters, REQUESTS[2].options.filters, 'third attempt is the name-only request');
  assert.equal(prefs.saved.bleRequest, 2);
  assert.ok(scale.logLines.some((l) => /rejected the "full" chooser request/.test(l.text)), 'the debug log says what happened');
  // next session starts at the request that worked
  const fb2 = fakeBluetooth({ requestError: (opts) => (opts.filters ? payloadError() : null) });
  const scale2 = createScale({ bluetooth: fb2.bluetooth, prefs, sleep: instant });
  await scale2.connect();
  assert.equal(fb2.requests.length, 2, 'starts at "name", then "all"');
  assert.equal(fb2.requests[1].acceptAllDevices, true);
  assert.equal(prefs.saved.bleRequest, 3);
});

test('BLE: the user cancelling the chooser, or no device matching, does not trigger a fallback', async () => {
  const fb = fakeBluetooth({ requestError: () => Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' }) });
  const scale = createScale({ bluetooth: fb.bluetooth, prefs: memoryPrefs(), sleep: instant });
  await scale.connect();
  assert.equal(fb.requests.length, 1);
  assert.equal(scale.state.status, 'disconnected');
  assert.equal(scale.state.text, 'Not connected');
});

test('BLE: when every request is rejected the failure is reported, and the next tap carries on from where this one stopped', async () => {
  const prefs = memoryPrefs();
  const fb = fakeBluetooth({ requestError: () => payloadError() });
  const errors = [];
  const scale = createScale({ bluetooth: fb.bluetooth, prefs, sleep: instant });
  scale.on('error', (e) => errors.push(e.message));
  await scale.connect();
  assert.equal(fb.requests.length, REQUESTS.length);
  assert.equal(scale.state.status, 'disconnected');
  assert.match(errors[0], /could not be parsed/);
  assert.equal(prefs.saved.bleRequest, REQUESTS.length - 1);
});

test('isRequestProblem tells a rejected request from a cancel or a permission problem', () => {
  assert.equal(isRequestProblem(payloadError()), true);
  assert.equal(isRequestProblem(new TypeError('bad filters')), true);
  for (const name of ['NotFoundError', 'NotAllowedError', 'SecurityError', 'AbortError']) {
    assert.equal(isRequestProblem(Object.assign(new Error('Request payload could not be parsed'), { name })), false, name);
  }
});
