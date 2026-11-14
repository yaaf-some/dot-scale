// Builds a card's diagram as SVG nodes (createElementNS only). See app/learn/svg.js for what is allowed.
import { parseDiagram } from '../../learn/svg.js';

const NS = 'http://www.w3.org/2000/svg';

function build(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  const el = document.createElementNS(NS, node.tag);
  for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, v);
  for (const c of node.children) el.append(build(c));
  return el;
}

/** → an <svg> element, or null when the card has no (safe) diagram. */
export function diagramNode(src) {
  const tree = parseDiagram(src);
  if (!tree) return null;
  const el = build(tree);
  el.classList.add('diagram');
  return el;
}
