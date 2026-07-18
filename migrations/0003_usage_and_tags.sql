ALTER TABLE recipes ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE recipes ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipes ADD COLUMN last_run_at TEXT;

CREATE INDEX IF NOT EXISTS idx_recipes_owner_usage ON recipes (owner, run_count DESC, last_run_at DESC);

CREATE TABLE IF NOT EXISTS recipe_usage_reports (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  reporter TEXT NOT NULL,
  version INTEGER NOT NULL,
  reported_at TEXT NOT NULL,
  UNIQUE (reporter, id)
);
CREATE INDEX IF NOT EXISTS idx_usage_recipe ON recipe_usage_reports (owner, recipe_name, reported_at DESC);
