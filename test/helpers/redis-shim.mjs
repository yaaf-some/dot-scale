// Speaks the Upstash REST protocol (POST / and /pipeline) in front of a real redis-server over TCP (RESP).
// Used only by the opt-in test/api-real-redis.test.mjs to check command semantics against real Redis.
// It is NOT Upstash: it does not exercise Upstash's HTTP layer, auth, quotas or limits.
import net from 'node:net';

export function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const waiting = [];
    sock.on('error', reject);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
    sock.on('connect', () => resolve({
      command(args) {
        return new Promise((res) => {
          waiting.push(res);
          const parts = args.map((a) => { const b = Buffer.from(String(a)); return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]); });
          sock.write(Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...parts]));
        });
      },
      close() { sock.destroy(); },
    }));

    function parse(b, o = 0) { // returns [value, nextOffset], or null if the buffer is incomplete
      const eol = b.indexOf('\r\n', o);
      if (eol < 0) return null;
      const t = String.fromCharCode(b[o]), line = b.toString('utf8', o + 1, eol), next = eol + 2;
      if (t === '+') return [line, next];
      if (t === '-') return [{ error: line }, next];
      if (t === ':') return [Number(line), next];
      if (t === '$') {
        const n = Number(line);
        if (n < 0) return [null, next];
        if (b.length < next + n + 2) return null;
        return [b.toString('utf8', next, next + n), next + n + 2];
      }
      if (t === '*') {
        const n = Number(line); const out = []; let p = next;
        for (let i = 0; i < n; i++) { const r = parse(b, p); if (!r) return null; out.push(r[0]); p = r[1]; }
        return [out, p];
      }
      throw new Error('bad RESP');
    }
    function drain() {
      for (;;) {
        const r = waiting.length ? parse(buf) : null;
        if (!r) return;
        buf = buf.subarray(r[1]);
        waiting.shift()(r[0]);
      }
    }
  });
}

/** fetch() stand-in for the Upstash REST API, backed by a real redis connection. */
export function shimFetch(conn, { url, token }) {
  const wrap = (r) => (r && typeof r === 'object' && !Array.isArray(r) && 'error' in r ? { error: r.error } : { result: r });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return async (input, init = {}) => {
    if (init.headers?.Authorization !== `Bearer ${token}`) return json(401, { error: 'Unauthorized' });
    const path = String(input).slice(url.length);
    const body = JSON.parse(init.body);
    if (path === '') return json(200, wrap(await conn.command(body)));
    if (path === '/pipeline') { const out = []; for (const c of body) out.push(wrap(await conn.command(c))); return json(200, out); }
    return json(404, { error: 'unknown path' });
  };
}
