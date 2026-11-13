-- Additive V2 Gateway roster. Proposals are never active until the actual
-- recipient Runtime consents. An approved teammate references the office
-- Gateway's one verified Wake subscription without duplicating its credential.
CREATE TABLE gateway_teammates (
  org_id TEXT NOT NULL,
  gateway_session_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_canonical_address TEXT NOT NULL,
  recipient_bot_id TEXT NOT NULL,
  thread_mode TEXT NOT NULL CHECK (thread_mode IN ('explicit', 'platform')),
  first_contact_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (first_contact_mode IN ('manual', 'automatic')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  PRIMARY KEY (org_id, recipient_session_id),
  CHECK (gateway_session_id <> recipient_session_id),
  CHECK ((status = 'pending' AND approved_at IS NULL) OR
         (status = 'active' AND approved_at IS NOT NULL))
);

CREATE INDEX gateway_teammates_gateway
  ON gateway_teammates(org_id, gateway_session_id, status);
