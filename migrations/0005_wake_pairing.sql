-- Ephemeral user-authorized Wake pairing. The bearer webhook credential itself is
-- never stored in this table; only WakeRegistration's encrypted target holds it.
CREATE TABLE wake_pairing_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_address_id TEXT NOT NULL UNIQUE,
  link_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  oauth_state_digest TEXT,
  oauth_client_id TEXT,
  oauth_started_at TEXT,
  session_digest TEXT,
  session_expires_at TEXT,
  consumed_at TEXT
);

CREATE INDEX idx_wake_pairing_expiry ON wake_pairing_requests(expires_at);
