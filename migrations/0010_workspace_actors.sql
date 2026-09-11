CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  access_subject TEXT,
  display_email_normalized TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by_actor_id TEXT REFERENCES actors(id),
  CHECK ((kind = 'human' AND access_subject IS NOT NULL) OR kind <> 'human')
);

CREATE UNIQUE INDEX IF NOT EXISTS actors_human_access_subject_unique
  ON actors (access_subject)
  WHERE kind = 'human' AND access_subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS actors_display_email
  ON actors (display_email_normalized);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'employee'),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  role TEXT NOT NULL CHECK (role IN ('reader', 'contributor', 'reviewer', 'admin')),
  source TEXT NOT NULL CHECK (source IN ('access-default', 'admin-grant', 'access-group')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES actors(id),
  revoked_at TEXT,
  revoked_by_actor_id TEXT REFERENCES actors(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_memberships_one_active
  ON workspace_memberships (workspace_id, actor_id)
  WHERE valid_until IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_memberships_active_resolution
  ON workspace_memberships (workspace_id, actor_id, valid_from, valid_until, revoked_at);
