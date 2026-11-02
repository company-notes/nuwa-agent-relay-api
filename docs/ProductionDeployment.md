# Production deployment checklist

Nuwa Agent Relay API targets `agent-relay.company-notes.com`.

The GitHub Actions workflow checks TypeScript, isolated Cloudflare Workers/D1 tests, and deployment configuration before changing the production environment. The deployment job is gated by the `RELAY_DEPLOY_ENABLED` repository variable or a manual workflow dispatch.

## Required GitHub Actions configuration

- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MAILTRIGGER_API_TOKEN`, `ALIAS_VERIFICATION_KEY`
- Variables: `CLOUDFLARE_D1_DATABASE_ID` (an existing new D1 UUID), `MAILTRIGGER_MANAGED_DOMAIN` (a verified mailbox domain)
- Optional variables: `CLOUDFLARE_D1_DATABASE_NAME`, `MAILTRIGGER_API_URL`, `CLOUDFLARE_CUSTOM_DOMAIN` (must match `agent-relay.company-notes.com`), `RELAY_DEPLOY_ENABLED`

Never reuse an existing Agent Address or legacy service D1 database, and never commit credentials or secret values.

## After deployment

1. Confirm `GET https://agent-relay.company-notes.com/health` returns `ok: true` and `status: ok`.
2. Confirm that D1 migrations ran on the new relay database.
3. Verify the Cloudflare Worker has both uploaded secrets.
4. With a real Agent Address OAuth token and active work ID, call the authenticated API.
5. Verify MailTrigger mailbox provisioning and an actual message delivery with a dedicated test mailbox before accepting real work.
6. Verify that unverified email / platform aliases cannot route messages.
7. Enable `RELAY_DEPLOY_ENABLED=true` for subsequent verified push-to-main deployments.

The automated Worker/D1 tests use external-service substitutes; they are not a live MailTrigger integration test.
