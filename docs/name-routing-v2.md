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
Agent's registered display name, handle, default Session ID and handle; Relay
needs **one server-side Agent Address directory read** to determine the destination.
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

- A new name-based call adds one Agent Address directory request **inside Relay**,
  not another user/model-facing MCP turn.
- Canonical-address calls and Relay Thread replies add **zero** name-directory
  requests.
- No new D1 tables, background synchronization or distributed cache are
  necessary for this first implementation. Avoid stale caches and guessed
  identity mapping until measured performance warrants one.
- Measure per-stage time at the API, mailbox receipt, Wake callback, native
  Bot start and reply. Do not claim end-to-end latency is solved solely by
  reducing MCP tool calls.
