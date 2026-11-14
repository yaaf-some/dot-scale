// In-memory fake of the Upstash Redis REST API (just the commands api/ uses).
// Unknown commands return an error so the API can't silently depend on something the fake doesn't model.
export function createFakeUpstash({ token = 'test-token', url = 'https://fake-redis.example.test', now = () => Date.now() } = {}) {
  const data = new Map();      // key -> string | Map (hash) | Map member->score (zset)
  const expiry = new Map();    // key -> ms epoch
  const log = [];              // every command executed, for assertions
  const state = { fail: false, requestBytes: [] };

  const alive = (k) => {
    if (expiry.has(k) && expiry.get(k) <= now()) { data.delete(k); expiry.delete(k); }
    return data.has(k);
  };
  const need = (k, make) => { if (!alive(k)) data.set(k, make()); return data.get(k); };

  function exec(cmd) {
    const [name, ...a] = cmd;
    log.push(cmd);
    switch (String(name).toUpperCase()) {
      case 'GET': return alive(a[0]) ? data.get(a[0]) : null;
      case 'EXISTS': return a.filter(alive).length;
      case 'DEL': { let n = 0; for (const k of a) if (alive(k)) { data.delete(k); expiry.delete(k); n++; } return n; }
      case 'SET': {
        const [k, v, ...opts] = a;
        let nx = false, ttl = null;
        for (let i = 0; i < opts.length; i++) {
          const o = String(opts[i]).toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'EX') ttl = Number(opts[++i]) * 1000;
          else if (o === 'PX') ttl = Number(opts[++i]);
          else throw new Error('ERR syntax error');
        }
        if (nx && alive(k)) return null;
        data.set(k, String(v)); expiry.delete(k);
        if (ttl) expiry.set(k, now() + ttl);
        return 'OK';
      }
      case 'INCR': case 'INCRBY': {
        const by = cmd[0].toUpperCase() === 'INCR' ? 1 : Number(a[1]);
        const cur = alive(a[0]) ? Number(data.get(a[0])) : 0;
        data.set(a[0], String(cur + by));
        return cur + by;
      }
      case 'HSET': {
        const h = need(a[0], () => new Map()); let added = 0;
        for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) added++; h.set(a[i], String(a[i + 1])); }
        return added;
      }
      case 'HMGET': { const h = alive(a[0]) ? data.get(a[0]) : new Map(); return a.slice(1).map((f) => (h.has(f) ? h.get(f) : null)); }
      case 'HLEN': return alive(a[0]) ? data.get(a[0]).size : 0;
      case 'ZADD': {
        const z = need(a[0], () => new Map()); let added = 0;
        for (let i = 1; i < a.length; i += 2) { if (!z.has(a[i + 1])) added++; z.set(a[i + 1], Number(a[i])); }
        return added;
      }
      case 'ZRANGEBYSCORE': {
        const [k, min, max, ...opts] = a;
        const bound = (s, lo) => {
          const str = String(s); const ex = str.startsWith('('); const v = str.replace('(', '');
          const n = v === '+inf' ? Infinity : v === '-inf' ? -Infinity : Number(v);
          return (x) => (lo ? (ex ? x > n : x >= n) : (ex ? x < n : x <= n));
        };
        const lo = bound(min, true), hi = bound(max, false);
        let withScores = false, off = 0, cnt = Infinity;
        for (let i = 0; i < opts.length; i++) {
          const o = String(opts[i]).toUpperCase();
          if (o === 'WITHSCORES') withScores = true;
          else if (o === 'LIMIT') { off = Number(opts[++i]); cnt = Number(opts[++i]); }
        }
        const z = alive(k) ? data.get(k) : new Map();
        const rows = [...z.entries()].filter(([, s]) => lo(s) && hi(s)).sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1)).slice(off, off + cnt);
        return withScores ? rows.flatMap(([m, s]) => [m, String(s)]) : rows.map(([m]) => m);
      }
      default: throw new Error(`ERR unknown command '${name}'`);
    }
  }

  const run = (cmd) => { try { return { result: exec(cmd) }; } catch (e) { return { error: e.message }; } };

  async function fetch(input, init = {}) {
    const u = String(input);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (state.fail) return json(500, { error: 'simulated outage' });
    if (!u.startsWith(url)) return json(404, { error: 'wrong host' });
    if (init.headers?.Authorization !== `Bearer ${token}`) return json(401, { error: 'Unauthorized' });
    state.requestBytes.push(Buffer.byteLength(init.body || ''));
    const path = u.slice(url.length);
    const body = JSON.parse(init.body);
    if (path === '') return json(200, run(body));
    if (path === '/pipeline') return json(200, body.map(run));
    return json(404, { error: 'unknown path' });
  }

  return {
    url, token, fetch, log, state,
    /** Every string stored anywhere (keys and values), for "does it contain the secret" checks. */
    dump() {
      const out = [];
      for (const [k, v] of data) {
        out.push(k);
        if (typeof v === 'string') out.push(v);
        else for (const [m, x] of v) out.push(m, String(x));
      }
      return out;
    },
    keys: () => [...data.keys()],
    /** Simulate data loss: drop keys matching the predicate. */
    wipe(pred) { for (const k of [...data.keys()]) if (pred(k)) { data.delete(k); expiry.delete(k); } },
  };
}
