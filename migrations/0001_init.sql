-- Dot Scale household sync (D1 / SQLite). Apply with: npx wrangler d1 migrations apply dot-scale --remote
-- Nothing here stores a household code: `hash` is an HMAC of it.

CREATE TABLE households (
  hash       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0   -- per-household counter; strictly increasing
) WITHOUT ROWID;

-- One row per record. `body` is the canonical JSON of the record (tombstones: envelope only).
CREATE TABLE records (
  household_hash TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  updated_at     INTEGER NOT NULL,
  rev            INTEGER NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  body           TEXT    NOT NULL,
  PRIMARY KEY (household_hash, id)
) WITHOUT ROWID;

CREATE INDEX records_by_rev ON records (household_hash, rev);

-- Fixed-window counters: one row per key (household hash, or hashed caller IP), reused window after window.
CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,
  window     INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
