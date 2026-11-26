CREATE TABLE collaboration_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  grant_fingerprint TEXT NOT NULL,
  mode INTEGER CHECK (mode IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, agent_id, grant_fingerprint)
);

CREATE TABLE collaboration_owner_sessions (
  token_digest TEXT PRIMARY KEY,
  cookie_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
