// Dialogs on the native <dialog> element (showModal gives focus containment, Esc, inert page, top layer).
// WebKit has had showModal since 15.4; if it's missing we fall back to an `open` dialog styled as a sheet.
// `closedby="any"` isn't in Safari, so click-outside is implemented by hand.
import { h, setChildren } from './dom.js';

let seq = 0;

function wire(dlg, resolve) {
  document.body.append(dlg);
  const finish = () => { dlg.remove(); resolve(dlg.returnValue || null); };
  dlg.addEventListener('close', finish, { once: true });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(''); });
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else {
    dlg.close = (v = '') => { dlg.returnValue = v; dlg.removeAttribute('open'); dlg.dispatchEvent(new Event('close')); };
    dlg.setAttribute('open', '');
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') dlg.close(''); });
  }
}

/** Generic modal. `actions`: [{ label, value, kind: 'primary'|'danger'|'quiet' }]. Resolves to the chosen value, or null if dismissed. */
export function openDialog({ title, body, actions = [{ label: 'Close', value: 'close', kind: 'quiet' }] }) {
  const id = `dlg-${++seq}`;
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': id },
      h('form', { method: 'dialog', class: 'sheet-inner' },
        h('h2', { id, class: 'sheet-title' }, title),
        body ? h('div', { class: 'sheet-body' }, body) : null,
        h('div', { class: 'sheet-actions' }, actions.map((a) =>
          h('button', { class: `btn ${a.kind ?? 'secondary'}`, value: a.value, type: 'submit', formnovalidate: a.value === 'cancel' || undefined }, a.label)))));
    wire(dlg, resolve);
  });
}

export async function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  const v = await openDialog({
    title, body: h('p', { class: 'sheet-text' }, message),
    actions: [{ label: 'Cancel', value: 'cancel', kind: 'quiet' }, { label: confirmLabel, value: 'yes', kind: danger ? 'danger' : 'primary' }],
  });
  return v === 'yes';
}

/** One form control from a field spec. Returns { el, read() }. */
function control(f, value) {
  const id = `f-${++seq}`;
  const label = h('label', { class: 'field-label', for: id }, f.label);
  const hint = f.hint ? h('p', { class: 'field-hint' }, f.hint) : null;
  let input, read;
  switch (f.type) {
    case 'textarea':
      input = h('textarea', { id, rows: f.rows ?? 3, placeholder: f.placeholder, maxlength: f.maxlength }, value ?? '');
      read = () => input.value.trim(); break;
    case 'select':
      input = h('select', { id }, f.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
      read = () => input.value; break;
    case 'choice':
    case 'multi': {
      const multi = f.type === 'multi';
      const name = `n-${id}`;
      const set = new Set(multi ? value ?? [] : []);
      const group = h('div', { class: `chip-group ${f.swatch ? 'swatches' : ''}`, role: multi ? 'group' : 'radiogroup', 'aria-label': f.label },
        f.options.map((o) => h('label', { class: 'chip-choice', style: f.swatch ? { '--swatch': o.value } : undefined },
          h('input', { type: multi ? 'checkbox' : 'radio', name, value: o.value, checked: multi ? set.has(o.value) : o.value === value }),
          h('span', {}, f.swatch ? h('span', { class: 'sr-only' }, o.label) : o.label))));
      const wrap = h('div', { class: 'field' }, h('p', { class: 'field-label' }, f.label), group, hint);
      return { el: wrap, read: () => { const on = [...group.querySelectorAll('input:checked')].map((i) => i.value); return multi ? on : on[0]; } };
    }
    default:
      input = h('input', {
        id, type: f.type ?? 'text', value: value ?? '', placeholder: f.placeholder, required: f.required, maxlength: f.maxlength,
        inputMode: f.inputMode, step: f.step, min: f.min, autocomplete: 'off', autocapitalize: f.type === 'text' || !f.type ? 'words' : 'off',
      });
      read = () => (f.type === 'number' ? (input.value === '' ? undefined : Number(input.value)) : input.value.trim());
  }
  if (f.required && input) input.required = true;
  return { el: h('div', { class: 'field' }, label, input, hint), read };
}

/**
 * Form in a dialog. fields: [{ name, label, type: text|number|date|textarea|select|choice|multi, options, required, hint, swatch }].
 * Resolves to the values object, or null if cancelled. `onDelete` adds a Delete button that resolves to { __delete: true }.
 */
export function formDialog({ title, fields, values = {}, submitLabel = 'Save', deletable = false, note }) {
  const id = `dlg-${++seq}`;
  const controls = fields.map((f) => ({ f, ...control(f, values[f.name]) }));
  return new Promise((resolve) => {
    let result = null;
    const form = h('form', { class: 'sheet-inner', novalidate: true },
      h('h2', { id, class: 'sheet-title' }, title),
      h('div', { class: 'sheet-body' }, note ? h('p', { class: 'sheet-text' }, note) : null, controls.map((c) => c.el)),
      h('div', { class: 'sheet-actions' },
        deletable ? h('button', { type: 'button', class: 'btn danger quiet-left', onclick: () => { result = { __delete: true }; dlg.close('delete'); } }, 'Delete') : null,
        h('button', { type: 'button', class: 'btn quiet', onclick: () => dlg.close('') }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, submitLabel)));
    const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': id }, form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      result = Object.fromEntries(controls.map((c) => [c.f.name, c.read()]));
      dlg.close('ok');
    });
    wire(dlg, () => resolve(result));
  });
}

export { setChildren };
