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

export const BLE_FILTERS = [
  { services: [SERVICE] }, { namePrefix: 'TIMEMORE' }, { namePrefix: 'Timemore' }, { namePrefix: 'DOT' }, { namePrefix: 'Dot' },
];

async function openBle(device, onBytes) {
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(SERVICE);
  const notify = await svc.getCharacteristic(CHAR_NOTIFY);
  const writeChar = await svc.getCharacteristic(CHAR_WRITE);
  notify.addEventListener('characteristicvaluechanged', (e) => {
    const v = e.target.value;
    onBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  });
  await notify.startNotifications();
  return {
    kind: 'ble', deviceName: device.name,
    async write(bytes) {
      if (writeChar.writeValueWithoutResponse) await writeChar.writeValueWithoutResponse(bytes);
      else await writeChar.writeValue(bytes);
    },
    async readInfo() {
      const info = await server.getPrimaryService(DEVICE_INFO);
      const read = async (uuid) => new TextDecoder().decode(await (await info.getCharacteristic(uuid)).readValue());
      const [model, maker] = await Promise.all([read(0x2a24).catch(() => '?'), read(0x2a29).catch(() => '?')]);
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
    const t = await withTimeout(openBle(dev, onBytes), 15000, 'Connecting');
    if (mySession !== session) { try { t.disconnect(); } catch {} return; }
    await attach(t, mySession);
  }

  async function onGattDisconnected() {
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
        const dev = await bluetooth.requestDevice({ filters: BLE_FILTERS, optionalServices: [SERVICE, DEVICE_INFO] });
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
      if (!known || !bluetooth?.getDevices || state.status !== 'disconnected') return false;
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
