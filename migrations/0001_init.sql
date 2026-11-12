CREATE TABLE agent_mailboxes (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL UNIQUE,
  mailbox_email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, agent_id)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'handoff')),
  sender_agent_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT,
  accepted_session_id TEXT,
  notification_session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX threads_sender_session ON threads(sender_session_id, created_at);
CREATE INDEX threads_recipient_session ON threads(recipient_session_id, created_at);
CREATE INDEX threads_recipient_agent ON threads(recipient_agent_id, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'handoff', 'reply', 'acceptance')),
  sender_agent_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  sender_canonical_address TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  external_delivery_id TEXT,
  received_at TEXT,
  receipt_source TEXT CHECK (receipt_source IN ('webhook', 'archive')),
  archive_checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX messages_thread ON messages(thread_id, created_at);
CREATE INDEX messages_recipient_session ON messages(recipient_session_id, delivery_status, created_at);
CREATE INDEX messages_archive_scan ON messages(delivery_status, received_at, archive_checked_at);

CREATE TABLE agent_aliases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  verified_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX agent_alias_active ON agent_aliases(org_id, provider, external_id)
  WHERE revoked_at IS NULL;
CREATE INDEX agent_alias_owner ON agent_aliases(org_id, session_id);

CREATE TABLE wake_subscriptions (
  session_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  encrypted_target TEXT,
  auth_mode TEXT NOT NULL DEFAULT 'hmac'
);

CREATE TABLE wake_events (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  session_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  next_attempt_at TEXT NOT NULL,
  notified_at TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_until TEXT
);

CREATE INDEX wake_events_due ON wake_events(status, next_attempt_at);

CREATE TABLE wake_registration_attempts (
  session_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('hmac', 'bearer', 'capability')),
  encrypted_target TEXT NOT NULL,
  verification_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE message_read_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, session_id)
);

CREATE INDEX message_read_receipts_session ON message_read_receipts(session_id, read_at);

CREATE TABLE wake_pairing_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
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

CREATE INDEX wake_pairing_expiry ON wake_pairing_requests(expires_at);

CREATE TABLE wake_pairing_oauth_attempts (
  state_digest TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX wake_pairing_oauth_pair ON wake_pairing_oauth_attempts(pairing_id);
CREATE INDEX wake_pairing_oauth_start ON wake_pairing_oauth_attempts(started_at);

CREATE TABLE gateway_routes (
  org_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_canonical_address TEXT NOT NULL,
  recipient_bot_id TEXT NOT NULL,
  thread_mode TEXT NOT NULL CHECK (thread_mode IN ('explicit', 'platform')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, recipient_session_id)
);

CREATE TABLE gateway_conversations (
  org_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, sender_session_id, recipient_session_id),
  FOREIGN KEY (org_id, recipient_session_id)
    REFERENCES gateway_routes(org_id, recipient_session_id) ON DELETE CASCADE
);

CREATE INDEX gateway_conversations_recipient
  ON gateway_conversations(org_id, recipient_session_id);
