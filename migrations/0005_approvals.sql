ALTER TABLE recipes ADD COLUMN approved_version INTEGER;
ALTER TABLE recipes ADD COLUMN approved_digest TEXT;

CREATE TABLE IF NOT EXISTS recipe_approval_receipts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  source_code TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_approval_recipe ON recipe_approval_receipts (owner, recipe_name, created_at DESC);
