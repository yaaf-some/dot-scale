// The inline scale status used on Home, Onboarding, Brew and Settings: dot + state + battery + the right buttons.
// Updates itself from scale events until ctx.signal aborts.
import { h } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';

export function scaleLine(ctx, { compact = false } = {}) {
  const { scale } = ctx;
  const el = h('div', { class: 'scale-line', role: 'group', 'aria-label': 'Scale' });
  const paint = () => {
    const s = scale.state;
    el.dataset.status = s.status;
    const busy = s.status === 'connecting' || s.status === 'reconnecting';
    const state = h('span', { class: 'scale-state', 'aria-live': 'polite' }, h('span', { class: 'status-dot' }),
      h('span', {}, s.status === 'connected' ? (s.mode === 'demo' ? 'Demo scale' : s.deviceName || 'Scale connected') : s.text),
      s.mode === 'demo' && s.status === 'connected' ? h('span', { class: 'demo-tag' }, 'demo') : null);
    const battery = s.status === 'connected' && s.battery != null ? h('span', { class: 'battery', title: 'Scale battery' }, icon('battery', { size: 18 }), `${s.battery}%`) : null;
    const buttons = [];
    if (s.status === 'connected') buttons.push(h('button', { class: 'btn quiet small', onclick: () => scale.disconnect() }, s.mode === 'demo' ? 'Stop demo' : 'Disconnect'));
    else {
      buttons.push(h('button', {
        class: `btn ${compact ? 'small' : ''} primary`, disabled: busy || !scale.supported,
        onclick: () => scale.connect().catch((e) => toast(e.message)),
      }, icon('bluetooth', { size: 18 }), busy ? 'Connecting…' : 'Connect scale'));
      buttons.push(h('button', { class: 'btn quiet small', disabled: busy, onclick: () => scale.startDemo() }, 'Try demo'));
    }
    el.replaceChildren(...[state, battery, ...buttons].filter(Boolean));
  };
  paint();
  for (const ev of ['status', 'battery', 'info']) scale.on(ev, paint, { signal: ctx.signal });
  return el;
}
