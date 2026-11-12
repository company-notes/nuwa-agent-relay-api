# Relay V2: MailTrigger receipt and Session Wake

The transport boundary deliberately stays unchanged. MailTrigger knows about SMTP mailboxes and email, **not** Organization, Agent or Session. Relay maps each incoming verified mailbox event to its own Agent/Session model.

## Delivery milestones

1. Relay persists a pending Message and asks the existing MailTrigger SMTP API to send it.
2. MailTrigger accepts the submission. This is **not** proof of an incoming mail delivery.
3. The receiving Agent mailbox triggers the configured MailTrigger Webhook Action to `POST /v1/mailtrigger/receipt` (unchanged).
4. Relay authenticates `X-Relay-Inbound-Key`, checks the `[NAR:UUID]` subject marker, and matches the sender and recipient Agent mailbox email addresses against D1. Only then is `received_at` recorded.
5. The D1 update queues an event for the intended Session's already-verified Wake subscription. A Session-targeted Message wakes its recipient Session. An Agent-level Handoff can notify the recipient Agent's Default Session, but any Session belonging to that Agent may explicitly accept it.
6. Wake retries send a minimal signed `nuwa.message.available` payload with `messageId` and `sessionID`. The target must verify the signature/credential, compare Session ID and use Relay OAuth plus the Runtime capability before fetching the Message.
7. Reading is only recorded by the recipient's explicit `POST /v2/messages/:id/read`. Neither Wake HTTP 2xx nor an Inbox read implies actual Bot work completion.

MailTrigger sends `{ "from": "$SENDER", "receiver": "$RECEIVERS", "subject": "$SUBJECT" }` with the independently configured private inbound header. The webhook URL stays under `/v1/` because changing MailTrigger Route configuration is unnecessary for the Agent Address V2 domain migration.

## Safety and operations

- **Never** alter the MailTrigger service or its Webhook Action/SMTP API contract as part of the identity migration.
- Never treat HTTP mail submission, Callback HTTP status or Wake 2xx as completed bot execution.
- Never turn ordinary Cron retries into ongoing MailTrigger Archive polling.
- Archive lookup is an explicitly requested, rate-limited diagnostic `GET /v2/messages/:id/receipt?refresh=archive` for an authorized Session.
- Wake registration uses a private browser OAuth pairing link or the trusted one-time callback verification flow; do not paste webhook credentials in task text.
- When an Agent Handoff has not yet been accepted, it is visible in `GET /v2/agent-inbox`, not the ordinary Session Inbox. Only the Session that accepts it gains reply permission.
- The source and recipient mailbox mapping is held entirely in Relay D1 `agent_mailboxes`; MailTrigger itself does not track Session identities.

## Verification

Worker/D1 tests confirm the receipt authentication, send response race, MailTrigger route shape, Session matching and Wake dispatch. Deployed staging end-to-end mail delivery is a **separate** required gate. Use [SmokeTest.md](SmokeTest.md) with two valid Agent Address V2 runtimes and already-provisioned MailTrigger mailboxes. A real Bot launch additionally requires the corresponding provider's Wake adapter; do not claim that a scripted Echo proves a provider UI session restarted.
