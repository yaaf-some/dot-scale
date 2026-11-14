import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS } from '../app/learn/cards.js';
import { filterCards, topicsIn, topicLabel, relatedCards, seenSet, markSeen, seenKey, progress } from '../app/learn/progress.js';
import { parseDiagram } from '../app/learn/svg.js';

const fakePrefs = () => { const m = new Map(); return { get: (k, f) => (m.has(k) ? m.get(k) : f), async set(k, v) { m.set(k, v); }, m }; };

test('topics: every card topic is listed with a label, in display order', () => {
  const t = topicsIn(CARDS);
  assert.equal(t[0].id, 'basics');
  assert.deepEqual(new Set(t.map((x) => x.id)), new Set(CARDS.map((c) => c.topic)));
  assert.equal(topicLabel('espresso'), 'Espresso');
  assert.equal(topicLabel('mystery'), 'Mystery');
});

test('filterCards by topic and method', () => {
  assert.equal(filterCards(CARDS, {}).length, CARDS.length);
  assert.ok(filterCards(CARDS, { topic: 'espresso' }).every((c) => c.topic === 'espresso'));
  const moka = filterCards(CARDS, { method: 'moka' });
  assert.ok(moka.length > 0 && moka.every((c) => c.methods.includes('moka')));
  assert.ok(moka.length < CARDS.length);
  assert.deepEqual(filterCards(CARDS, { topic: 'moka', method: 'espresso' }), []);
  assert.equal(filterCards(CARDS, { topic: 'all', method: 'all' }).length, CARDS.length);
});

test('relatedCards: never itself, same topic first', () => {
  const card = CARDS.find((c) => c.topic === 'espresso');
  const rel = relatedCards(CARDS, card, 3);
  assert.equal(rel.length, 3);
  assert.ok(!rel.some((c) => c.id === card.id));
  assert.ok(rel.every((c) => c.topic === 'espresso'));
});

test('seen tracking is per profile and idempotent', async () => {
  const prefs = fakePrefs();
  assert.equal(seenSet(prefs, 'p1').size, 0);
  assert.equal(await markSeen(prefs, 'p1', 'bloom'), true);
  assert.equal(await markSeen(prefs, 'p1', 'bloom'), false);
  await markSeen(prefs, 'p1', 'puck-prep');
  assert.deepEqual([...seenSet(prefs, 'p1')], ['bloom', 'puck-prep']);
  assert.equal(seenSet(prefs, 'p2').size, 0);
  assert.notEqual(seenKey('p1'), seenKey('p2'));
  assert.deepEqual(progress(CARDS, seenSet(prefs, 'p1')), { seen: CARDS.filter((c) => ['bloom', 'puck-prep'].includes(c.id)).length, total: CARDS.length });
  prefs.m.set(seenKey('p3'), 'garbage');
  assert.equal(seenSet(prefs, 'p3').size, 0, 'a corrupt pref is treated as empty');
});

const countTags = (n) => (typeof n === 'string' ? 0 : 1 + n.children.reduce((s, c) => s + countTags(c), 0));

test('every card diagram parses to a safe SVG tree', () => {
  const withDiagram = CARDS.filter((c) => c.diagram);
  assert.ok(withDiagram.length >= 3);
  for (const c of withDiagram) {
    const t = parseDiagram(c.diagram);
    assert.equal(t.tag, 'svg', c.id);
    assert.ok(t.attrs.viewBox && t.attrs['aria-label'], c.id);
    assert.ok(countTags(t) > 2, c.id);
  }
  const text = parseDiagram(withDiagram.find((c) => c.diagram.includes('<text')).diagram);
  const find = (n) => (typeof n === 'string' ? null : n.tag === 'text' ? n : n.children.map(find).find(Boolean));
  assert.equal(typeof find(text).children[0], 'string');
});

test('parseDiagram strips scripts, handlers, links, url() and unknown elements', () => {
  const evil = '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><g onclick="x()"><path d="M0 0" fill="url(#a)" stroke="red"/></g>' +
    '<a href="javascript:alert(1)"><text x="1">hi &amp; bye</text></a><foreignObject><div>bad</div></foreignObject><circle r="2" style="x:y"/></svg>';
  const t = parseDiagram(evil);
  const dump = JSON.stringify(t);
  for (const bad of ['script', 'onload', 'onclick', 'javascript', 'url(', 'foreignObject', 'href', 'style', 'alert']) assert.ok(!dump.includes(bad), bad);
  assert.equal(t.attrs.viewBox, '0 0 10 10');
  assert.equal(t.children[0].tag, 'g');
  assert.deepEqual(t.children[0].children[0].attrs, { d: 'M0 0', stroke: 'red' });
  assert.ok(!dump.includes('"a"'), 'the anchor is dropped with its children');
  assert.equal(t.children.at(-1).tag, 'circle');
});

test('parseDiagram rejects non-SVG input', () => {
  for (const x of [undefined, null, '', 'hello', '<div></div>', '<script>1</script>', 42]) assert.equal(parseDiagram(x), null);
});
