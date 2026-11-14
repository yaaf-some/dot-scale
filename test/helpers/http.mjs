// Tiny fake Node/Vercel request & response objects for calling handlers directly.
export function makeReq({ method = 'POST', headers = {}, body, ip = '203.0.113.7' } = {}) {
  const h = Object.fromEntries(Object.entries({ 'x-real-ip': ip, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, headers: h, body };
}

export function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s; this.ended = true; },
    get json() { return this.body ? JSON.parse(this.body) : undefined; },
  };
  return res;
}

export async function call(handler, reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

/** fetch() that routes /api/household and /api/sync to handlers, like Vercel would (JSON body pre-parsed). */
export function routeFetch({ household, sync, ip = '203.0.113.7', onRequest } = {}) {
  return async (url, init = {}) => {
    const path = new URL(url, 'https://app.example.test').pathname;
    const handler = path === '/api/household' ? household : path === '/api/sync' ? sync : null;
    if (!handler) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    onRequest?.(path, init);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = makeRes();
    await handler({ method: init.method || 'GET', headers: { 'x-real-ip': ip, ...headers, 'content-length': String(Buffer.byteLength(init.body || '')) }, body: init.body ? JSON.parse(init.body) : undefined }, res);
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  };
}
