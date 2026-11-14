// POST /api/sync: merge pushed records (last-writer-wins) and return what changed. See api/_lib/handlers.js.
import { createSyncHandler } from './_lib/handlers.js';

export default createSyncHandler();
