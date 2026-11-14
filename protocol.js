// Timemore Dot (TES017) BLE protocol.
// Source: Timemore's official open-scale-protocol v1.0.3
// (github.com/TIMEMORE-COFFEE/open-scale-protocol), plus the mode-init command and
// verified command bytes from decentespresso/decaid PR #739.
//
// Frame: A5 5A | opcode | cmd | len (u16 BE) | payload | CRC16 (BE)
// CRC is CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF) over everything before it.
// The scale's own notifications carry a 00 00 CRC, so incoming frames are not CRC-checked.

export const SERVICE = 0xfff0;
export const CHAR_NOTIFY = 0xfff1;
export const CHAR_WRITE = 0xfff2;
export const DEVICE_INFO = 0x180a;

export const OP = { NOTIFY: 0x01, READ: 0x02, WRITE: 0x03 };
export const CMD = {
  WEIGHT: 0x01, TIMER: 0x02, BATTERY: 0x05, UNIT: 0x06, MODE: 0x08,
  POWER_OFF: 0x0b, NAME: 0x0c, TARE: 0x0d, FIRMWARE: 0x10,
  FACTORY_RESET: 0x19, FORGET: 0x1a,
};
export const TIMER = { START: 0x01, PAUSE: 0x02, RESET: 0x03 };

const MAX_PAYLOAD = 64;

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export function frame(op, cmd, payload = []) {
  const body = [0xa5, 0x5a, op, cmd, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
  const crc = crc16(body);
  return new Uint8Array([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

export const commands = {
  tare: () => frame(OP.WRITE, CMD.TARE),
  timer: (action) => frame(OP.WRITE, CMD.TIMER, [action]),
  unitGrams: () => frame(OP.WRITE, CMD.UNIT, [0x00]),
  modeStandard: () => frame(OP.WRITE, CMD.MODE, [0x01, 0x00]),
  readBattery: () => frame(OP.READ, CMD.BATTERY),
  readTimer: () => frame(OP.READ, CMD.TIMER),
  readFirmware: () => frame(OP.READ, CMD.FIRMWARE),
  readName: () => frame(OP.READ, CMD.NAME),
  writeName: (name) => frame(OP.WRITE, CMD.NAME, [...new TextEncoder().encode(name)].slice(0, 16)),
  powerOff: () => frame(OP.WRITE, CMD.POWER_OFF),
  forgetPairing: () => frame(OP.WRITE, CMD.FORGET),
  factoryReset: () => frame(OP.WRITE, CMD.FACTORY_RESET),
};

// Streaming parser: feed raw notification bytes, get decoded messages back.
export class Parser {
  constructor() { this.buf = []; }

  push(bytes) {
    this.buf.push(...bytes);
    if (this.buf.length > 256) this.buf.splice(0, this.buf.length - 256);
    const out = [];
    while (this.buf.length >= 8) {
      if (this.buf[0] !== 0xa5 || this.buf[1] !== 0x5a) { this.buf.shift(); continue; }
      const len = (this.buf[4] << 8) | this.buf[5];
      if (len > MAX_PAYLOAD) { this.buf.shift(); continue; }
      const total = len + 8;
      if (this.buf.length < total) break;
      const f = this.buf.splice(0, total);
      const msg = decode(f[2], f[3], f.slice(6, 6 + len));
      msg.raw = f;
      out.push(msg);
    }
    return out;
  }
}

export function decode(op, cmd, p) {
  const base = { op, cmd };
  // Replies to WRITE are a single success byte.
  if (op === OP.WRITE) return { ...base, type: 'ack', ok: p[0] === 1 };

  switch (cmd) {
    case CMD.WEIGHT: {
      if (p.length < 8) break;
      const w = new DataView(new Uint8Array(p).buffer);
      return {
        ...base, type: 'weight',
        grams: w.getInt32(0) / 10,
        flow: w.getInt16(4) / 10, // g/s
        seconds: w.getUint16(6),
        overload: p.length > 8 ? p[8] === 1 : false,
      };
    }
    case CMD.TIMER: return { ...base, type: 'timer', state: p[0] };
    case CMD.BATTERY: return { ...base, type: 'battery', bars: p[0], percent: p.length > 1 ? p[1] : p[0] };
    case CMD.UNIT: return { ...base, type: 'unit', unit: p[0] === 1 ? 'oz' : 'g' };
    case CMD.NAME: return { ...base, type: 'name', name: new TextDecoder().decode(new Uint8Array(p)) };
    case CMD.FIRMWARE: return { ...base, type: 'firmware', version: new TextDecoder().decode(new Uint8Array(p)) };
  }
  return { ...base, type: 'unknown', payload: p };
}

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
