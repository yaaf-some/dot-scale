// Minimal Upstash Redis REST client built on fetch (no npm dependencies).
// Docs: POST <url> with a JSON command array; POST <url>/pipeline with an array of commands.
// Responses are { result } or { error } (an array of those for a pipeline).
// Never put the URL/token in an error message or a log line.

export class RedisError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RedisError';
    this.status = status;
  }
}

/** Read the Upstash credentials from either naming scheme. Returns null if not configured. */
export function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export function createRedis({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  async function call(path, body) {
    let res;
    try {
      res = await fetchImpl(url + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RedisError('Could not reach Redis', 0);
    }
    let data;
    try { data = await res.json(); } catch { throw new RedisError('Redis returned a non-JSON response', res.status); }
    if (!res.ok) throw new RedisError(`Redis request failed (${res.status})`, res.status);
    return data;
  }

  const unwrap = (item) => {
    if (item && item.error) throw new RedisError(`Redis command failed: ${String(item.error).slice(0, 120)}`, 200);
    return item ? item.result : null;
  };

  return {
    /** Run one command, e.g. command(['GET', key]). */
    async command(args) { return unwrap(await call('', args)); },
    /** Run commands in order in one round trip (not atomic). Results are in the same order. */
    async pipeline(commands) {
      if (!commands.length) return [];
      const data = await call('/pipeline', commands);
      if (!Array.isArray(data)) throw new RedisError('Unexpected pipeline response', 200);
      return data.map(unwrap);
    },
  };
}
