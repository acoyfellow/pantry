CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id TEXT REFERENCES folders(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  archived_by_actor_id TEXT REFERENCES actors(id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_sibling_slug
  ON folders (workspace_id, COALESCE(parent_id, ''), slug);

CREATE INDEX IF NOT EXISTS folders_active_lookup
  ON folders (workspace_id, parent_id, archived_at, slug);

CREATE UNIQUE INDEX IF NOT EXISTS folders_one_root_per_workspace
  ON folders (workspace_id)
  WHERE parent_id IS NULL;

CREATE TRIGGER IF NOT EXISTS folders_no_cycle_on_insert
BEFORE INSERT ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM folders WHERE id = NEW.parent_id
      UNION ALL
      SELECT folders.id, folders.parent_id
      FROM folders
      JOIN ancestors ON folders.id = ancestors.parent_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'folder parent cycle') END;
END;

CREATE TRIGGER IF NOT EXISTS folders_no_cycle_on_parent_update
BEFORE UPDATE OF parent_id ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM folders WHERE id = NEW.parent_id
      UNION ALL
      SELECT folders.id, folders.parent_id
      FROM folders
      JOIN ancestors ON folders.id = ancestors.parent_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'folder parent cycle') END;
END;

CREATE TABLE IF NOT EXISTS folder_permissions (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  subject_actor_id TEXT NOT NULL REFERENCES actors(id),
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'review', 'admin')),
  granted_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_actor_id TEXT REFERENCES actors(id),
  revocation_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS folder_permissions_one_active_grant
  ON folder_permissions (folder_id, subject_actor_id, permission)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS folder_permissions_authorization
  ON folder_permissions (folder_id, subject_actor_id, revoked_at, permission);
