// Cloudflare Worker entry. With `assets.run_worker_first: ["/api/*"]` (wrangler.jsonc) only /api/* requests reach
// this code; everything else is served straight from the static assets without invoking the Worker.
//
// Bindings (wrangler.jsonc): DB (D1), ASSETS (static assets). Optional secret: SYNC_PEPPER.

import { handleHousehold, handleSync } from './handlers.js';
import { createD1Storage } from './storage.js';

const notFound = () => new Response(JSON.stringify({ error: 'not_found', message: 'No such API endpoint.' }), {
  status: 404,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const deps = { storage: env.DB ? createD1Storage(env.DB) : null, pepper: env.SYNC_PEPPER || '' };
    if (pathname === '/api/household') return handleHousehold(request, deps);
    if (pathname === '/api/sync') return handleSync(request, deps);
    if (pathname.startsWith('/api/')) return notFound();
    return env.ASSETS ? env.ASSETS.fetch(request) : notFound(); // only reached if run_worker_first is widened
  },
};
