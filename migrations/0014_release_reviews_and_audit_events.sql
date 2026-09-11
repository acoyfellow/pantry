CREATE TABLE IF NOT EXISTS recipe_release_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  recipe_digest TEXT,
  input_schema_digest TEXT NOT NULL,
  capabilities_digest TEXT NOT NULL,
  distribution_digest TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'request-revision')),
  reason TEXT,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  access_subject_snapshot TEXT,
  created_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  migration_manifest_id TEXT
);

CREATE INDEX IF NOT EXISTS recipe_release_reviews_lookup
  ON recipe_release_reviews (workspace_id, recipe_id, recipe_version, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS recipe_release_reviews_one_terminal_decision
  ON recipe_release_reviews (recipe_id, recipe_version, recipe_digest, distribution_digest)
  WHERE action IN ('approve', 'reject');

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  workspace_id TEXT REFERENCES workspaces(id),
  folder_id TEXT REFERENCES folders(id),
  recipe_id TEXT,
  recipe_version INTEGER,
  recipe_digest TEXT,
  actor_id TEXT REFERENCES actors(id),
  actor_kind TEXT CHECK (actor_kind IN ('human', 'agent', 'system')),
  access_subject_snapshot TEXT,
  credential_id TEXT REFERENCES agent_credentials(id),
  authorization_policy_version TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  metadata_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_occurred
  ON audit_events (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_actor_occurred
  ON audit_events (actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_recipe_occurred
  ON audit_events (recipe_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_request
  ON audit_events (request_id);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
