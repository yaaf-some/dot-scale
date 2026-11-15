// Registers the history-aware Home nudge (see app/journal/nudge.js). Imported from app/modules.js.
// The nudge code pulls in the insights engine, so it loads on demand and only when there is a brew to learn from.
import { registerNudge } from './nudges.js';

let loaded = null;
const load = () => (loaded ??= import('../journal/nudge.js').catch((e) => { loaded = null; throw e; })); // a failed load may be retried

// Above the shell's own bean-age (40) and Bluetooth (50) notes, below the storage warning (90).
registerNudge(60, (data) => (data.brews?.length ? load().then((m) => m.journalNudge(data)) : null));
