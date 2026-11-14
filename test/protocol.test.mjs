import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, frame, commands, Parser, decode, hex, OP, CMD } from '../protocol.js';

test('crc16 matches CRC-16/MODBUS check value', () => {
  assert.equal(crc16([...'123456789'].map((c) => c.charCodeAt(0))), 0x4b37);
});

test('frame layout: header, opcode, cmd, BE length, payload, BE crc', () => {
  const f = frame(OP.WRITE, CMD.UNIT, [0x00]);
  assert.deepEqual([...f.slice(0, 7)], [0xa5, 0x5a, 0x03, 0x06, 0x00, 0x01, 0x00]);
  const crc = crc16(f.slice(0, 7));
  assert.deepEqual([...f.slice(7)], [crc >> 8, crc & 0xff]);
});

test('command frames have expected headers', () => {
  assert.equal(hex(commands.tare().slice(0, 6)), 'a5 5a 03 0d 00 00');
  assert.equal(hex(commands.modeStandard().slice(0, 8)), 'a5 5a 03 08 00 02 01 00');
  assert.equal(hex(commands.readBattery().slice(0, 6)), 'a5 5a 02 05 00 00');
  assert.equal(commands.writeName('x'.repeat(40)).length, 8 + 16, 'name capped at 16 bytes');
});

const weightFrame = (tenths, flowTenths, secs) => {
  const p = [(tenths >>> 24) & 255, (tenths >>> 16) & 255, (tenths >>> 8) & 255, tenths & 255,
    (flowTenths >> 8) & 255, flowTenths & 255, (secs >> 8) & 255, secs & 255, 0];
  const f = frame(OP.NOTIFY, CMD.WEIGHT, p);
  f[f.length - 2] = 0; f[f.length - 1] = 0; // scale sends 00 00 instead of CRC
  return f;
};

test('decodes weight, negative weight, flow and timer', () => {
  const [m] = new Parser().push(weightFrame(1234, 35, 72));
  assert.equal(m.type, 'weight');
  assert.equal(m.grams, 123.4); assert.equal(m.flow, 3.5); assert.equal(m.seconds, 72); assert.equal(m.overload, false);
  const [n] = new Parser().push(weightFrame(-25, 0, 0));
  assert.equal(n.grams, -2.5);
});

test('parser reassembles split frames and skips garbage', () => {
  const p = new Parser();
  const f = weightFrame(100, 0, 0);
  assert.deepEqual(p.push([0x00, 0xff, ...f.slice(0, 4)]), []);
  const out = p.push([...f.slice(4), ...weightFrame(200, 0, 1)]);
  assert.deepEqual(out.map((m) => m.grams), [10, 20]);
});

test('write replies decode as acks', () => {
  assert.deepEqual(decode(OP.WRITE, CMD.TARE, [1]), { op: 3, cmd: CMD.TARE, type: 'ack', ok: true });
});

test('battery, name and firmware replies', () => {
  assert.equal(decode(OP.READ, CMD.BATTERY, [3, 78]).percent, 78);
  assert.equal(decode(OP.READ, CMD.NAME, [...new TextEncoder().encode('DOT')]).name, 'DOT');
  assert.equal(decode(OP.READ, CMD.FIRMWARE, [...new TextEncoder().encode('v1.0.4')]).version, 'v1.0.4');
});
