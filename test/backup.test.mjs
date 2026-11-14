import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExport, exportJSON, parseImport, planImport, cleanRecord, csvCell, exportCSV, CSV_COLUMNS, BACKUP_TYPES } from '../app/journal/backup.js';

const brew = (o = {}) => ({ id: 'b1', type: 'brew', profileId: 'p1', method: 'espresso', startedAt: 1700000000000, dose: 16, yield: 32, ratio: 2, timeS: 27, updatedAt: 100, ...o });

test('export has the envelope, live records of backed-up types only', () => {
  const x = toExport([brew(), brew({ id: 'gone', deleted: true }), { id: 'x', type: 'weird', updatedAt: 1 }, { id: 'p', type: 'profile', name: 'Yaaf', updatedAt: 1 }], 1700000000000);
  assert.equal(x.format, 'dot-scale');
  assert.equal(x.exportedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(x.records.map((r) => r.id), ['b1', 'p']);
  assert.ok(BACKUP_TYPES.includes('brew'));
  assert.deepEqual(JSON.parse(exportJSON([brew()], 0)).records, [brew()]);
});

test('parseImport round-trips an export and also takes a bare array', () => {
  const recs = [brew(), { id: 'bean1', type: 'bean', name: 'Guji', roaster: 'x', updatedAt: 5 }];
  assert.deepEqual(parseImport(exportJSON(recs)), recs);
  assert.deepEqual(parseImport(JSON.stringify(recs)), recs);
});

test('parseImport rejects garbage with a readable message', () => {
  assert.throws(() => parseImport('nope{'), /isn’t JSON/);
  assert.throws(() => parseImport('{"hello":1}'), /isn’t a Dot Scale backup/);
  assert.throws(() => parseImport('{"format":"other","records":[]}'), /isn’t a Dot Scale backup/);
  assert.throws(() => parseImport('[{"id":"a"},5,null]'), /No usable records/);
  assert.deepEqual(parseImport('[]'), [], 'an empty backup is valid');
});

test('cleanRecord drops bad ids/types/times, keeps tombstones, repairs or drops broken curves', () => {
  assert.equal(cleanRecord({ type: 'brew', updatedAt: 1 }), null);
  assert.equal(cleanRecord({ id: 'a', type: 'sync-cursor', updatedAt: 1 }), null);
  assert.equal(cleanRecord({ id: 'a', type: 'bean', updatedAt: 'now' }), null);
  assert.equal(cleanRecord({ id: 'x'.repeat(500), type: 'bean', updatedAt: 1 }), null);
  assert.deepEqual(cleanRecord({ id: 'a', type: 'brew', updatedAt: 9, deleted: true, junk: 1 }), { id: 'a', type: 'brew', updatedAt: 9, deleted: true });
  assert.equal(cleanRecord(brew({ dose: 'sixteen' })), null);
  assert.equal(cleanRecord(brew({ method: '' })), null);
  const bad = cleanRecord(brew({ samples: { hz: 10, t0: 0, channels: { weight: [1, 'x', 3] } } }));
  assert.equal(bad.samples, undefined);
  assert.equal(bad.id, 'b1');
  const ok = cleanRecord(brew({ samples: { hz: 10, t0: 0, channels: { weight: [0, 1, 2], flow: [0, 1, 1] } } }));
  assert.equal(ok.samples.channels.weight.length, 3);
  assert.equal(cleanRecord(brew({ timeS: null })).timeS, 0);
});

test('old-app history exports import as legacy brews for the chosen profile', () => {
  const file = JSON.stringify({ format: 'dot-scale-history', version: 2, history: [{ at: 1700000000000, dose: 15, out: 240, time: 190 }] });
  assert.throws(() => parseImport(file), /who these brews belong/);
  const [b] = parseImport(file, { profileId: 'p9' });
  assert.equal(b.legacy, true);
  assert.equal(b.profileId, 'p9');
  assert.equal(b.method, 'pour-over');
  assert.equal(b.id, 'legacy-brew-1700000000000-15-240', 'deterministic id, so importing twice merges');
});

test('planImport: adds new, newest updatedAt wins, ties keep local, tombstones win when newer, duplicates collapse', () => {
  const local = [brew({ id: 'same', updatedAt: 50 }), brew({ id: 'older-here', updatedAt: 10, notes: 'old' }), brew({ id: 'newer-here', updatedAt: 90, notes: 'mine' }),
    { id: 'dead', type: 'brew', updatedAt: 70, deleted: true }];
  const incoming = [
    brew({ id: 'new', updatedAt: 5 }), brew({ id: 'same', updatedAt: 50, notes: 'tie' }), brew({ id: 'older-here', updatedAt: 20, notes: 'new' }),
    brew({ id: 'newer-here', updatedAt: 80, notes: 'theirs' }), brew({ id: 'dead', updatedAt: 60 }), brew({ id: 'new', updatedAt: 7, notes: 'dup' }),
  ];
  const p = planImport(local, incoming);
  assert.deepEqual(p.apply.map((r) => r.id).sort(), ['new', 'older-here']);
  assert.equal(p.apply.find((r) => r.id === 'new').notes, 'dup', 'the newest copy within the file wins');
  assert.equal(p.apply.find((r) => r.id === 'older-here').notes, 'new');
  assert.deepEqual({ added: p.added, updated: p.updated, skipped: p.skipped }, { added: 1, updated: 1, skipped: 4 });
  // importing the same file again changes nothing
  const again = planImport([...local.filter((r) => !['new', 'older-here'].includes(r.id)), ...p.apply], incoming);
  assert.equal(again.apply.length, 0);
  assert.equal(planImport([], []).apply.length, 0);
});

test('csvCell quotes, escapes and defuses spreadsheet formulas (text only; numbers stay numbers)', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  for (const bad of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx']) assert.ok(csvCell(bad).replace(/^"/, '').startsWith("'"), bad);
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(null), '');
});

test('exportCSV: header, rows oldest first, names resolved, formulas in notes and names defused', () => {
  const profiles = [{ id: 'p1', name: '=HYPERLINK("x")' }];
  const beans = [{ id: 'bean1', name: 'Ethiopia Guji', roaster: 'Acme, Inc' }];
  const csv = exportCSV({
    profiles, beans,
    brews: [
      brew({ id: 'late', startedAt: 1700000100000, beanId: 'bean1', grind: { value: 11, text: 'fine' }, taste: { stars: 4, balance: -1, strength: 0 }, notes: '=1+1' }),
      brew({ id: 'early', startedAt: 1700000000000, deleted: false, legacy: true }),
      brew({ id: 'del', deleted: true }),
    ],
  });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('2023-11-14T22:13:20.000Z,"\'=HYPERLINK(""x"")",espresso,'));
  assert.ok(lines[2].includes('"Acme, Inc"') && lines[2].includes('Ethiopia Guji') && lines[2].includes(',11 fine,') && lines[2].includes(",4,-1,0,'=1+1"), lines[2]);
});
