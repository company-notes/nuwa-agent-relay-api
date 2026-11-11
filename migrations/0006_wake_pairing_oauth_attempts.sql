-- A pairing invitation can be opened by more than one browser/tab or link preview.
-- Keep OAuth state per authorization attempt, instead of overwriting the
-- previous attempt's state in wake_pairing_requests.
-- OAuth codes, PKCE verifiers and Webhook keys are never stored here.
CREATE TABLE wake_pairing_oauth_attempts (
  state_digest TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX idx_wake_pairing_oauth_attempt_pair ON wake_pairing_oauth_attempts(pairing_id);
CREATE INDEX idx_wake_pairing_oauth_attempt_start ON wake_pairing_oauth_attempts(started_at);
