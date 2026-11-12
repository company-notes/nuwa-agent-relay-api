# Relay V2 staging end-to-end smoke

This script talks to **deployed staging** Agent Address V2, Relay API V2 and already configured MailTrigger mailboxes. It must not be run against production as a routine test. It does **not** modify MailTrigger configuration, create mailboxes or delete any remote resources.

## Prerequisites

- Two different Agent identities, each with an active Session, in the **same Organization**
- Both Agent transport mailboxes already provisioned on staging, with their existing MailTrigger receipt Webhook Actions configured
- Agent Address V2 and Relay API V2 deployed against **fresh isolated staging databases**
- Two valid OAuth tokens and two active Runtime capabilities, obtained through a trusted identity flow
- Explicit authorization to send real external test emails

Set these environment variables through your shell's secret-safe environment or a protected secret manager, **not** in chat or committed configuration:

| Variable | Meaning |
|---|---|
| `NUWA_SMOKE_RELAY_URL` | Clean HTTPS origin of staging Relay |
| `NUWA_SMOKE_ADDRESS_URL` | Clean HTTPS origin of staging Agent Address |
| `NUWA_SMOKE_OAUTH_A`, `NUWA_SMOKE_OAUTH_B` | OAuth bearer credentials |
| `NUWA_SMOKE_RUNTIME_A`, `NUWA_SMOKE_RUNTIME_B` | Corresponding active Session Runtime capabilities |
| `NUWA_SMOKE_SESSION_A`, `NUWA_SMOKE_SESSION_B` | Immutable Session IDs |
| `NUWA_SMOKE_AUTHORIZE_SEND=yes` | Explicit consent for live mail submission |

Run `npm run smoke:v2`.

The script checks each OAuth/Runtime identity first; sends a new Message from A to B; requires independent MailTrigger **webhook** arrival; checks B's Inbox and explicit read receipt; replies from B to A in the same Thread; verifies the reply arrived; then sends an Agent-level Handoff, verifies arrival, has Session B accept, sends Handoff acknowledgement and reply, and verifies confirmed arrivals and A-side Thread history.

It fails closed on mismatched identities, absent resources or missing receipt evidence. It reports only opaque message/thread IDs, **not** OAuth, Runtime or webhook secrets. It never automatically resends a failed message or tries to clean up remote MailTrigger resources.

This is a transport-level E2E check. It still does not prove that a provider (e.g. GrokBot or OpenMausBot) actually starts a Bot execution when Wake arrives. That acceptance requires a separate provider-specific staged callback integration.

To run **offline** tests only: `npm run test:smoke`. These do not send email. See [Operations.md](Operations.md) for the normal main-branch production deployment and canonical D1 guard.
