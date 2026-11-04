# Managed Host SMTP route provisioning

Nuwa Relay treats the provider as its managed messaging transport. It must not
depend on the provider's default **SMTP to Origin** route, which sends to an
unrelated MX-discovered SMTP server.

For every Host, `POST /v1/hosts/provision` must ensure:

1. A managed mailbox with sending and receiving enabled.
2. A sender-exact Rule for that mailbox's email address.
3. A built-in **MailTrigger SMTP** Action (not the generic external SMTP Action).
4. An enabled Route linking that mailbox, Rule, and Action.
5. A fresh read-back of the Route before declaring the Host ready or writing a
   new `paired_hosts` row to D1.

The API must also recheck existing Host records. Missing routes are repaired;
disabled managed routes are re-enabled. A provider failure yields HTTP 502; it
must never be treated as readiness.

## Provider API schema validation required before merging

The public provider reference documents these endpoint families:

- `GET/POST /api/v1/rules/`
- `GET/POST /api/v1/actions/`
- `GET/POST /api/v1/routes/`
- `PATCH /api/v1/routes/{id}/`

However, the public documentation does **not** specify the complete JSON
serializers or enum values. The current implementation has **unverified
assumptions** about these field names and values:

- Rule: `target=sender`, `ruleType=equals`, `value=<mailboxEmail>`.
- Action: `actionType=mailtrigger_smtp`, `parameters.timeout=30`.
- Route: `mailbox`, `rules`, `actions`, `mailFilterOption=all`,
  `executionMechanism=sequential`, `passToNextRoute=true`,
  `isEnabled=true`.

Before production merge, log into
[MailTrigger Swagger](https://app.mailtrigger.app/swagger/) and confirm the
**request, response, and PATCH schemas** for all three endpoints, including
whether action type and enum codes are encoded differently. Adapt the typed
client and the test mock to the real contract; do not equate green mock tests
with a working provider integration.

## Staging smoke test

Use a dedicated verified public MailTrigger-owned domain and two temporary
Host identities; never run destructive tests against production mailboxes.

1. Provision Host A and Host B, then inspect each provider mailbox's Route and
   linked Rule/Action; it must use built-in SMTP.
2. Provision them a second time. Confirm there are no duplicate managed Rules,
   Actions, or Routes.
3. Disable or remove one managed Route using the staging account, then call
   provisioning again; confirm it is re-enabled or recreated.
4. Send A→B and B→A, inspect Route Logs, and verify the receiver archive or
   signed receipt. Submission HTTP 201 does not establish delivery.
5. Simulate a provider Route write failure. Confirm the API returns 502 and
   does not register a new Host as ready.
6. Check that an existing non-managed Route is not modified or adopted.

A local `.test` domain without public MX is not a substitute for public
receiving DNS. The built-in SMTP action can remove an **external origin SMTP**
dependency, but cannot by itself make a non-routable recipient domain deliver
mail from the public Internet.

The automated Vitest suite runs isolated D1 against a mocked MailTrigger API.
It checks provisioning logic but **not** MailTrigger's live serializer contract
or external delivery. The API deployment is gated separately by the
`RELAY_DEPLOY_ENABLED` repository variable.
