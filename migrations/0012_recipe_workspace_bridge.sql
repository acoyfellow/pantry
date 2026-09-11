ALTER TABLE recipes ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE recipes ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE recipes ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE recipes ADD COLUMN updated_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE recipes ADD COLUMN legacy_owner TEXT;
ALTER TABLE recipes ADD COLUMN workspace_recipe_key TEXT;
ALTER TABLE recipes ADD COLUMN archived_at TEXT;
ALTER TABLE recipes ADD COLUMN archived_by_actor_id TEXT REFERENCES actors(id);

CREATE UNIQUE INDEX IF NOT EXISTS recipes_workspace_key_unique
  ON recipes (workspace_id, workspace_recipe_key)
  WHERE workspace_id IS NOT NULL AND workspace_recipe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS recipes_workspace_folder_updated
  ON recipes (workspace_id, folder_id, archived_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS recipes_workspace_legacy_coordinate
  ON recipes (workspace_id, legacy_owner, name);

CREATE TABLE IF NOT EXISTS recipe_version_workspace_bindings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  recipe_id TEXT NOT NULL,
  legacy_owner TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT,
  bound_at TEXT NOT NULL,
  bound_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  migration_manifest_id TEXT,
  PRIMARY KEY (legacy_owner, recipe_name, recipe_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS recipe_version_workspace_bindings_workspace_recipe_version
  ON recipe_version_workspace_bindings (workspace_id, recipe_id, recipe_version);

CREATE TABLE IF NOT EXISTS recipe_aliases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  alias TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('legacy', 'collision', 'display')),
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS recipe_aliases_one_active_workspace_alias
  ON recipe_aliases (workspace_id, alias)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS migration_subject_map (
  id TEXT PRIMARY KEY,
  migration_manifest_id TEXT NOT NULL,
  legacy_recipe_id TEXT NOT NULL,
  legacy_owner TEXT NOT NULL,
  legacy_name TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  recipe_id TEXT,
  workspace_recipe_key TEXT,
  folder_id TEXT REFERENCES folders(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'mapped', 'collision', 'unmapped', 'failed')),
  detail_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (migration_manifest_id, legacy_recipe_id),
  UNIQUE (migration_manifest_id, legacy_owner, legacy_name)
);
