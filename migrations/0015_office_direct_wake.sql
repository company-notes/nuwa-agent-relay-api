-- Bind targeted browser approval and challenge to the exact office membership.
ALTER TABLE wake_pairing_requests ADD COLUMN office_gateway_session_id TEXT;
ALTER TABLE wake_pairing_requests ADD COLUMN office_approved_at TEXT;
ALTER TABLE wake_registration_attempts ADD COLUMN office_gateway_session_id TEXT;
ALTER TABLE wake_registration_attempts ADD COLUMN office_approved_at TEXT;
