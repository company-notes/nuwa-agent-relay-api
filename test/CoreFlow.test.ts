import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Nuwa Agent Relay core messaging flow', () => {
  it('delivers, persists and replies to a canonical work-address thread', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const outbound = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: '@beta/reviewer',
      body: 'Please check the release build.',
      artifactLinks: ['https://files.example.com/build.zip'],
    });

    expect(outbound.status).toBe(201);
    const threadId = outbound.body.data.threadId as string;

    const inbox = await client.call('token-b', 'GET', '/v1/inbox?work_address_id=work-b');
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
      `/v1/threads/${threadId}/messages?work_address_id=work-b`,
      { body: 'Verified. Build passes on Linux.' },
    );
    expect(reply.status).toBe(201);

    const history = await client.call('token-a', 'GET', `/v1/threads/${threadId}?work_address_id=work-a`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((item: any) => item.body)).toContain('Verified. Build passes on Linux.');

    expect(client.deliveries, 'MailTrigger must receive both transport calls').toHaveLength(2);
    expect(client.deliveries[0].subject).toMatch(/^\[NAR:/);
  });
});
