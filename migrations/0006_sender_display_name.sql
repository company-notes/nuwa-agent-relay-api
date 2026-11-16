-- Keep the sender's verified display name with each Relay message for natural Gateway delivery.
ALTER TABLE messages ADD COLUMN sender_display_name TEXT;
