// Registers the history-aware Home nudge (see app/journal/nudge.js). Imported from app/modules.js.
import { registerNudge } from './nudges.js';
import { journalNudge } from '../journal/nudge.js';

// Above the shell's own bean-age (40) and Bluetooth (50) notes, below the storage warning (90).
registerNudge(60, ({ brews, beans, now, dismissed }) => journalNudge({ brews, beans, now, dismissed }));
