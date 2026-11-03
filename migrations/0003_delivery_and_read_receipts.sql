-- Transport submission, provider mailbox arrival, and Agent acknowledgement are distinct.
ALTER TABLE messages ADD COLUMN receipt_source TEXT
  CHECK (receipt_source IN ('webhook', 'archive'));
ALTER TABLE messages ADD COLUMN archive_checked_at TEXT;

-- At-most-one concurrent worker may deliver a Wake until its short lease expires.
ALTER TABLE wake_events ADD COLUMN lease_owner TEXT;
ALTER TABLE wake_events ADD COLUMN lease_until TEXT;

CREATE INDEX messages_archive_scan
  ON messages(delivery_status, received_at, archive_checked_at);

CREATE TABLE message_read_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  work_address_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, work_address_id)
);

CREATE INDEX message_read_receipts_work
  ON message_read_receipts(work_address_id, read_at);

-- Earlier Wake jobs were created on send-API acceptance alone. They must not
-- deliver "received" notifications before mailbox arrival has been confirmed.
DELETE FROM wake_events
 WHERE message_id IN (SELECT id FROM messages WHERE received_at IS NULL);
