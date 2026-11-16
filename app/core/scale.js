// The scale, as seen by the rest of the app. Views and the brew-session state machine talk to `scale`, never to
// Bluetooth. Two transports sit behind it: Web Bluetooth (real Dot) and demo-scale.js (simulator, same protocol).
//
//   const scale = createScale({ prefs });         // prefs: store.prefs (optional; remembers the known scale)
//   scale.on('weight',  ({ grams, flow, seconds, overload, at }) => …)   // ~10 Hz. `at` = performance.now() ms
//   scale.on('status',  ({ status, mode, text }) => …)  // status: disconnected | connecting | connected | reconnecting
//   scale.on('battery', ({ percent }) => …)
//   scale.on('timer',   ({ running, state }) => …)       // the scale's own timer
//   scale.on('info',    ({ model, firmware, name, deviceName }) => …)
//   scale.on('log',     ({ time, text }) => …)           // protocol log, also kept in scale.logLines
//   scale.on('message', (decodedFrame) => …)             // everything the parser decodes, weights included
//   scale.state                                           // read-only snapshot, always current
//   await scale.connect()  scale.autoConnect()  scale.startDemo()  scale.disconnect()
//   scale.tare()  scale.timer.start()/pause()/reset()  scale.rename(n)  scale.powerOff()  scale.forgetPairing()
//   scale.factoryReset()  scale.sendRaw([op, cmd, ...payload])
import { SERVICE, CHAR_NOTIFY, CHAR_WRITE, DEVICE_INFO, CMD, TIMER, commands, frame, Parser, hex } from '../../protocol.js';
import { Emitter } from './events.js';
import { createDemoTransport } from './demo-scale.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => {
  let id;
  const timeout = new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`${what} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(id));
};
const CMD_NAMES = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k.toLowerCase()]));
const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000, 13000];

/**
 * A 16-bit Bluetooth UUID as the canonical 128-bit string. Both forms are valid Web Bluetooth, but Bluefy (iOS) fails with
 * "Request payload could not be parsed" on bare numbers like 0xfff0, so the app only ever sends the string form.
 */
export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const U = {
  service: uuid16(SERVICE), notify: uuid16(CHAR_NOTIFY), write: uuid16(CHAR_WRITE),
  info: uuid16(DEVICE_INFO), model: uuid16(0x2a24), maker: uuid16(0x2a29),
};

const NAME_FILTERS = [{ namePrefix: 'TIMEMORE' }, { namePrefix: 'Timemore' }, { namePrefix: 'DOT' }, { namePrefix: 'Dot' }];
export const BLE_FILTERS = [{ services: [U.service] }, ...NAME_FILTERS];
const OPTIONAL = [U.service, U.info];

/**
 * Device-chooser requests, most specific first. If a browser rejects the request itself (not the user, and not "no device
 * found"), the next, simpler one is tried; the one that works is remembered in prefs (`bleRequest`, an index into this list).
 * The last one shows every Bluetooth device, so the scale can still be picked by name.
 */
export const REQUESTS = [
  { id: 'full', options: { filters: BLE_FILTERS, optionalServices: OPTIONAL } },
  { id: 'service', options: { filters: [{ services: [U.service] }], optionalServices: OPTIONAL } },
  { id: 'name', options: { filters: NAME_FILTERS, optionalServices: OPTIONAL } },
  { id: 'all', options: { acceptAllDevices: true, optionalServices: OPTIONAL } },
];
const NOT_A_REQUEST_PROBLEM = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'AbortError', 'NetworkError', 'InvalidStateError']);
const REQUEST_PROBLEM = /payload|pars(e|ing)|invalid|malformed|not supported|unsupported|argument/i;
/** True when the browser refused the request's shape, as opposed to the user cancelling or no device matching. */
export const isRequestProblem = (e) => !NOT_A_REQUEST_PROBLEM.has(e?.name)
  && (REQUEST_PROBLEM.test(e?.message || '') || ['TypeError', 'NotSupportedError', 'SyntaxError', 'DataError', 'OperationError'].includes(e?.name));

async function openBle(device, onBytes) {
  const server = await device.gatt.connect();
  let notify, writeChar;
  try {
    const svc = await server.getPrimaryService(U.service);
    notify = await svc.getCharacteristic(U.notify);
    writeChar = await svc.getCharacteristic(U.write);
    notify.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      onBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await notify.startNotifications();
  } catch (e) {
    try { device.gatt.disconnect(); } catch {} // don't leave a half-open GATT link behind
    throw e;
  }
  return {
    kind: 'ble', deviceName: device.name,
    async write(bytes) {
      if (writeChar.writeValueWithoutResponse) await writeChar.writeValueWithoutResponse(bytes);
      else await writeChar.writeValue(bytes);
    },
    async readInfo() {
      const info = await server.getPrimaryService(U.info);
      const read = async (uuid) => new TextDecoder().decode(await (await info.getCharacteristic(uuid)).readValue());
      const [model, maker] = await Promise.all([read(U.model).catch(() => '?'), read(U.maker).catch(() => '?')]);
      return { model, maker };
    },
    disconnect() { device.gatt.disconnect(); },
  };
}

export function createScale({ bluetooth = globalThis.navigator?.bluetooth, prefs, sleep = wait, logLimit = 200 } = {}) {
  const events = new Emitter();
  const parser = new Parser();
  const state = {
    supported: !!bluetooth, status: 'disconnected', mode: null, text: 'Not connected',
    deviceName: '', model: '', firmware: '', name: '', battery: null,
    grams: 0, flow: 0, seconds: 0, overload: false, timerRunning: false,
  };
  const logLines = [];
  let transport = null;
  let device = null;          // BLE device, for reconnects
  let session = 0;            // bumps on every connect/disconnect so stale retry loops stop
  let userDisconnect = false;
  let lastSeconds;
  let ignoredDisconnects = 0; // gattserverdisconnected events caused by closing an abandoned attempt

  const log = (text) => {
    const line = { time: new Date(), text };
    logLines.push(line); if (logLines.length > logLimit) logLines.shift();
    events.emit('log', line);
  };
  const setStatus = (status, text, mode = state.mode) => {
    Object.assign(state, { status, text, mode });
    events.emit('status', { status, text, mode });
  };

  async function send(bytes, label = '') {
    log(`→ ${hex(bytes)}${label ? `  (${label})` : ''}`);
    try { await transport?.write(bytes); } catch (e) { log(`Write failed: ${e.message}`); }
  }

  function describe(m) {
    switch (m.type) {
      case 'weight': return `${m.grams} g, ${m.flow} g/s, ${m.seconds}s${m.overload ? ' OVERLOAD' : ''}`;
      case 'ack': return `${CMD_NAMES[m.cmd] || `cmd ${m.cmd}`} ${m.ok ? 'ok' : 'FAILED'}`;
      case 'timer': return `timer ${['', 'running', 'paused', 'reset'][m.state] || m.state}`;
      case 'battery': return `battery ${m.percent}%`;
      case 'unit': return `unit ${m.unit}`;
      case 'name': return `name “${m.name}”`;
      case 'firmware': return `firmware ${m.version}`;
      default: return 'unknown';
    }
  }

  function setTimerRunning(running) {
    if (state.timerRunning === running) return;
    state.timerRunning = running;
    events.emit('timer', { running, state: running ? TIMER.START : TIMER.PAUSE });
  }

  function handle(m) {
    events.emit('message', m);
    switch (m.type) {
      case 'weight':
        Object.assign(state, { grams: m.grams, flow: m.flow, seconds: m.seconds, overload: m.overload });
        // The scale reports a running timer even if we missed the start notification.
        if (m.seconds > 0 && !state.timerRunning && lastSeconds !== undefined && m.seconds > lastSeconds) setTimerRunning(true);
        lastSeconds = m.seconds;
        events.emit('weight', { grams: m.grams, flow: m.flow, seconds: m.seconds, overload: m.overload, at: performance.now() });
        break;
      case 'timer':
        if (m.state === TIMER.START) setTimerRunning(true);
        else if (m.state === TIMER.PAUSE) setTimerRunning(false);
        else if (m.state === TIMER.RESET) { setTimerRunning(false); lastSeconds = 0; events.emit('timer', { running: false, state: TIMER.RESET }); }
        break;
      case 'battery': state.battery = m.percent; events.emit('battery', { percent: m.percent }); break;
      case 'firmware': state.firmware = m.version; emitInfo(); break;
      case 'name': state.name = m.name; emitInfo(); break;
      case 'ack': if (!m.ok) log(`Scale refused ${CMD_NAMES[m.cmd] || m.cmd}`); break;
    }
  }
  const emitInfo = () => events.emit('info', { model: state.model, firmware: state.firmware, name: state.name, deviceName: state.deviceName });

  function onBytes(bytes) {
    for (const m of parser.push(bytes)) {
      if (m.type !== 'weight' || prefs?.get('logWeight', false)) log(`← ${hex(m.raw)}  ${describe(m)}`);
      handle(m);
    }
  }

  async function initScale(mySession) {
    // The Dot only streams weight after it's told the unit and mode.
    const steps = [[500, commands.unitGrams(), 'unit = grams'], [200, commands.modeStandard(), 'mode = standard'],
      [100, commands.readBattery(), 'read battery'], [100, commands.readFirmware(), 'read firmware'], [100, commands.readName(), 'read name']];
    for (const [ms, bytes, label] of steps) {
      await sleep(ms);
      if (mySession !== session) return;
      await send(bytes, label);
    }
    transport?.readInfo?.().then((i) => { if (mySession === session) { state.model = `${i.maker} ${i.model}`; emitInfo(); } }).catch(() => {});
  }

  async function attach(next, mySession) {
    transport = next;
    state.deviceName = next.deviceName || '';
    userDisconnect = false;
    parser.buf.length = 0; lastSeconds = undefined;
    setStatus('connected', next.kind === 'demo' ? 'Demo scale' : (next.deviceName || 'Connected'), next.kind);
    log(next.kind === 'demo' ? 'Demo started' : `Connected to ${next.deviceName || 'scale'}`);
    await initScale(mySession);
  }

  async function openDevice(dev, mySession) {
    device = dev;
    dev.addEventListener('gattserverdisconnected', onGattDisconnected);
    setStatus('connecting', 'Connecting…', 'ble');
    const attempt = openBle(dev, onBytes);
    // If the attempt is abandoned (timeout or superseded), close it when it eventually resolves. The disconnect
    // event that causes is ignored, or it would start another reconnect loop.
    const abandon = () => attempt.then((late) => { ignoredDisconnects++; try { late.disconnect(); } catch { ignoredDisconnects--; } }, () => {});
    let t;
    try { t = await withTimeout(attempt, 15000, 'Connecting'); } catch (e) { abandon(); throw e; }
    if (mySession !== session) { ignoredDisconnects++; try { t.disconnect(); } catch { ignoredDisconnects--; } return; }
    await attach(t, mySession);
  }

  async function onGattDisconnected() {
    if (ignoredDisconnects > 0) { ignoredDisconnects--; return; }
    if (state.mode !== 'ble' && state.status !== 'reconnecting') return;
    transport = null; setTimerRunning(false);
    if (userDisconnect) { setStatus('disconnected', 'Not connected', null); return; }
    const mySession = ++session;
    log('Scale disconnected, retrying…');
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      if (mySession !== session) return;
      setStatus('reconnecting', `Reconnecting (${i + 1}/${RETRY_DELAYS.length})…`, 'ble');
      await sleep(RETRY_DELAYS[i]);
      if (mySession !== session) return;
      try { await openDevice(device, mySession); return; } catch (e) { log(`Reconnect: ${e.message}`); }
    }
    if (mySession === session) setStatus('disconnected', 'Disconnected', null);
  }

  /** Opens the chooser. Starts at the request that worked last time and falls back to simpler ones if the browser rejects it. */
  async function requestScale() {
    const saved = prefs?.get('bleRequest', 0);
    const first = Number.isInteger(saved) ? Math.min(Math.max(saved, 0), REQUESTS.length - 1) : 0;
    let lastError;
    for (let i = first; i < REQUESTS.length; i++) {
      try {
        const dev = await bluetooth.requestDevice(REQUESTS[i].options);
        prefs?.set('bleRequest', i);
        if (i > 0) log(`Chooser request "${REQUESTS[i].id}" worked.`);
        return dev;
      } catch (e) {
        lastError = e;
        if (!isRequestProblem(e)) throw e;
        const next = REQUESTS[i + 1];
        log(`The browser rejected the "${REQUESTS[i].id}" chooser request (${e.message})${next ? `; trying "${next.id}"` : ''}.`);
        // Remember how far we got, so another tap on Connect starts at the next request even if this call can't carry on
        // (some browsers only allow a chooser right after a tap).
        if (next) prefs?.set('bleRequest', i + 1);
      }
    }
    throw lastError;
  }

  const scale = {
    state, logLines,
    on: events.on.bind(events),
    get supported() { return state.supported; },
    get connected() { return state.status === 'connected'; },
    /** Demo transport, when running (for demo-only helpers like place()). */
    get demo() { return transport?.kind === 'demo' ? transport : null; },

    /** Opens the browser's device chooser. Needs a user gesture. */
    async connect() {
      if (!bluetooth) throw new Error('This browser has no Web Bluetooth');
      if (state.status === 'connected' || state.status === 'connecting') return;
      const mySession = ++session;
      try {
        setStatus('connecting', 'Choose your scale…', 'ble');
        const dev = await requestScale();
        await openDevice(dev, mySession);
        prefs?.set('knownScale', { id: dev.id, name: dev.name });
      } catch (e) {
        log(`Connect: ${e.message}`);
        setStatus('disconnected', e.name === 'NotFoundError' ? 'Not connected' : 'Connection failed', null);
        if (e.name !== 'NotFoundError') events.emit('error', { message: e.message });
      }
    },

    /** Reconnect to the scale this device used before, without a chooser. Returns true on success. Needs getDevices(). */
    async autoConnect() {
      const known = prefs?.get('knownScale');
      // A deliberate Disconnect sticks until the user connects again (attach() clears the flag).
      if (!known || !bluetooth?.getDevices || state.status !== 'disconnected' || userDisconnect) return false;
      const mySession = ++session;
      try {
        const dev = (await bluetooth.getDevices()).find((d) => d.id === known.id);
        if (!dev) return false;
        await openDevice(dev, mySession);
        return true;
      } catch (e) {
        log(`Auto-connect: ${e.message}`);
        if (mySession === session) setStatus('disconnected', 'Not connected', null);
        return false;
      }
    },

    async startDemo(scenario) {
      if (state.status === 'connected' || state.status === 'connecting') await scale.disconnect();
      const mySession = ++session;
      state.model = 'Simulated TES017';
      await attach(createDemoTransport(onBytes, { scenario }), mySession);
    },

    async disconnect() {
      userDisconnect = true;
      session++;
      const t = transport; transport = null;
      setTimerRunning(false);
      Object.assign(state, { grams: 0, flow: 0, seconds: 0, overload: false, battery: null });
      try { t?.disconnect(); } catch {}
      setStatus('disconnected', 'Not connected', null);
      events.emit('weight', { grams: 0, flow: 0, seconds: 0, overload: false, at: performance.now() });
    },

    tare: () => send(commands.tare(), 'tare'),
    timer: {
      start: () => { setTimerRunning(true); return send(commands.timer(TIMER.START), 'timer start'); },
      pause: () => { setTimerRunning(false); return send(commands.timer(TIMER.PAUSE), 'timer pause'); },
      reset: () => { setTimerRunning(false); lastSeconds = 0; events.emit('timer', { running: false, state: TIMER.RESET }); return send(commands.timer(TIMER.RESET), 'timer reset'); },
    },
    async rename(name) {
      const n = String(name).trim().slice(0, 16);
      if (!n) return;
      await send(commands.writeName(n), 'rename');
      state.name = n; emitInfo();
      setTimeout(() => send(commands.readName(), 'read name'), 400);
    },
    powerOff: () => send(commands.powerOff(), 'power off'),
    forgetPairing: () => send(commands.forgetPairing(), 'forget pairing'),
    factoryReset: () => send(commands.factoryReset(), 'factory reset'),
    /** bytes = [opcode, cmd, ...payload] as numbers; header and CRC are added. */
    sendRaw: (bytes) => send(frame(bytes[0], bytes[1], bytes.slice(2)), 'raw'),
  };
  return scale;
}
