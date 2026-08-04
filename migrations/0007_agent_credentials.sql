CREATE TABLE IF NOT EXISTS agent_identities (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_identities_team_principal ON agent_identities (team_id, principal);

CREATE TABLE IF NOT EXISTS agent_credentials (
  id TEXT PRIMARY KEY,
  agent_identity_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE CHECK (length(credential_hash) >= 64),
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_at TEXT,
  FOREIGN KEY (agent_identity_id) REFERENCES agent_identities(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_active_hash ON agent_credentials (credential_hash, revoked_at);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_team ON agent_credentials (team_id, revoked_at);
