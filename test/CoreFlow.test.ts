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
