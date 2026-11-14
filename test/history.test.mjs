import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrate, mergeHistory, normalizeEntry, downsample, samplesToSeries, toCSV, toExport, parseImport,
  entryId, MAX_ENTRIES, MAX_SAMPLES, CSV_COLUMNS,
} from '../history.js';

const v1 = (at, dose = 15, out = 240, time = 180) => ({ at, dose, out, time });

test('migrate keeps v1 entries and adds a deterministic id', () => {
  const list = migrate([v1(1700000000000), v1(1700000100000, 18, 300.5, 200)]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: '1700000000000-15-240', at: 1700000000000, dose: 15, out: 240, time: 180 });
  assert.equal(list[1].id, entryId(list[1]));
  assert.deepEqual(migrate(list), list, 'migration is idempotent');
});

test('migrate drops junk and handles non-arrays', () => {
  assert.deepEqual(migrate(null), []);
  assert.deepEqual(migrate({}), []);
  const list = migrate([null, 5, {}, { at: 'nope', dose: 1, out: 2 }, v1(1700000000000)]);
  assert.equal(list.length, 1);
});

test('migrate sorts oldest first and caps', () => {
  const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => v1(1700000000000 + (MAX_ENTRIES + 10 - i) * 1000));
  const list = migrate(many);
  assert.equal(list.length, MAX_ENTRIES);
  assert.ok(list.every((e, i) => i === 0 || list[i - 1].at < e.at));
  assert.equal(list[list.length - 1].at, 1700000000000 + (MAX_ENTRIES + 10) * 1000, 'keeps the newest');
});

test('normalizeEntry cleans notes and samples', () => {
  const e = normalizeEntry({
    ...v1(1700000000000), target: 240,
    samples: [[0, 0, 0], [1.234, 5.67, 'x'], [2, 10, 4]],
    notes: { bean: '  Ethiopia ', grind: '', rating: 9, text: 'bright' },
  });
  assert.deepEqual(e.samples, [[0, 0, 0], [2, 10, 4]]);
  assert.deepEqual(e.notes, { bean: 'Ethiopia', text: 'bright' });
  assert.equal(e.target, 240);
  assert.equal(normalizeEntry({ ...v1(1700000000000), notes: { rating: '4' } }).notes.rating, 4);
  assert.equal(normalizeEntry({ ...v1(1700000000000), notes: {} }).notes, undefined);
});

test('merge de-duplicates the same brew from two browsers', () => {
  const a = migrate([v1(1700000000000), v1(1700000100000)]);
  const b = [v1(1700000100000), v1(1700000200000)]; // raw v1 export, no ids
  const merged = mergeHistory(a, b);
  assert.deepEqual(merged.map((e) => e.at), [1700000000000, 1700000100000, 1700000200000]);
});

test('merge keeps the newest edit and fills in missing samples/notes', () => {
  const base = { ...v1(1700000000000), id: 'x' };
  const withSamples = { ...base, samples: [[0, 0, 0], [1, 2, 2]] };
  const edited = { ...base, notes: { bean: 'Kenya' }, updated: 1700000500000 };
  const merged = mergeHistory([withSamples], [edited]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].notes, { bean: 'Kenya' });
  assert.deepEqual(merged[0].samples, [[0, 0, 0], [1, 2, 2]]);

  const older = { ...base, notes: { bean: 'Old' }, updated: 1 };
  assert.equal(mergeHistory([edited], [older])[0].notes.bean, 'Kenya', 'older edit does not win');
  const cleared = { ...base, updated: 1700000900000 };
  assert.equal(mergeHistory([edited], [cleared])[0].notes, undefined, 'notes cleared later stay cleared');
});

test('downsample keeps size bounded, endpoints and order', () => {
  const series = Array.from({ length: 1800 }, (_, i) => ({ t: i / 10, w: i / 5, f: 2 }));
  const s = downsample(series);
  assert.ok(s.length <= MAX_SAMPLES && s.length > MAX_SAMPLES - 5, `length ${s.length}`);
  assert.deepEqual(s[0], [0, 0, 2]);
  assert.deepEqual(s[s.length - 1], [179.9, 359.8, 2]);
  assert.ok(s.every((p, i) => i === 0 || s[i - 1][0] < p[0]));
  assert.ok(JSON.stringify(s).length < 4000, 'a three-minute brew stays under 4 KB');
  assert.deepEqual(downsample([{ t: 0, w: 0, f: 0 }]), []);
  assert.equal(downsample(series.slice(0, 10)).length, 10);
  assert.deepEqual(samplesToSeries([[1, 2, 3]]), [{ t: 1, w: 2, f: 3 }]);
});

test('CSV has a header, escapes text and neutralises formulas', () => {
  const list = migrate([
    v1(Date.UTC(2026, 0, 2, 3, 4, 5)),
    { ...v1(Date.UTC(2026, 0, 3)), target: 240, notes: { bean: 'Kenya, "AA"', grind: '=SUM(A1)', rating: 4, text: 'line1\nline2' } },
  ]);
  const lines = toCSV(list).split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines[1], '2026-01-02T03:04:05.000Z,15,240,16,180,,,,,');
  assert.equal(lines[2], `2026-01-03T00:00:00.000Z,15,240,16,180,240,"Kenya, ""AA""\",'=SUM(A1),4,"line1\nline2"`);
});

test('export round-trips through import', () => {
  const list = migrate([{ ...v1(1700000000000), samples: [[0, 0, 0], [1, 2, 2]], notes: { rating: 5 } }]);
  const text = JSON.stringify(toExport(list, 0));
  assert.equal(JSON.parse(text).exportedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(parseImport(text), list);
  assert.deepEqual(parseImport(JSON.stringify([v1(1700000000000)])).length, 1, 'bare array of v1 entries');
});

test('import rejects files that are not history', () => {
  assert.throws(() => parseImport('not json'), /JSON/);
  assert.throws(() => parseImport('{"a":1}'), /No brew history/);
  assert.throws(() => parseImport('{"format":"other","history":[]}'), /Not a Dot Scale/);
  assert.throws(() => parseImport('[{"x":1}]'), /No valid brews/);
  assert.deepEqual(parseImport('[]'), []);
});
