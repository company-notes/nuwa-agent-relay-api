-- An office Gateway owns its platform directory registration inside one Organization.
-- Reservation survives a partial Agent Address or MailTrigger operation so retry
-- can complete the same address without enrolling somebody else's Session.
CREATE TABLE gateway_office_coworkers (
  org_id TEXT NOT NULL,
  gateway_session_id TEXT NOT NULL,
  recipient_bot_id TEXT NOT NULL,
  agent_handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  recipient_agent_id TEXT,
  recipient_session_id TEXT,
  recipient_canonical_address TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  PRIMARY KEY (org_id, gateway_session_id, recipient_bot_id),
  UNIQUE (org_id, agent_handle),
  CHECK ((recipient_agent_id IS NULL AND recipient_session_id IS NULL
          AND recipient_canonical_address IS NULL) OR
         (recipient_agent_id IS NOT NULL AND recipient_session_id IS NOT NULL
          AND recipient_canonical_address IS NOT NULL))
);

CREATE INDEX gateway_office_coworkers_status
  ON gateway_office_coworkers(org_id, gateway_session_id, activated_at);
