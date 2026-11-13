# Relay V2: deterministic routing from coworker display names

## Normal conversation

A human says "請找大熊說話" inside their ordinary AI assistant.
The assistant invokes **one** existing MCP call:

```json
{ "tool": "sendToAgent", "arguments": { "to": "大熊", "message": "你好！密語是星河。" } }
```

The MCP forwards one authorized `POST /v2/messages` request unchanged.
Relay checks the authenticated caller's own Runtime/Session, then resolves
"大熊" by an **exact normalized match** to the authoritative Agent Address
directory **within the caller's Organization**. The directory includes each
Agent's registered display name, handle, default Session ID and handle; Relay reads a **short-lived authorization-scoped directory snapshot** to determine the destination. A cold name call performs one Agent Address directory read; warm calls reuse the snapshot.
It writes the message with the resolved immutable Agent ID and Session ID.

No intermediate `agentAddressFindByName` MCP call, no model-generated slug,
no Gateway directory operation, no second LLM routing decision and no new
deployment credential.

## Path separation and failure policy

| Input | Relay behavior |
| --- | --- |
| `organization/agent[/session]` | Existing canonical address resolution, no name-directory read |
| Display name such as `大熊` | One authorized Agent directory read and exact displayName/handle match |
| Existing Relay Thread reply | Stored sender/recipient Session IDs, no name resolution |
| Verified external alias object or email | Existing verified alias lookup, unchanged |
| Unknown name | HTTP 404 `recipient_name_not_found`; do not send |
| Same name on multiple Agents | HTTP 409 `recipient_name_ambiguous`; do not select a first result |
| No default Session | HTTP 409 `recipient_name_not_ready`; do not send |
| Invalid directory response | HTTP 502 `address_response_invalid`; fail closed |

An Agent Address displayName matches its *native platform* Bot name only if
that colleague has registered that real name. This change does not magically
discover all unregistered GrokBot/OpenMausBot Bots or cross Organization
boundaries. Native Bot ID mapping and recipient consent remain separate
Gateway onboarding responsibilities, not per-message LLM decisions.

## Office enrollment: name resolution is also Relay-owned

For a one-time office roster invitation, the provider Gateway may collect
the *actual local Bot display name* and *trusted native Bot ID* and make
only one invitation call:

```json
{ "recipientName": "大熊", "recipientBotID": "native-bear-001", "threadMode": "platform" }
```

The Relay's `POST /v2/gateway-teammates` resolves `recipientName` using
the same `RecipientDirectory` as ordinary message sending. It verifies
the office Gateway Wake and creates a **pending** invitation for the
uniquely identified existing recipient Session. That Session must still
approve with its *own* authenticated Runtime before delivery can use the
shared Gateway receiver. The older `recipientAddress` field is retained
for backward compatibility; exactly one of `recipientName` or
`recipientAddress` is required.

This avoids a per-colleague `agentAddressListAgents` +
`agentAddressListSessions` model/tool loop during onboarding.

The corresponding office removal accepts `recipient_name=<visible Bot name>`
or the verified `recipient_address` query parameter on
`DELETE /v2/gateway-teammates`. Relay requires exactly one input, performs a
**fresh** authorized name-directory read on removal (no warm-cache risk for
destructive actions), and only revokes the current authenticated Gateway's
own approved or pending teammate; duplicate names still fail closed.
No new Gateway MCP name lookup or user-facing Nuwa address is required.
Native Bot discovery and obtaining its trusted provider ID still require
the platform's provider adapter, not Relay identity guessing.

## Why the Gateway stays minimal

The existing Relay `GatewayBindings.dispatch` constructs the authenticated
V2 Wake payload using only verified, stored routes:
`recipientBotID`, `recipientSessionID`, `relayThreadID`,
`senderSessionID`, `recipientPlatformThreadID` (when applicable)
and the message body. The receiver should validate the signed event and
forward to the server-chosen Bot/native conversation. It should never list
Agents, look up names, infer the receiver from body text, decide a new
conversation by guessing, or use its own OAuth to act as the real colleague.

The platform-specific action that actually awakens the target Bot still
belongs to a trusted provider adapter. Eliminating provider LLM overhead
entirely requires a deterministic native Webhook-to-Bot adapter; Relay must
not impersonate a provider agent or hold its native Bot credentials.

## Performance and future measurement

- A new name-based call may add one Agent Address directory request **inside Relay** on a cold cache miss, not another user/model-facing MCP turn.
- Canonical-address calls and Relay Thread replies add **zero** name-directory
  requests.
- A bounded **15-second per-Worker in-memory cache** stores at most 128 validated directory snapshots. Keys include the verified Organization, Agent Address origin and a SHA-256 fingerprint of the caller's OAuth bearer; no raw token or cross-grant directory cache sharing. Concurrent misses share one in-flight read; failures are never cached. Worker restarts naturally clear the cache. The normal OAuth/Session/Runtime verification still runs for **every send**, even on hits.
- A rename, deletion or Default Session change may take up to 15 seconds to appear in a warm snapshot. Do not extend the TTL without explicit consistency tests; use authoritative resolution for sensitive operations where such staleness is unacceptable. No new D1 tables or persistent cache resources are required.
- Measure per-stage time at the API, mailbox receipt, Wake callback, native
  Bot start and reply. Do not claim end-to-end latency is solved solely by
  reducing MCP tool calls.
