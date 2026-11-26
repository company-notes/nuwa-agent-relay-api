CREATE TABLE message_submissions (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  claimed_at TEXT,
  uncertain_at TEXT
);

CREATE INDEX idx_message_submissions_queue ON message_submissions(claimed_at, message_id);
