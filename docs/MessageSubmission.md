# Durable message submission

The ordinary asynchronous Relay message path uses a client-generated UUID
`submissionID` on POST /v2/messages and POST /v2/threads/:threadID/messages.
A successful 201 means Relay committed the Message and its submission record;
it does not imply SMTP acceptance, MailTrigger receipt or model execution.
The returned id/messageId is the submission ID and threadId is stable.

A new ID represents a new intended message. Reusing the same ID with the same
authorized sender, actor, recipient, Thread (for replies) and payload returns
the original result, without creating another Thread or submitting another
provider request. Reusing the ID for another payload or identity fails closed.
No ID is inferred from message text.

The Worker attempts queued submissions using waitUntil; its scheduled handler
also resumes unclaimed submissions. D1 atomically claims a submission before
calling MailTrigger. The provider request has a bounded timeout. If the
provider acknowledgement is lost, a claimed submission is uncertain and is
not automatically retried. A delayed authenticated receipt still confirms
arrival and produces the original Inbox/Wake event. An explicit, authorized
archive check can reconcile arrival when the webhook is missing.

Receipt fields retain submissionStatus (pending, sent, failed); outboxStatus
for durable submissions distinguishes queued, submitting, uncertain and
accepted. Accepted means MailTrigger HTTP acceptance or verified arrival,
not execution by a coworker. Ordinary clients do not poll status.

The existing released REST contract without submissionID remains synchronous.
Old pending rows are not backfilled into the new queue: their provider
submission may already have occurred. Automatic provider retry of an
uncertain submission requires a verified MailTrigger idempotency/reconciliation
contract. The Relay submission ID alone cannot enforce exactly-once SMTP
delivery after an ambiguous provider result.
