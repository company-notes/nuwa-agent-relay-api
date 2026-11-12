import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Relay API failure and access boundaries', () => {
  it('reports upstream Agent Address outages as a gateway failure, not a forbidden identity', async () => {
    // Regression: Agent Address HTTP 503 must not be translated into a misleading HTTP 403.
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.failAddressStatus = true;

    const response = await client.call('token-a', 'GET', '/v2/inbox?session_id=session-a');

    expect(response.status, 'An Agent Address outage must be treated as an upstream failure').toBe(502);
    expect(response.body.error.code).toBe('address_lookup_failed');
  });

  it('rejects invalid artifact links with a client error instead of an internal error', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const invalid = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'This message must not be delivered.',
      artifactLinks: ['not-a-url'],
    });

    expect(invalid.status, 'Invalid user-supplied artifact URLs must return 400').toBe(400);
    expect(invalid.body.error.code).toBe('invalid_artifact_links');
    expect(client.deliveries).toHaveLength(0);
  });

  it('stores failed external deliveries without showing them in the recipient inbox', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    client.failNextMail = true;
    const response = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'This send should fail.',
    });

    expect(response.status, 'A transport failure must be visible to the sender').toBe(502);
    expect(response.body.error.code).toBe('mailtrigger_send_failed');

    const rows = await env.DB.prepare(
      'SELECT delivery_status, body FROM messages WHERE body = ?',
    ).bind('This send should fail.').all<{ delivery_status: string; body: string }>();

    expect(rows.results, 'The failed delivery remains available for diagnosis').toHaveLength(1);
    expect(rows.results[0].delivery_status).toBe('failed');

    const inbox = await client.call('token-b', 'GET', '/v2/inbox?session_id=session-b');
    expect(inbox.body.data, 'Failed messages must not be presented as delivered').toHaveLength(0);
  });

  it('does not disclose a thread to a nonparticipant in the same organization', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const message = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Only the participants may read this.',
    });
    expect(message.status).toBe(201);

    const threadId = message.body.data.threadId;
    const denied = await client.call('token-c', 'GET', `/v2/threads/${threadId}?session_id=session-c`);
    expect(denied.status, 'A separate work identity must not read thread history').toBe(404);
    expect(denied.body.error.code).toBe('thread_not_found');

    const foreignInbox = await client.call('token-c', 'GET', '/v2/inbox?session_id=session-c');
    expect(foreignInbox.status).toBe(200);
    expect(foreignInbox.body.data, 'A nonparticipant must not receive another work identity inbox').toHaveLength(0);
  });
});
