# MailTrigger SMTP routing contract

The source of this summary is the MailTrigger Swagger 2.0 JSON supplied for
review on 2026-11-04. The provider lists the endpoint paths and serializer
properties, **but not the semantic labels for its numeric enums**.

This adapter treats MailTrigger as a managed mail transport, not an upstream
SMTP proxy. Default **SMTP to Origin** routing is inappropriate when there is
no external Origin SMTP server.

## Verified serializer shapes

| Resource | Endpoint | Fields relevant to creation |
| --- | --- | --- |
| Sender Rule | `POST /api/v1/rules/` | required `target` (integer 1–7), `value` (string), `user` (integer); optional `ruleType` (integer 1–6), `note` (string) |
| Action Config | `POST /api/v1/actions/` | required `name` (string), `user` (integer), `action` (integer action-template ID); optional `attachResult` |
| Route | `POST /api/v1/routes/` | required `filterOption` (integer 1–3), `mailbox` (integer), `ruleGroup` (integer); optional `name`, `isActive`, `ruleConfigs` (array of integers), `actions` (array of integers), `executionOption` (integer 1–2), `passToNextRouter` |
| Action Template | `GET /api/v1/action-templates/` | `id`, `actionName`, `displayName`, `isActive`; identify the built-in MailTrigger SMTP Action by its name before creating a config |

The Rule serializer has **no `name` field**. The adapter identifies its own
rules with a scoped `note`, and uses `name` for its Action and Route.
The route status flag is **`isActive`**, not `isEnabled`.
The Route relationship array is **`ruleConfigs`**, not `rules`.
Action `action` points to a template ID rather than an `actionType` string.

The Swagger does not expose a Rule Group creation endpoint and does not
explain whether `ruleConfigs` expects Rule IDs or a distinct RuleConfig
resource. Confirm that relationship with a harmless staging request.

## One-time account-level routing profile

The adapter cannot safely guess numeric enum meanings. A MailTrigger account
operator must determine the following provider values from its UI or live
documentation, then configure a **single shared JSON profile** in the
`MAILTRIGGER_ROUTE_PROFILE` Worker variable (GitHub Actions Repository
Variable for auto-deployment). This is configured **once for the service**,
not once per Host:

~~~json
{
  "senderTarget": 1,
  "equalsRuleType": 1,
  "filterOption": 1,
  "ruleGroupId": 19,
  "smtpActionTemplateId": 17
}
~~~

**These numbers are fictitious fixture values for illustrating the shape,
NOT verified production values. Do not copy them into production.**

- `senderTarget`: provider numeric Rule target for **Sender** (1–7)
- `equalsRuleType`: provider numeric Rule type for **Equals** (1–6)
- `filterOption`: provider numeric Route filter for **All**
- `ruleGroupId`: valid group ID belonging to the managed MailTrigger account
- `smtpActionTemplateId`: real active MailTrigger SMTP action-template ID
  found under `GET /api/v1/action-templates/`

Provisioning fails closed with HTTP 503 if the profile is missing or invalid.
The action-template lookup also refuses to create an Action unless the
configured template visibly identifies MailTrigger SMTP, not SMTP to Origin.
If the domain's `user` ID is unavailable, provisioning fails closed.

The provider API schema confirms field names and ranges, not whether those
IDs are correct, whether a RuleGroup can be reused between Hosts, or whether
a new Route requires a separate rule configuration object. These **remain
staging blockers**; no credential-free Swagger file can prove a delivery.

## Provisioning guarantees

When `POST /v1/hosts/provision` is called, Relay must:

1. Ensure the MailTrigger mailbox exists.
2. Ensure a sender-specific Rule, a built-in SMTP Action Config, and an
   enabled mailbox Route, with idempotent matching by scoped names.
3. Read back the exact Route and validate its relationships, active state,
   and provider rule-group ID before marking a new Host ready in D1.
4. Recheck existing Hosts on repeated provisioning, repairing missing or
   disabled managed Routes; do not overwrite unrelated user Routes.
5. Return a failure if any of these invariants is unavailable.

The profile is account-level only. The provisioning itself automatically
creates and reuses the per-Host resources; users must not have to configure
Routes by hand for each agent.

## Verification required before merging this Draft PR

- Record actual enum values (Sender, Equals, All), template ID, and valid
  `ruleGroup` ID from a **staging MailTrigger account**.
- Confirm `ruleConfigs` refers to the Rule IDs created by the API. If not,
  the actual RuleConfig relationship must be implemented first.
- Confirm route PATCH accepts partial `{ "isActive": true }`.
- Confirm SMTP Action works with its default timeout, or determine the
  parameter mutation API to set its documented default `timeout=30`.
- Provision two temporary Hosts, inspect Route and Action Logs, send A→B,
  then B→A, and confirm recipient-side archive / receipt.
- Repeat provisioning and repair a disabled Route to verify no duplicates.
- Check that a new Host is not registered ready if the provider rejects an
  action or Route.

Swagger-driven mock tests verify serializer fields and internal D1 behavior,
not the live provider integration. Do **not** merge to a production-deploying
branch until the above staging tests succeed.
