CREATE TABLE IF NOT EXISTS recipe_versions (
  owner TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  code TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  source_run_id TEXT,
  visibility TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, recipe_name, recipe_version),
  UNIQUE (owner, recipe_name, recipe_digest)
);

INSERT OR IGNORE INTO recipe_versions (
  owner,
  recipe_name,
  recipe_version,
  recipe_digest,
  description,
  input_schema_json,
  code,
  capabilities_json,
  source_run_id,
  visibility,
  tags_json,
  created_at
)
SELECT
  owner,
  name,
  version,
  recipe_digest,
  description,
  input_schema_json,
  code,
  capabilities_json,
  source_run_id,
  visibility,
  tags_json,
  created_at
FROM recipes
WHERE recipe_digest IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS recipe_versions_no_update
BEFORE UPDATE ON recipe_versions
BEGIN
  SELECT RAISE(ABORT, 'recipe versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS recipe_versions_no_delete
BEFORE DELETE ON recipe_versions
BEGIN
  SELECT RAISE(ABORT, 'recipe versions are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_recipe_versions_subject
  ON recipe_versions (owner, recipe_name, recipe_version DESC);
