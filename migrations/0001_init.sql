CREATE TABLE paired_hosts (
  org_id TEXT NOT NULL,
  host_address_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  mailbox_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, host_address_id)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'handoff')),
  sender_host_id TEXT NOT NULL,
  sender_work_id TEXT NOT NULL,
  recipient_host_id TEXT NOT NULL,
  recipient_work_id TEXT,
  accepted_work_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX threads_sender_index ON threads(sender_work_id, created_at);
CREATE INDEX threads_recipient_index ON threads(recipient_work_id, created_at);
CREATE INDEX threads_host_index ON threads(recipient_host_id, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'handoff', 'reply', 'acceptance')),
  sender_host_id TEXT NOT NULL,
  sender_work_id TEXT NOT NULL,
  recipient_host_id TEXT NOT NULL,
  recipient_work_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  external_delivery_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX messages_thread_index ON messages(thread_id, created_at);
CREATE INDEX messages_recipient_index ON messages(recipient_work_id, delivery_status, created_at);

CREATE TABLE agent_aliases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_address_id TEXT NOT NULL,
  canonical_address TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  verified_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX agent_aliases_active_unique
  ON agent_aliases(org_id, provider, external_id)
  WHERE revoked_at IS NULL;

CREATE INDEX agent_aliases_owner_index ON agent_aliases(org_id, work_address_id);
