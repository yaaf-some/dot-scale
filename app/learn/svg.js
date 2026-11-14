// Turns a card's `diagram` (a small inline-SVG string from app/learn/cards.js) into a plain tree with an allow-list of
// elements and attributes, so the UI can build nodes with createElementNS and never has to use innerHTML.
// Anything not on the list (scripts, handlers, links, url() references, foreignObject, styles) is dropped.
// Pure: tested in test/learn.test.mjs.
const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'title', 'desc']);
const ATTRS = new Set(['viewBox', 'role', 'aria-label', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'opacity', 'font-size', 'text-anchor', 'transform']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m]);
const BAD_VALUE = /url\s*\(|javascript:|data:|expression\s*\(/i;
const MAX_NODES = 400;

/** → { tag, attrs: {}, children: (node | string)[] } for the root <svg>, or null if the string isn't a safe SVG. */
export function parseDiagram(src) {
  if (typeof src !== 'string' || !/^\s*<svg[\s>]/i.test(src) || src.length > 20000) return null;
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  let skip = 0; // depth inside a dropped element
  let count = 0;
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  for (const m of src.matchAll(token)) {
    const [, closing, rawTag, rawAttrs, selfClose, text] = m;
    if (text !== undefined) { if (!skip && stack.length > 1 && text.trim()) stack.at(-1).children.push(decode(text)); continue; }
    if (rawTag === undefined) continue; // comment
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (skip) { skip--; continue; }
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (skip || !TAGS.has(tag) || ++count > MAX_NODES) { if (!selfClose) skip++; continue; }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      const name = a[1].toLowerCase() === 'viewbox' ? 'viewBox' : a[1];
      if (ATTRS.has(name) && !BAD_VALUE.test(a[2])) attrs[name] = decode(a[2]);
    }
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClose) stack.push(node);
  }
  const svg = root.children[0];
  return svg && svg.tag === 'svg' && typeof svg === 'object' ? svg : null;
}
