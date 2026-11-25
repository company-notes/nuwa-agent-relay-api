CREATE TABLE inbox_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  notified_at TEXT
);

CREATE INDEX inbox_events_session ON inbox_events(org_id, session_id, sequence);
CREATE INDEX inbox_events_pending ON inbox_events(sequence) WHERE notified_at IS NULL;

INSERT INTO inbox_events (message_id, org_id, session_id, notified_at)
SELECT m.id, t.org_id, m.recipient_session_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM messages m JOIN threads t ON t.id = m.thread_id
 WHERE m.delivery_status = 'sent' AND m.recipient_session_id IS NOT NULL
   AND m.kind IN ('message', 'reply')
 ORDER BY m.created_at, m.id;

CREATE TRIGGER inbox_event_on_sent
AFTER UPDATE OF delivery_status ON messages
WHEN NEW.delivery_status = 'sent' AND OLD.delivery_status <> 'sent'
  AND NEW.recipient_session_id IS NOT NULL AND NEW.kind IN ('message', 'reply')
BEGIN
  INSERT OR IGNORE INTO inbox_events (message_id, org_id, session_id)
  SELECT NEW.id, t.org_id, NEW.recipient_session_id FROM threads t WHERE t.id = NEW.thread_id;
END;
