-- pantry recipe store.
-- A recipe is stored and handed back verbatim; pantry never executes it.
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  code TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  version INTEGER NOT NULL DEFAULT 1,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One name per owner. Upserts bump version in place; no cross-owner collisions.
CREATE UNIQUE INDEX IF NOT EXISTS recipes_owner_name ON recipes (owner, name);
CREATE INDEX IF NOT EXISTS recipes_owner_updated ON recipes (owner, updated_at DESC);
