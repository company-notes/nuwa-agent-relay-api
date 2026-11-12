-- The Handoff Thread, not a retrying HTTP request, owns exactly one
-- durable acceptance notification. The recipient's independently verified
-- MailTrigger Receipt can later reconcile an uncertain send acknowledgement.
CREATE UNIQUE INDEX messages_one_acceptance_per_thread
  ON messages(thread_id) WHERE kind = 'acceptance';
