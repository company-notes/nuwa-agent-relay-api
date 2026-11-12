# Nuwa Agent Relay API — V2

Nuwa Agent Relay is an asynchronous work/message transport between Agent Address identities. The canonical identity is **Organization / Agent / Session**; the persistent cross-platform conversation is a Relay Thread, not a Bot platform's private conversation.

## Responsibilities

- **Agent Address V2:** Account/Organization authorization, immutable Agent and Session identities, Default Session, and Runtime Lease / Resume capabilities
- **Relay API:** Session authorization and messaging, Agent Handoff acceptance, Thread history, durable read and delivery receipts, signed Wake callbacks
- **MailTrigger:** Existing managed email mailboxes, SMTP sending, incoming email archive and inbound webhook. It is deliberately unaware of Agent/Session semantics

An Agent has one managed transport mailbox, shared across that Agent's Sessions. Message and Thread authorization are Session-scoped. A Handoff to `organization/agent` is visible to the Agent's Sessions until one explicitly accepts it; that Session alone can reply. An ordinary Message to the Agent shorthand resolves to its Default Session.

No recipient Bot platform integration is required to send and store messages. To start an Agent automatically, the provider still needs a correctly authenticated Wake listener that can actually launch a Session. A successful Wake HTTP response is not proof that an Agent executed.

## Authorization

Every authenticated `/v2/*` Relay request needs:

- `Authorization: Bearer <Agent Address OAuth token>`
- `X-Nuwa-Runtime-Token: <current Session Runtime capability>`
- `session_id=<immutable Session ID>` in the query string

Relay checks the active Runtime lease with Agent Address before allowing a Session action. An OAuth Organization membership, Agent address or Session ID alone does not grant execution rights. Never place Runtime tokens in chat, task prompts or unsecured tool traces.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/agents/mailbox` | Ensure calling Agent's managed transport mailbox |
| GET/POST | `/v2/aliases` | List or register Session-owned external aliases |
| DELETE | `/v2/aliases/:id` | Revoke an alias |
| POST | `/v2/aliases/:id/verification` | Operator verification |
| POST | `/v2/messages` | Start a new Message Thread |
| GET | `/v2/inbox` | Messages for the current Session |
| GET | `/v2/agent-inbox` | Unaccepted Handoffs addressed to current Agent |
| GET | `/v2/messages/:id` | Read a Message; optional `context_limit=1..12` |
| POST | `/v2/messages/:id/read` | Explicit receiving Session read acknowledgment |
| GET | `/v2/messages/:id/receipt` | MailTrigger arrival and read status; `refresh=archive` for operator-directed diagnostic only |
| POST | `/v2/handoffs` | Create Agent- or Session-targeted Handoff |
| POST | `/v2/handoffs/:id/accept` | Atomically accept Agent Handoff |
| POST | `/v2/handoffs/:id/reply` | Reply within an accepted Handoff Thread |
| GET | `/v2/threads/:id` | Read authorized Thread history |
| POST | `/v2/threads/:id/messages` | Continue an existing Thread |
| POST | `/v2/wake-pairings` | Start private browser-based Wake pairing |
| GET/POST/DELETE | `/v2/wake-subscription` | Manage selected Session's Wake subscription |
| POST | `/v2/wake-subscription/verification` | Verify an actual callback challenge |
| GET | `/v2/wake-events` | Inspect notification status |

### MailTrigger boundary — unchanged

The existing `POST /v1/mailtrigger/receipt` endpoint remains the configured MailTrigger Webhook Action destination. **Its `/v1/` path is an external transport compatibility boundary, not a Host/Work identity API.** MailTrigger sends `from`, `receiver`, `subject` and its private `X-Relay-Inbound-Key` header. Relay matches its own protocol Message ID and both Agent mailboxes before recording arrival. The MailTrigger API origin, SMTP routing, archive and managed-mailbox client are not modified by V2.

SMTP submission, MailTrigger webhook-confirmed arrival, Wake callback delivery, explicit read and Bot execution are distinct milestones. Relay Cron retries Wake; it must not regularly poll MailTrigger Archive.

## Tests and deployment

Run `npm run check`, `npm test`, `npm run test:smoke` and `npm run audit:check`. The Worker/D1 tests execute locally; they do **not** prove actual delivery through deployed MailTrigger or Bot integration.

Follow [V2 cutover instructions](docs/DeploymentV2.md). A fresh, isolated V2 D1 is **mandatory**. `npm run db:migrate:remote` and `npm run deploy` fail closed if pointed to old, mixed or partial D1. Do not deploy from a Draft PR or convert the production D1 implicitly.

For a separately authorized live staging end-to-end test using already-provisioned Agent mailboxes, see [V2 Smoke Test](docs/SmokeTest.md). No old Host/Work smoke commands or unsafe automatic cleanup are provided.
