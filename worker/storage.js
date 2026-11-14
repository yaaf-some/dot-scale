// The ONLY file that knows about the database. Everything else talks to this small interface:
//
//   gate(hash, ipKey, ipWindow)            -> { ipFails, rev | null }     (rev null = no such household)
//   createHousehold(hash, now)             -> boolean
//   hit(key, window, expiresAt)            -> count after incrementing    (fixed-window rate limit)
//   purgeExpired(now)                      -> void
//   recordCount(hash)                      -> number
//   existingIds(hash, ids)                 -> Set<string>
//   merge(hash, records)                   -> { rev, own: string[], restamped: string[] }
//   changesSince(hash, since, limit, skip) -> [{ id, rev, body }] ordered by rev; skip = [fromRev, toRev] excluded
//
// To move to another database, reimplement these 8 functions. Cloudflare D1 (SQLite) is used because its writes are
// strongly consistent and serialised, which a strictly increasing `rev` needs (Workers KV is eventually consistent).
//
// D1 limits this code is written around (check current values at developers.cloudflare.com/d1/platform/limits):
// 100 bound parameters per statement, and a per-invocation query budget (50 on the Workers Free plan). Hence the
// per-request cap on records (see LIMITS.maxChangesPerRequest) and the few statements per request.

const IN_CHUNK = 90;

export function createD1Storage(db) {
  const stmt = (sql, ...params) => db.prepare(sql).bind(...params);
  const rows = async (s) => (await s.all()).results ?? [];

  return {
    async gate(hash, ipKey, ipWindow) {
      const [fails, hh] = await db.batch([
        stmt('SELECT count FROM rate_limits WHERE key = ? AND window = ?', ipKey, ipWindow),
        stmt('SELECT rev FROM households WHERE hash = ?', hash),
      ]);
      return { ipFails: fails.results[0]?.count ?? 0, rev: hh.results[0] ? hh.results[0].rev : null };
    },

    async createHousehold(hash, now) {
      const r = await stmt('INSERT OR IGNORE INTO households (hash, created_at, rev) VALUES (?, ?, 0)', hash, now).run();
      return r.meta.changes === 1;
    },

    async hit(key, window, expiresAt) {
      const r = await rows(stmt(
        `INSERT INTO rate_limits (key, window, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window = excluded.window THEN rate_limits.count + 1 ELSE 1 END,
           window = excluded.window, expires_at = excluded.expires_at
         RETURNING count`, key, window, expiresAt));
      return r[0].count;
    },

    async purgeExpired(now) { await stmt('DELETE FROM rate_limits WHERE expires_at < ?', now).run(); },

    async recordCount(hash) { return (await stmt('SELECT COUNT(*) AS n FROM records WHERE household_hash = ?', hash).first()).n; },

    async existingIds(hash, ids) {
      const found = new Set();
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const part = ids.slice(i, i + IN_CHUNK);
        for (const r of await rows(stmt(`SELECT id FROM records WHERE household_hash = ? AND id IN (${part.map(() => '?').join(',')})`, hash, ...part))) found.add(r.id);
      }
      return found;
    },

    /**
     * Atomically (one D1 batch = one transaction): reserve 2n revs, upsert each record if it beats the stored one
     * (last-writer-wins on updated_at, ties by canonical body), and re-stamp the stored copy of any record that
     * *beat* the pushed one so the pusher pulls the winner. `records`: [{ id, type, updatedAt, deleted, body }].
     * Winners get revs base+1..base+n, re-stamped losers base+n+1..base+2n (so the two are told apart afterwards).
     */
    async merge(hash, records) {
      const n = records.length;
      const revNow = '(SELECT rev FROM households WHERE hash = ?)';
      const batch = [stmt('UPDATE households SET rev = rev + ? WHERE hash = ? RETURNING rev', 2 * n, hash)];
      records.forEach((r, i) => {
        batch.push(stmt(
          `INSERT INTO records (household_hash, id, type, updated_at, rev, deleted, body)
           VALUES (?, ?, ?, ?, ${revNow} - ?, ?, ?)
           ON CONFLICT(household_hash, id) DO UPDATE SET
             type = excluded.type, updated_at = excluded.updated_at, rev = excluded.rev,
             deleted = excluded.deleted, body = excluded.body
           WHERE excluded.updated_at > records.updated_at
              OR (excluded.updated_at = records.updated_at AND excluded.body > records.body)`,
          hash, r.id, r.type, r.updatedAt, hash, 2 * n - 1 - i, r.deleted ? 1 : 0, r.body));
      });
      records.forEach((r, i) => {
        batch.push(stmt(
          `UPDATE records SET rev = ${revNow} - ?
           WHERE household_hash = ? AND id = ?
             AND (updated_at > ? OR (updated_at = ? AND body > ?))`,
          hash, n - 1 - i, hash, r.id, r.updatedAt, r.updatedAt, r.body));
      });
      batch.push(stmt(
        `SELECT id, rev FROM records WHERE household_hash = ? AND rev > ${revNow} - ? ORDER BY rev`, hash, hash, 2 * n));
      const results = await db.batch(batch);
      const rev = results[0].results[0].rev;
      const base = rev - 2 * n;
      const touched = results[results.length - 1].results;
      return {
        rev,
        own: touched.filter((r) => r.rev <= base + n).map((r) => r.id),
        restamped: touched.filter((r) => r.rev > base + n).map((r) => r.id),
      };
    },

    async changesSince(hash, since, limit, skip = [0, 0]) {
      return rows(stmt(
        `SELECT id, rev, body FROM records
         WHERE household_hash = ? AND rev > ? AND NOT (rev > ? AND rev <= ?)
         ORDER BY rev LIMIT ?`, hash, since, skip[0], skip[1], limit));
    },
  };
}
