import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Nuwa Agent Relay core messaging flow', () => {
  it('delivers, persists and replies to a canonical session-address thread', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const provisionedAgain = await client.call(
      'token-b',
      'POST',
      '/v2/agent-mailboxes?session_id=session-b',
    );
    expect(provisionedAgain.status).toBe(201);
    expect(provisionedAgain.body.data.created, 'Provisioning a host twice must reuse its mailbox').toBe(false);

    const outbound = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Please check the release build.',
      artifactLinks: ['https://files.example.com/build.zip'],
    });

    expect(outbound.status).toBe(201);
    const threadId = outbound.body.data.threadId as string;

    const inbox = await client.call('token-b', 'GET', '/v2/inbox?session_id=session-b');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0].body).toBe('Please check the release build.');
    expect(inbox.body.data[0].artifactLinks).toEqual(['https://files.example.com/build.zip']);

    const saved = await env.DB.prepare('SELECT delivery_status, body FROM messages WHERE id = ?')
      .bind(outbound.body.data.id).first<{ delivery_status: string; body: string }>();
    expect(saved?.delivery_status, 'Real D1 must store a sent message').toBe('sent');
    expect(saved?.body).toBe('Please check the release build.');

    const reply = await client.call(
      'token-b', 'POST',
      `/v2/threads/${threadId}/messages?session_id=session-b`,
      { body: 'Verified. Build passes on Linux.' },
    );
    expect(reply.status).toBe(201);

    const history = await client.call('token-a', 'GET', `/v2/threads/${threadId}?session_id=session-a`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((item: any) => item.body)).toContain('Verified. Build passes on Linux.');

    expect(client.deliveries, 'MailTrigger must receive both transport calls').toHaveLength(2);
    expect(client.deliveries[0].subject).toMatch(/^\[NAR:/);
  });

  it('only replies to the original coworker for a verified incoming message', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const request = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Please report the release status.',
    });
    expect(request.status).toBe(201);
    const other = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'A separate conversation.',
    });
    expect(other.status).toBe(201);

    const threadID = request.body.data.threadId;
    const path = `/v2/threads/${threadID}/messages?session_id=session-b`;
    const wrong = await client.call('token-b', 'POST', path, {
      messageID: other.body.data.id,
      body: 'Do not send to an unrelated thread.',
    });
    expect(wrong.status, 'An unrelated incoming message must not authorize a reply').toBe(404);
    const missing = await client.call('token-b', 'POST', path, {
      messageID: crypto.randomUUID(),
      body: 'Do not send without a matching incoming message.',
    });
    expect(missing.status).toBe(404);
    const empty = await client.call('token-b', 'POST', path, {
      messageID: '',
      body: 'Do not treat invalid evidence as absent.',
    });
    expect(empty.status).toBe(400);
    expect(client.deliveries).toHaveLength(2);

    const reply = await client.call('token-b', 'POST', path, {
      messageID: request.body.data.id,
      body: 'Release build verified.',
    });
    expect(reply.status).toBe(201);
    const ownMessage = await client.call('token-b', 'POST', path, {
      messageID: reply.body.data.id,
      body: 'Do not treat our outgoing reply as inbound evidence.',
    });
    expect(ownMessage.status).toBe(404);
    const sibling = await client.call('token-c', 'POST',
      `/v2/threads/${threadID}/messages?session_id=session-c`, {
        messageID: request.body.data.id,
        body: 'Do not reply from a different work.',
      });
    expect(sibling.status).toBe(404);

    const history = await client.call('token-a', 'GET', `/v2/threads/${threadID}?session_id=session-a`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((item: { id: string }) => item.id))
      .toEqual([request.body.data.id, reply.body.data.id]);
    expect(history.body.data[1].recipientSessionID).toBe('session-a');
    expect(client.deliveries).toHaveLength(3);
  });

  it('rolls back a new Thread when its first message cannot be stored', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const before = await env.DB.prepare('SELECT count(*) AS count FROM threads')
      .first<{ count: number }>();
    await env.DB.prepare(`
      CREATE TRIGGER reject_first_message BEFORE INSERT ON messages
      WHEN NEW.body = 'Test message persistence failure'
      BEGIN SELECT RAISE(ABORT, 'Test message persistence failure'); END
    `).run();

    try {
      const failed = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
        to: 'relay-test-org/beta/reviewer',
        body: 'Test message persistence failure',
      });

      expect(failed.status).toBe(500);
      expect(failed.body.error.code).toBe('internal_error');

      const after = await env.DB.prepare('SELECT count(*) AS count FROM threads')
        .first<{ count: number }>();
      expect(after?.count, 'A failed first Message must not leave an orphan Thread').toBe(before?.count);
      expect(client.deliveries, 'Transport must not run before both records commit').toHaveLength(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_first_message').run();
    }
  });
});
