CREATE TABLE agent_mailboxes (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  mailbox_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id),
  UNIQUE (mailbox_id),
  UNIQUE (mailbox_email)
);
