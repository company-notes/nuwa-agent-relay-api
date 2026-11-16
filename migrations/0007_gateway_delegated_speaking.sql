-- One office may explicitly permit its Gateway to submit messages on behalf of
-- registered coworkers. Existing deployments remain disabled until opt-in.
CREATE TABLE gateway_office_delegation (
  org_id TEXT NOT NULL,
  gateway_session_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, gateway_session_id)
);

-- Nullable credentials preserve the opt-in trust mode until a coworker opts in.
-- The plaintext is never stored. An enrolled passphrase is mandatory per send.
ALTER TABLE gateway_office_coworkers ADD COLUMN passphrase_salt TEXT;
ALTER TABLE gateway_office_coworkers ADD COLUMN passphrase_hash TEXT;

-- Actor and declared sender are different when the office delegates a send.
ALTER TABLE messages ADD COLUMN actor_session_id TEXT;
ALTER TABLE messages ADD COLUMN sender_auth_mode TEXT;
CREATE INDEX messages_actor_session ON messages(actor_session_id, created_at);
