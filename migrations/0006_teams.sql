CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'approver', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, principal),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_principal ON team_members (principal);
