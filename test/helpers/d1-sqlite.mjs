// A stand-in for a Cloudflare D1 binding, backed by an in-memory SQLite (node:sqlite: the same SQL engine D1 uses).
// It applies the real migrations/*.sql, so tests exercise the real schema and the real SQL in worker/storage.js.
// It mimics the D1 API surface used by the adapter (prepare/bind/first/all/run, batch as one transaction) and a few
// D1 limits, so code that would break on D1 breaks here: no `undefined` binds, <= 100 bound parameters per statement.
// It is NOT D1: it doesn't model D1's network, latency, replication, quotas or error messages.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const plain = (row) => ({ ...row });

export function createD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));

  const d1 = { queries: 0, log: [], failNext: false, raw: db };

  function execute(sql, params) {
    if (d1.failNext) throw new Error('simulated D1 outage');
    d1.queries++;
    d1.log.push(sql);
    if (params.length > 100) throw new Error('D1_ERROR: too many SQL variables (limit is 100)');
    if (params.some((p) => p === undefined)) throw new Error('D1_TYPE_ERROR: Type undefined not supported');
    const s = db.prepare(sql);
    if (s.columns().length) return { results: s.all(...params).map(plain), success: true, meta: { changes: 0 } };
    const info = s.run(...params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }

  function prepare(sql) {
    let params = [];
    const st = {
      sql,
      bind(...p) { params = p; return st; },
      async first(col) { const r = execute(sql, params).results[0] ?? null; return col && r ? r[col] : r; },
      async all() { return execute(sql, params); },
      async run() { return execute(sql, params); },
      _run: () => execute(sql, params),
    };
    return st;
  }

  d1.prepare = prepare;
  d1.batch = async (stmts) => { // one transaction: all or nothing
    db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._run());
      db.exec('COMMIT');
      return out;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  /** Test helper: run SQL directly (not through the adapter). */
  d1.sql = (query, ...params) => db.prepare(query).all(...params).map(plain);
  return d1;
}
