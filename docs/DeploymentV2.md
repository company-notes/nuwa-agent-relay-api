# V2 deployment / D1 cutover: fail closed

Relay V2 replaces the Host/Work identity domain with Organization/Agent/Session. Its `migrations/0001_init.sql` is a **new database schema**, not an ALTER or a data migration of existing D1 tables. Old D1 instances may already have a migration recorded under this filename: applying the new Worker to one will leave incompatible tables and can break both Relay and MCP.

## Required sequence

1. Keep Agent Address V2, Relay V2 and MCP V2 PRs **Draft** while development tests and cross-service integration are in progress.
2. Provision **separate new staging D1 databases** for Agent Address and Relay. Do not point the Relay V2 Worker binding `DB` at the existing production Relay database. Back up production and leave it untouched.
3. Configure isolated staging Worker names, bindings and OAuth routes/credentials. Do not copy production secret values or bind a staging instance to production MailTrigger mailboxes.
4. Inspect the target D1 and run `npm run db:migrate:remote` only for the explicitly selected **staging** Wrangler configuration. Its guard rejects legacy, unknown or partially migrated tables.
5. Verify fresh V2 schema and use `npm run deploy` with the same **staging** Wrangler configuration. The deployment guard requires the complete V2 schema. Never bypass it via `wrangler deploy` in this workflow.
6. Run Worker/D1 tests and `npm run test:smoke`; separately run the explicitly authorized `npm run smoke:v2` only with already-provisioned staging mailboxes.
7. Independently verify signed Wake to an actual Session Runtime and a real receiving Bot start. A Wake HTTP response alone does not close the end-to-end acceptance gate.
8. Review data migration/discard policy, downstream consumers, rollback and production cutover with repository owners before any merge or production deployment.

The MailTrigger SMTP, Archive and inbound Webhook `/v1/mailtrigger/receipt` contract remain unchanged. They are **not** an identity migration target.

## Operational guard

`scripts/GuardV2D1.mjs --remote` queries `sqlite_master` using Wrangler and rejects known legacy tables, mixed tables and partial V2 schemas. `--require-migrated` (used before deployment) also refuses an empty database. If inspection cannot return a valid D1 JSON result, it fails closed.

This guard is a necessary safety net, **not** proof that a D1 ID points to the correct staging tenant. Operators must verify Wrangler configuration, database IDs and credentials themselves. Do not run remote migrations or deployment based only on a green CI result.

## Deliberately excluded

No automatic conversion or deletion of legacy Host/Work D1 rows, no rewriting external MailTrigger Route configurations, no silent alias migration, and no proof of deployed Bot-to-Bot completion without genuine integrated tests.
