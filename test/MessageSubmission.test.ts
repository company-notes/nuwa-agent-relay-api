import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Durable message submission after an uncertain provider response', () => {
  it('accepts once, preserves its ID and Thread, and recovers a delayed verified receipt', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();
    const path = '/v2/messages?session_id=session-a';
    const request = {
      submissionID: crypto.randomUUID(),
      to: 'relay-test-org/beta/reviewer',
      body: 'Please share the complete report as a file.',
    };

    client.loseNextMailAcknowledgement = true;
    const accepted = await client.call('token-a', 'POST', path, request);
    expect(accepted.status, 'Durable acceptance must not depend on the provider acknowledgement').toBe(201);
    expect(accepted.body.data.id).toBe(request.submissionID);
    expect(accepted.body.data.submissionStatus).toBe('pending');
    const threadID = accepted.body.data.threadId;

    const repeated = await client.call('token-a', 'POST', path, request);
    expect(repeated.status).toBe(201);
    expect(repeated.body.data.id).toBe(request.submissionID);
    expect(repeated.body.data.threadId).toBe(threadID);
    expect((await client.call('token-a', 'POST', path, {
      ...request, body: 'A different request must use a different submission ID.',
    })).status).toBe(409);

    await expect.poll(() => client.deliveries.length).toBe(1);
    const receiptPath = '/v2/messages/' + request.submissionID + '/receipt?session_id=session-a';
    await expect.poll(async () => (await client.call('token-a', 'GET', receiptPath)).body.data.outboxStatus)
      .toBe('uncertain');
    const saved = await env.DB.prepare('SELECT delivery_status, received_at FROM messages WHERE id = ?')
      .bind(request.submissionID).first();
    expect(saved).toEqual({ delivery_status: 'pending', received_at: null });

    const recipient = await client.call('token-b', 'POST', '/v2/agent-mailboxes?session_id=session-b');
    const sender = await client.call('token-a', 'POST', '/v2/agent-mailboxes?session_id=session-a');
    const receipt = await client.callWithHeaders('POST', '/v1/mailtrigger/receipt', {
      from: sender.body.data.mailboxEmail,
      receiver: recipient.body.data.mailboxEmail,
      subject: client.deliveries[0].subject,
    }, { 'x-relay-inbound-key': 'test-inbound-key' });
    expect(receipt.status).toBe(200);
    expect(receipt.body.data.matched).toBe(true);

    const delivered = await client.call('token-a', 'GET', receiptPath);
    expect(delivered.body.data).toMatchObject({
      submissionStatus: 'sent', arrivedInMailTrigger: true, outboxStatus: 'accepted',
    });
    expect((await client.call('token-c', 'GET',
      '/v2/messages/' + request.submissionID + '/receipt?session_id=session-c')).status).toBe(404);
    const event = await env.DB.prepare('SELECT session_id FROM inbox_events WHERE message_id = ?')
      .bind(request.submissionID).first();
    expect(event).toEqual({ session_id: 'session-b' });

    const final = await client.call('token-a', 'POST', path, request);
    expect(final.body.data.threadId).toBe(threadID);
    expect(final.body.data.submissionStatus).toBe('sent');
    expect(client.deliveries, 'An uncertain or accepted submission must never be blindly repeated').toHaveLength(1);
  });
});
