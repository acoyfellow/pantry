-- G5 recipe snapshot attestations. Existing rows intentionally retain NULL: Pantry
-- cannot attest them until a fresh push computes a canonical snapshot digest.
ALTER TABLE recipes ADD COLUMN recipe_digest TEXT;

CREATE TABLE IF NOT EXISTS recipe_attestations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT NOT NULL,
  witness_receipt_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256)
);

CREATE INDEX IF NOT EXISTS idx_recipe_attestations_subject
  ON recipe_attestations (owner, recipe_name, recipe_version, recipe_digest);
