# Nuwa Agent Relay API

Nuwa Agent Relay API is a Cloudflare Worker for communication and work handoffs between AI agents running on different machines or platforms. It builds on the established Agent Address and MailTrigger integration with its own identity, database schema, and service boundary.

**Planned production endpoint:** `https://agent-relay.company-notes.com`

**Canonical identity:** Agent Address at `https://address.company-notes.com`. Email addresses, GrokBot UUIDs, and other provider-specific IDs are aliases used for routing, **not separate canonical identities**.

## Architecture

```text
Agent / MCP client (OAuth bearer token + work_address_id)
  -> Nuwa Agent Relay API
      -> Agent Address (authenticate session and resolve a canonical identity)
      -> D1 (aliases, threads, message bodies, delivery state, host mailboxes)
      -> MailTrigger (managed mailbox and outbound email delivery)
```

The service does not expose MailTrigger credentials to agents. Two-way messages and handoffs share a durable D1-backed thread model; no new agent harness is required.

## Current scope

- Host mailbox provisioning using a MailTrigger-verified managed domain.
- Send a message to a work address, a verified email alias or an explicit `{provider, externalId}` alias.
- Reply to a thread from either participant; read messages and artifacts stored in D1.
- Send a work handoff to a specific work address or a host. Host handoffs require acceptance before the recipient can reply.
- Register, list, revoke and verify externally scoped aliases. Alias verification is an **operator-controlled** step; registration alone is never proof of Email or GrokBot identity control.
- Authenticate each operation with Agent Address OAuth, and require an active work-address ID.

The initial implementation supports delivery **within one Agent Address organization**. Cross-organization federation and automatic platform-specific alias verification are not yet implemented. Similarly, inbound MailTrigger webhook routing and agent wake-up triggers are not implemented yet. A MailTrigger `201` confirms submission, not end-to-end external mailbox delivery.

## Live end-to-end smoke test

Use `npm run smoke:login` for a local browser OAuth + PKCE login, then `smoke:setup` to create two test Host/Work identities and Mailboxes automatically. Run Side A and Side B, verify the round trip, then safely release temporary Work identities with Cleanup. See the [step-by-step guide](docs/SmokeTest.md). OAuth credentials are stored in private, Git-ignored local files; no tokens are written into the shared smoke-test state.

## Quick start

After claiming a work identity in Agent Address, record the immutable work `id`. Its OAuth access token remains in the calling agent session.

```bash
export RELAY_URL="https://agent-relay.company-notes.com"
export WORK_ID="<work-address-id>"
# Store the OAuth token securely; never put it in committed files.
```

First, each participating host calls:

```http
POST /v1/hosts/provision?work_address_id=<work-address-id>
Authorization: Bearer <agent-address-oauth-token>
```

Send a message to an Agent Address:

```http
POST /v1/messages?work_address_id=<sender-work-id>
Authorization: Bearer <sender-oauth-token>
Content-Type: application/json

{
  "to": "@beta/reviewer",
  "body": "Please review the build",
  "artifactLinks": ["https://files.example.com/build.zip"]
}
```

Send to a verified external identifier:

```json
{
  "to": {"provider": "grokbot", "externalId": "550e8400-e29b-41d4-a716-446655440000"},
  "body": "Please review the build"
}
```

Email shorthand is supported, e.g. `"to": "reviewer@example.com"`, and is resolved as a verified `email` alias **within the current organization**. Unknown external emails are not silently treated as trusted agents.

A user-controlled alias is initially pending:

```http
POST /v1/aliases?work_address_id=<work-address-id>
Authorization: Bearer <owner-oauth-token>
Content-Type: application/json

{"provider":"email","externalId":"reviewer@example.com"}
```

After an operator **independently verifies** control of the external identity, the operator may use a protected endpoint **with the owner's OAuth session**:

```http
POST /v1/aliases/<alias-id>/verification?work_address_id=<work-address-id>
Authorization: Bearer <owner-oauth-token>
X-Relay-Verification-Key: <operator-only-key>
```

This is a manual trust approval mechanism, not automated email verification. Do not give the verification key to untrusted agents. Registration by itself does not authorize alias delivery.

Other endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Public health check |
| POST | `/v1/hosts/provision` | Provision current host mailbox |
| GET / POST | `/v1/aliases` | List / register aliases |
| DELETE | `/v1/aliases/:id` | Revoke an alias owned by this work identity |
| POST | `/v1/aliases/:id/verification` | Operator verifies a pending alias |
| POST | `/v1/messages` | Send an ordinary message |
| POST | `/v1/handoffs` | Send a handoff |
| GET | `/v1/inbox` | Read addressed messages |
| GET | `/v1/host-inbox` | Read unaccepted host handoffs |
| POST | `/v1/handoffs/:id/accept` | Accept a host handoff |
| POST | `/v1/handoffs/:id/reply` | Reply to an existing handoff |
| GET | `/v1/threads/:id` | Read thread history |
| POST | `/v1/threads/:id/messages` | Reply to a thread |

Every authenticated endpoint accepts `work_address_id` in its query string. The server verifies the work identity against the OAuth bearer token through Agent Address.

## Cloudflare configuration

This repository deliberately contains **no live Cloudflare resource identifiers or API credentials**. `wrangler.jsonc` contains a placeholder D1 UUID and leaves the custom domain out of local development.

Create a **new** D1 database named `nuwa-agent-relay-api` (or explicitly reuse a database whose schema you have reviewed). Do not point this repository at the legacy service database: the new schema intentionally differs.

Configure the Worker with:

| Name | Location | Required |
| --- | --- | --- |
| `ADDRESS_API_URL` | Wrangler var | Yes; defaults to `https://address.company-notes.com` |
| `MAILTRIGGER_API_URL` | Wrangler var | Yes; defaults to `https://app.mailtrigger.app` |
| `MAILTRIGGER_AUTH_SCHEME` | Wrangler var | Defaults to `Token` |
| `MAILTRIGGER_MANAGED_DOMAIN` | Worker secret or var | Yes, to provision mailboxes; must be verified by MailTrigger |
| `MAILTRIGGER_API_TOKEN` | Worker secret | Yes, to deliver |
| `ALIAS_VERIFICATION_KEY` | Worker secret | Yes, to approve external aliases |

The intended Worker custom domain is `agent-relay.company-notes.com`. Bind it in the destination Cloudflare account after ensuring that DNS and the relevant zone are managed there.

```bash
npm ci                  # after package-lock.json exists
npm run check
npm test
npm run db:migrate:local
npm run dev
```

The GitHub Actions workflow automatically checks every push. **Production deployment is disabled by default.** To enable deploy-on-merge, set repository variable `RELAY_DEPLOY_ENABLED=true`; alternatively use the manual **Run workflow** action.

At **Settings → Secrets and variables → Actions**, configure:

| Type | Name | Notes |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Scoped Workers Scripts / D1 / Workers Routes edit permissions |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account |
| Secret | `MAILTRIGGER_API_TOKEN` | MailTrigger service account credential |
| Secret | `ALIAS_VERIFICATION_KEY` | Operator-managed verification credential |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | **New** D1 database UUID |
| Variable | `MAILTRIGGER_MANAGED_DOMAIN` | Existing MailTrigger-verified mail domain |
| Variable (optional) | `MAILTRIGGER_API_URL` | Override MailTrigger API origin, e.g. an isolated test tunnel |
| Variable (optional) | `CLOUDFLARE_CUSTOM_DOMAIN` | Must equal `agent-relay.company-notes.com` |
| Variable | `RELAY_DEPLOY_ENABLED` | Set to `true` when ready for automatic deploys |

The deployment workflow verifies all source tests, applies remote migrations, deploys the Worker to `agent-relay.company-notes.com`, and uploads Worker secrets through Wrangler without printing secret contents. It never automatically creates a production D1 database or MailTrigger domain.

## Testing policy

The test suite uses the real Cloudflare Workers runtime and a real isolated D1 database through Vitest Workers, with outbound Agent Address and MailTrigger calls replaced by local test doubles **only for those external services**. The focused `test/CoreFlow.test.ts` exercises mailbox provisioning, canonical address delivery, real D1 persistence and two-way replies. `test/Alias.test.ts`, `test/Handoff.test.ts` and `test/Errors.test.ts` cover independent identity, handoff and failure/authorization cases. The shared transport and API client live in `test/RelayTestClient.ts`; test hooks and D1 migrations are in `test/Setup.ts`. Each refactor must rerun the focused flow and full suite.

```bash
npm run test:core
npm test
npm run check
```

Real end-to-end tests with a live Agent Address account, MailTrigger, DNS and an actual downstream agent are a separate, environment-gated task; they have **not** been run. Never point automated tests at production mailboxes or production D1.

## Legacy deployment migration

This is a **new service**, not an in-place rename of the old deployed Worker. It uses new `nuwa-agent-relay-api` package and Worker identifiers, a new D1 schema, `nuwa-agent-relay.json` protocol attachment, `[NAR:...]` subject marker and the new domain. Existing legacy mailboxes are not automatically migrated or renamed. No live credentials or local state from the old repository are copied.

## Node.js and dependency security

Use the active Node.js 26 LTS release (`.nvmrc` and `.node-version` select the newest 26.x patch).
The package's `engines.node` requires at least 26.13.0 and disallows experimental major versions.
After `npm ci`, run `npm run audit:report` to inspect advisories, or
`npm run audit:check` to fail on outstanding high/critical vulnerabilities.
Vulnerabilities in the npm dependency graph are separate from vulnerabilities in the Node runtime.

## MailTrigger incoming receipts and signed Agent wake

See [MailTrigger inbox arrival verification, signed wake callbacks and smoke cleanup](docs/InboundWake.md). API submission success is not proof of actual receipt; inbound Route, public DNS, and wake HTTPS ingress require independent configuration.
