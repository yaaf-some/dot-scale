// Journal: history by day (list), one brew (detail), compare two brews, and the dial-in trail per bean.
//   #/journal                      list      #/journal/brew/<id>              detail
//   #/journal/compare/<a>/<b>      compare   #/journal/bean/<id>?method=…     dial-in trail
// The pieces live in app/ui/journal/; they are imported statically so the offline warm-up caches them with this view.
import { ensureStyles } from '../journal/shared.js';
import * as list from '../journal/list.js';
import * as detail from '../journal/detail.js';
import * as compare from '../journal/compare.js';
import * as trail from '../journal/trail.js';

ensureStyles(); // starts loading journal.css as soon as the module is imported, so the offline warm-up in pwa.js caches it too

export const meta = { title: 'Journal' };

export async function mount(root, ctx) {
  await ensureStyles();
  const [sub, a, b] = ctx.params;
  if (sub === 'brew' && a) return detail.mount(root, ctx, a);
  if (sub === 'compare' && a && b) return compare.mount(root, ctx, a, b);
  if (sub === 'bean' && a) return trail.mount(root, ctx, a);
  return list.mount(root, ctx);
}
