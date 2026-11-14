// Shared test harness: a server (real handlers + real D1 adapter on in-memory SQLite) and ways to call it.
import { createD1 } from './d1-sqlite.mjs';
import { createD1Storage } from '../../worker/storage.js';
import { handleHousehold, handleSync } from '../../worker/handlers.js';

export const T0 = 1_700_000_000_000;
/** A fake pepper long enough for the server's minimum (never a real secret). */
export const TEST_PEPPER = 'example-pepper-for-tests-0123456789-abcdefghij';

export function makeServer({ limits, pepper = TEST_PEPPER } = {}) {
  const clock = { t: T0 };
  const d1 = createD1();
  const storage = createD1Storage(d1);
  const deps = () => ({ storage, now: () => clock.t, pepper, limits });
  return { clock, d1, storage, deps, household: (r) => handleHousehold(r, deps()), sync: (r) => handleSync(r, deps()) };
}

/** Build a Request like the Worker would receive and run it through a handler; returns { status, headers, json, text }. */
export async function call(handler, { method = 'POST', headers = {}, body, ip = '203.0.113.7', path = '/api/sync' } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (body !== undefined && method !== 'GET') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await handler(new Request(`https://coffee.example.test${path}`, init));
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
}

/** fetch() that routes /api/household and /api/sync to the server (404 plain text for anything else, like a static host). */
export function routeFetch(server, { ip = '203.0.113.7', onRequest } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url, 'https://app.example.test');
    onRequest?.(u.pathname, init);
    const handler = u.pathname === '/api/household' ? server.household : u.pathname === '/api/sync' ? server.sync : null;
    if (!handler) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return handler(new Request(u, { ...init, headers: { 'CF-Connecting-IP': ip, ...(init.headers || {}) } }));
  };
}
