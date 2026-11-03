-- Keep transport submission distinct from MailTrigger inbox arrival.
ALTER TABLE messages ADD COLUMN received_at TEXT;

CREATE TABLE wake_subscriptions (
  work_address_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE wake_events (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  work_address_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  next_attempt_at TEXT NOT NULL,
  notified_at TEXT,
  last_error TEXT
);

CREATE INDEX wake_events_due ON wake_events(status, next_attempt_at);
