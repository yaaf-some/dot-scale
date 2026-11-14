// Minimal DOM helpers. No innerHTML with user data anywhere: build nodes with h() so names and notes can't inject markup.

/** h('button', { class: 'btn', onclick: fn, 'aria-label': 'x', disabled: true }, 'Label', childNode) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) (p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val)); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'object' && !k.startsWith('aria-') && !k.startsWith('data-') && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children. */
export function setChildren(el, ...children) { el.replaceChildren(); return append(el, children); }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmtG = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, '') : '–');
export const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
