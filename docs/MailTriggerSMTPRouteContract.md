# MailTrigger managed SMTP routing contract

Source basis: the uploaded MailTrigger Swagger 2.0 JSON plus the MailTrigger
source-code review and temporary staging verification reported on 2026-11-04.
The latter covered Route create/read/enable/disable in `route.mxnodes.com`,
**not** the whole Nuwa Relay end-to-end flow.

The managed mail domain does not have an external Origin SMTP server. Route
actions must use the provider's built-in `RelaySMTP` action template, not
**SMTP to Origin**.

## Confirmed MailTrigger semantics

| Resource | Verified behavior |
| --- | --- |
| Rule target | `target: 1` means Sender |
| Rule type | `ruleType: 1` means regex search, **not** Equals |
| Route filtering | `filterOption: 1` means **match all rules**; `2` means match any; `3` means all emails, ignoring rules |
| SMTP template | The active built-in template has `actionName: "RelaySMTP"`; staging ID was `21`, version `1`. **IDs vary across environments.** |
| Route relationship | `ruleConfigs` references IDs returned by `POST /api/v1/rules/` |
| Rule group | MailTrigger overrides the caller's supplied `ruleGroup` and gets or creates one for the authenticated user. No group ID should be provided by the client. |
| Activation | `PATCH /api/v1/routes/{id}/` accepts partial `{ "isActive": false }` and `true` |

MailTrigger's group get-or-create behavior was found in its implementation.
The staging account already had a group, so a wholly new account without any
existing group has **not** been exercised live.

## Exact sender match

Because `ruleType: 1` invokes regex search, a plain sender email address
is unsafe as an exact-match expression; `.` would match any character and
an unanchored pattern could match a substring.

The provider Rule must contain an escaped, anchored pattern, for example:

~~~json
{
  "target": 1,
  "ruleType": 1,
  "value": "^nar-hosta@relay-test\\.example$"
}
~~~

The code escapes regex metacharacters in the full sender address before
prefixing `^` and suffixing `$`. Existing managed Rules are checked
against this exact pattern instead of silently accepting an unanchored value.

## Automatic provisioning

Calling `POST /v1/hosts/provision` now:

1. Ensures a sender/receiver mailbox.
2. Finds the **one active** `RelaySMTP` template by its `actionName`;
   uses that environment's returned numeric template ID.
3. Creates/reuses a sender Rule (`target: 1`, `ruleType: 1`, exact regex),
   an Action Config, and an enabled Route.
4. Sends `filterOption: 1`, `ruleConfigs`, `actions`, `mailbox`, and
   `isActive: true` in the Route POST. Omits `ruleGroup` intentionally.
5. Reads the Route back and verifies its returned Rule Group, correct mailbox,
   exact single Rule/Action links, filter mode and active state before
   recording a new Host in D1.
6. Rechecks and repairs missing/disabled routes for existing Hosts.
7. Once the NAR SMTP Route is verified active, looks for the provider-default
   **`SMTP to Origin Router`** Route (or the legacy name
   **`SMTP to Origin`**) attached to this **exact mailbox**. If present,
   deletes only that default and reads Routes back to confirm its removal.
   Does not delete `Relay to Origin` or unrelated/custom Routes. Duplicate
   matching defaults, incomplete provider listings, conflicting NAR resource
   references and deletion failures fail provisioning rather than silently
   marking a new Host ready.

No account-wide `MAILTRIGGER_ROUTE_PROFILE` is required. In particular,
the temporary staging template ID `21` and Rule Group ID `1` are **not**
hard-coded for production.

## Smoke Host cleanup

Only the protected `relay-smoke-<runId>-a/b` Host and matching Work can
invoke the destructive cleanup endpoint. For that Host, cleanup verifies
the D1 mailbox ID, managed domain, mailbox username, deterministic managed
resource names, owner and exact Rule/Action/Route relationships. It also
refuses deletion if another Route references the Rule or Action.

Cleanup runs **Route → Action Config → Sender Rule → Mailbox → D1**.
If any remote operation fails, the D1 record remains for retry; repeated
cleanup handles already-removed managed routing entries. The result reports
`providerUserCleanup: "not_verified"` because the provided Swagger does not
expose a safe mailbox-user ownership/deletion API. It would be unsafe to
delete a potentially shared provider User without stronger ownership proof.

MailTrigger may auto-create additional Rule/Action Config/User resources when
it creates a mailbox. Only the precisely identified NAR-owned resources are
deleted automatically; other provider-created or orphaned objects require a
separate account-scoped audit. Cleanup does **not** claim these are removed.

## Remaining live validation before merge

The isolated Workers/D1 suite validates the code's behavior with provider
test doubles, but is not a live MailTrigger integration test.

- Provision two dedicated smoke Hosts using the **actual PR #8 API**, inspect
  each managed Rule, Action and Route, then send A→B and B→A.
- Verify arrival via recipient archive or authenticated receipt, rather
  than treating HTTP 201 submission as delivery proof.
- Repeat provisioning; delete/disable a Route and verify repair with no
  duplicate resources.
- Check a new MailTrigger account without an existing Rule Group.
- Run cleanup and inspect MailTrigger for residual auto-created Rule/Action
  Config/User records. Do not delete unknown/shared objects automatically.
- Confirm all provider records are absent or document remaining orphans.

The current change is designed to prevent default SMTP-to-Origin processing
from interfering with MailTrigger-managed delivery. This does **not** prove
that the missing handoff Archive was caused by the default origin Route.
Inspect provider SMTP/queue/route logs if handoff delivery still fails.

The production deployment workflow deploys automatically after successful
`main` verification, without the old `RELAY_DEPLOY_ENABLED` toggle.
Deploy requires the repository's existing Cloudflare/D1/MailTrigger
credentials and does not populate missing secrets.

## Recipient Webhook receipt path (opt-in)

When the Worker has `MAILTRIGGER_RECEIPT_URL` and the secret
`MAILTRIGGER_INBOUND_KEY` configured, Host provisioning additionally creates
a `NAR receipt <mailboxId>` Route on the **receiving mailbox**, with its own
`Webhook (API)` Action. It does **not** attach the Webhook to the
sender `RelaySMTP` Route (which runs before recipient arrival).

The Webhook Action uses `POST`, `webhook_url`, `headers` containing the
inbound key, and `data` with `$SENDER`, `$RECEIVERS`, and `$SUBJECT`.
Provisioning reads the Action parameters back before enabling the Route.
The Rule Group and template ID are provider-assigned. Existing resources are
rechecked and cleanup removes the managed Receipt Route and Action.

`MAILTRIGGER_RECEIPT_URL` is the **Relay Worker**'s public callback URL;
`MAILTRIGGER_API_URL` remains the **MailTrigger server** address, completely
independent of the receipt callback. No URL is inferred from one another.

A verified B-side receipt can arrive before the send API response. In that
case the authenticated receipt supersedes the D1 `pending` or `failed`
submission state and records an arrived message. Wake events are queued from
this authoritative arrival, not from the send API's HTTP 201.

Routine Cron Archive polling has been removed. An authenticated, explicit
`refresh=archive` diagnostic remains available but is not used by live
Wake or the `smoke:receipts` script.

**Provider validation needed:** MailTrigger's published Swagger documents
Action parameter listing and PATCH, but the parameter-value serializer and
active Webhook template names may differ by instance. Only an isolated
mock contract has been exercised here; check actual staging Action parameters
and the real incoming Webhook before production activation.
