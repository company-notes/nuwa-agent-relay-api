-- Account-owned Agent reset transactions preserve a retryable plan across
-- external MailTrigger, MCP, Relay and Agent Address cleanup stages.
CREATE TABLE management_agent_resets (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepared', 'relay_cleared', 'completed')),
  purged_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (org_id, agent_id)
);

CREATE INDEX management_agent_resets_incomplete
  ON management_agent_resets(org_id, stage)
  WHERE completed_at IS NULL;
