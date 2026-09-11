CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_access_subject TEXT NOT NULL,
  display_email_normalized TEXT,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'reviewer', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  token_verifier TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  accepted_at TEXT,
  accepted_by_actor_id TEXT REFERENCES actors(id),
  revoked_at TEXT,
  revoked_by_actor_id TEXT REFERENCES actors(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_one_pending_role
  ON workspace_invitations (workspace_id, target_access_subject, role)
  WHERE status = 'pending';

ALTER TABLE agent_identities ADD COLUMN actor_id TEXT REFERENCES actors(id);
ALTER TABLE agent_identities ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE agent_identities ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE agent_identities ADD COLUMN revoked_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE agent_identities ADD COLUMN revocation_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_identities_workspace_actor_unique
  ON agent_identities (workspace_id, actor_id)
  WHERE workspace_id IS NOT NULL AND actor_id IS NOT NULL;

ALTER TABLE agent_credentials ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE agent_credentials ADD COLUMN expires_at TEXT;
ALTER TABLE agent_credentials ADD COLUMN created_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE agent_credentials ADD COLUMN revoked_by_actor_id TEXT REFERENCES actors(id);
ALTER TABLE agent_credentials ADD COLUMN revocation_reason TEXT;
ALTER TABLE agent_credentials ADD COLUMN replaces_credential_id TEXT REFERENCES agent_credentials(id);
ALTER TABLE agent_credentials ADD COLUMN replaced_by_credential_id TEXT REFERENCES agent_credentials(id);
ALTER TABLE agent_credentials ADD COLUMN hash_scheme TEXT NOT NULL DEFAULT 'sha256-v1';

CREATE INDEX IF NOT EXISTS agent_credentials_workspace_active_lookup
  ON agent_credentials (workspace_id, credential_hash, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS agent_credential_folder_allowlists (
  credential_id TEXT NOT NULL REFERENCES agent_credentials(id),
  folder_id TEXT NOT NULL REFERENCES folders(id),
  created_at TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  revoked_at TEXT,
  revoked_by_actor_id TEXT REFERENCES actors(id),
  PRIMARY KEY (credential_id, folder_id)
);
