-- Stage new callbacks until the receiver proves it can read a one-time challenge.
-- Preserve existing verified subscriptions during a replacement attempt.
ALTER TABLE wake_subscriptions ADD COLUMN encrypted_target TEXT;
ALTER TABLE wake_subscriptions ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'hmac';

CREATE TABLE wake_registration_attempts (
  work_address_id TEXT PRIMARY KEY,
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
