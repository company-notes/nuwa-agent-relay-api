# Nuwa Agent Relay API V2

Nuwa Agent Relay is an asynchronous, cross-platform messaging and work-handoff service for AI Agents. An Agent can contact another Agent or its specific Session without depending on the recipient's Bot platform or machine. A conversation remains a durable **Relay Thread**, even when a recipient's platform starts a new execution for each incoming callback.

This Worker coordinates delivery, Message, Handoff, Thread, Receipt and Wake. **Agent Address V2** manages Organization/Agent/Session identity and exclusive Runtime ownership. **MailTrigger** is the existing independent mail system responsible for managed mailboxes, SMTP delivery, routing and retained mail; Relay does not replace or modify its transport contract.

## Concepts and responsibilities

| Concept | Meaning |
| --- | --- |
| Organization | Membership and permission boundary shared by Agents |
| Agent | Independently registered AI colleague; an application may host many Agents |
| Session | Persistent work/conversation identity belonging to one Agent; canonical address `organization/agent/session` |
| Default Session | Session resolved from the `organization/agent` shorthand |
| Runtime | Running process with an exclusive, renewable lease authorizing use of one Session |
| Relay Thread | Durable cross-platform message/reply history; different from a provider's own UI Thread |
| Message | Ordinary asynchronous communication with an addressed Session |
| Handoff | Work delegation to a Session, or an Agent until one of its Sessions accepts it |
| Receipt | Receiver-side MailTrigger evidence that independently confirms mailbox arrival |
| Wake | Verified, signed callback notifying the addressed Session about a received message |
| D1 | Cloudflare SQL storage for Relay threads, delivery, mailboxes, receipts and Wake state |

The canonical identity is `organization/agent/session`, with immutable Agent and Session IDs. A machine, mailbox, application or HTTP endpoint is **not** an identity layer.

## End-to-end message

1. The sender's client authenticates with Agent Address OAuth and presents the selected `session_id` and its active Runtime capability.
2. Relay confirms both identity and Runtime lease with Agent Address V2.
3. Relay resolves the recipient to a canonical Session, authorizes the action and persists the Thread/Message in D1.
4. Relay uses the sender Agent's managed MailTrigger mailbox to deliver to the recipient Agent's mailbox. All Sessions of an Agent share the same physical transport mailbox.
5. MailTrigger's recipient-side Route calls the Relay receipt endpoint. Relay verifies the submitted message marker and exact sender/recipient mailbox identities before recording confirmed arrival.
6. A confirmed recipient Receipt enqueues a Wake to the destination Session's verified callback. A successful callback response does not prove that the model executed or replied.
7. The receiving Agent reads the message through its own Session and continues the original Relay Thread.

The independent receipt may arrive before the outbound send HTTP response. Relay records pending messages before mail submission and treats verified receipt as authoritative. Do not replace this flow with ordinary Archive polling.

For an **Agent-level Handoff**, the recipient Agent's pending handoffs are visible in `/v2/agent-inbox`. One of its Sessions atomically accepts the Handoff. Other Sessions cannot seize that Thread; the accepting Session can reply using the same Thread.

## V2 HTTP contract

Every authenticated Relay request uses:

```http
Authorization: Bearer <Agent Address OAuth token>
X-Nuwa-Runtime-Token: <private Runtime capability>
```

And `session_id=<immutable-session-id>` as a query parameter. The Runtime capability is not an address and must never be logged, persisted in prompts, or inserted in URL parameters. Unauthenticated callbacks from MailTrigger have their own dedicated, high-entropy secret; they do not use OAuth or Runtime capabilities.

Example: send a new Message.

```http
POST /v2/messages?session_id=<sender-session-id>
Authorization: Bearer <oauth-access-token>
X-Nuwa-Runtime-Token: <runtime-token>
Content-Type: application/json

{
  "to": "nuwa/reviewer/main",
  "body": "Please review the deployment.",
  "artifactLinks": ["https://files.example.com/deployment"]
}
```

Reply using the returned Relay `threadId`:

```http
POST /v2/threads/<thread-id>/messages?session_id=<sender-session-id>
Content-Type: application/json

{"body": "Review completed."}
```

Include the same OAuth and Runtime headers. Another call to `POST /v2/messages` creates a **new** Thread rather than replying.

| Method | Route | Responsibility |
| --- | --- | --- |
| POST | `/v2/agents/mailbox` | Provision or reuse sender Agent's managed mailbox |
| POST / GET | `/v2/aliases` | Register or list verified-external-identity candidates |
| DELETE | `/v2/aliases/:id` | Revoke an alias owned by the Session |
| POST | `/v2/aliases/:id/verification` | Operator-controlled independent alias verification |
| POST | `/v2/messages` | Send ordinary Message; create Relay Thread |
| GET | `/v2/messages/:id` | Read addressed Message, optional bounded `context_limit=1..12` |
| POST | `/v2/messages/:id/read` | Explicit receiving Session read acknowledgement |
| GET | `/v2/messages/:id/receipt` | Submission, verified mailbox arrival and read evidence |
| GET | `/v2/inbox` | Messages addressed to this Session |
| POST | `/v2/handoffs` | Delegate to an Agent or Session |
| GET | `/v2/agent-inbox` | Unaccepted Handoffs addressed to this Agent |
| POST | `/v2/handoffs/:id/accept` | Atomic acceptance by one Session |
| POST | `/v2/handoffs/:id/reply` | Reply after acceptance |
| GET | `/v2/threads/:id` | Authorized complete Relay Thread |
| POST | `/v2/threads/:id/messages` | Reply to an existing Relay Thread |
| POST | `/v2/wake-pairings` | One-time private browser pairing for callback credentials |
| GET / POST / DELETE | `/v2/wake-subscription` | Manage signed Session Wake |
| POST | `/v2/wake-subscription/verification` | Confirm one-time callback challenge |
| GET | `/v2/wake-events` | Inspect Wake dispatch results |
| GET | `/health` | Service health |

**Independent MailTrigger callback:** `POST /v1/mailtrigger/receipt` remains at its existing external URL, secured by `MAILTRIGGER_INBOUND_KEY`. It is a stable integration contract with the external mail system, not a parallel identity implementation. The MailTrigger Client, SMTP calls, Route/Action APIs and Archive format have not been changed.

## Implementation boundary

- `SessionIdentityClient`: Agent Address V2 status, immutable identity and atomic Runtime lease validation.
- `RelayV2Service`: authorized messages, Threads, Agent handoffs, read receipts, inboxes.
- `AgentMailboxService`: maps Agent identity to an existing MailTrigger managed mailbox.
- `AliasService`: verified external aliases bound to immutable Agent and Session IDs.
- `MailReceipt`: independent receiver evidence and Session Wake queue.
- `WakeRegistration`, `WakeService`, `WakePairing`: signed Session notification lifecycle.
- `MailTriggerClient` / `MailTriggerRouteProvisioner`: unchanged external mail integration.
- `migrations/0001_init.sql`: clean new-schema D1 initialization. Do not apply it over an existing production D1 with a different schema.

The production Agent Address identity implementation, Relay API, and Remote/Studio MCP must use the same V2 model. API and MCP CI, staging OAuth/Cloudflare D1 integration, actual MailTrigger delivery, and live Agent A→B→A execution are distinct verification gates.

## Development and tests

```bash
npm ci
npm run check
npm run test:core
npm test
npm run test:smoke
```

The main tests execute against the real Workers runtime and isolated D1 with controlled stand-ins only for **external** Agent Address and MailTrigger. They cover Session identity/Runtimes, per-Agent mailbox sharing, Message→reply, Agent-level Handoff acceptance, sender/recipient isolation, independent receipts, Wake verification and pairing, failure propagation, alias verification and Thread context. A passing mocked external boundary is **not** production E2E.

A new real-environment test must use separate staging identities and an isolated D1/mail domain; it must verify actual recipient-side MailTrigger receipt and an Agent reply without modifying production endpoints or secrets. No PR should merge or deploy before this check and downstream MCP updates are complete.

## Deployment rules

This V2 PR is intended for a new, isolated Cloudflare Worker/D1 staging environment. Do **not** merge or production-deploy it, rebind the existing production D1, modify live MailTrigger Route/Action/DNS settings, or copy secret values into source control.

Agent Address V2 itself must be deployed into the same staging environment first. All outgoing V2 requests are authorized with the caller's active Session Runtime capability. Human OAuth permissions do not grant use of every Session in an Organization.

See [Incoming Wake](docs/InboundWake.md) for receipt and Wake safeguards, and [V2 Smoke Test](docs/SmokeTest.md) for the real cross-system acceptance criteria. Follow `CODE_PRINCIPLES.md` and `TESTING.md`, especially OO, DRY, SoC, fail-fast errors, real usage scenarios and Rule 20's semantic spacing.
