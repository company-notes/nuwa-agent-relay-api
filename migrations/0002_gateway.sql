-- Additive V2 Gateway migration. Keep the deployed 0001 baseline intact.
-- Historical messages have no proven canonical sender; dispatch refuses empty values.
ALTER TABLE messages ADD COLUMN sender_canonical_address TEXT NOT NULL DEFAULT '';

CREATE TABLE gateway_routes (
  org_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_canonical_address TEXT NOT NULL,
  recipient_bot_id TEXT NOT NULL,
  thread_mode TEXT NOT NULL CHECK (thread_mode IN ('explicit', 'platform')),
  first_contact_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (first_contact_mode IN ('manual', 'automatic')),
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

CREATE TABLE gateway_first_contacts (
  org_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  initial_message_id TEXT NOT NULL REFERENCES messages(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  native_thread_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, sender_session_id, recipient_session_id),
  FOREIGN KEY (org_id, recipient_session_id)
    REFERENCES gateway_routes(org_id, recipient_session_id) ON DELETE CASCADE
);

CREATE INDEX gateway_first_contacts_recipient
  ON gateway_first_contacts(org_id, recipient_session_id, status);
