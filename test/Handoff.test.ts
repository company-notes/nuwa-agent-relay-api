import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Agent handoff flow', () => {
  it('keeps Session replies isolated and permits Agent-targeted handoff acceptance', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const handoff = await client.call('token-a', 'POST', '/v2/handoffs?session_id=session-a', {
      to: 'relay-test-org/beta',
      subject: 'Sign this release',
      body: 'Please sign the attached artifacts.',
    });

    expect(handoff.status).toBe(201);
    const handoffId = handoff.body.data.id as string;

    const waiting = await client.call('token-b', 'GET', '/v2/agent-inbox?session_id=session-b');
    expect(waiting.status).toBe(200);
    expect(waiting.body.data[0].body).toBe('Please sign the attached artifacts.');

    const rejectedUnacceptedReply = await client.call(
      'token-b', 'POST', `/v2/handoffs/${handoffId}/reply?session_id=session-b`,
      { body: 'Not accepted yet' },
    );
    expect(rejectedUnacceptedReply.status).toBe(404);

    const accepted = await client.call(
      'token-b', 'POST', `/v2/handoffs/${handoffId}/accept?session_id=session-b`,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.acceptedBy).toBe('relay-test-org/beta/reviewer');

    const deliveriesAfterAcceptance = client.deliveries.length;
    const alreadyAccepted = await client.call(
      'token-b', 'POST', `/v2/handoffs/${handoffId}/accept?session_id=session-b`,
    );
    expect(alreadyAccepted.status, 'The same accepting Session is idempotent').toBe(201);
    expect(alreadyAccepted.body.data.id).toBe(accepted.body.data.id);
    expect(alreadyAccepted.body.data.alreadyAccepted).toBe(true);
    expect(client.deliveries, 'A duplicate accept must not send again').toHaveLength(deliveriesAfterAcceptance);

    const reply = await client.call(
      'token-b', 'POST', `/v2/handoffs/${handoffId}/reply?session_id=session-b`,
      { body: 'The release is signed.' },
    );
    expect(reply.status).toBe(201);

    const thread = await client.call(
      'token-a', 'GET', `/v2/threads/${handoff.body.data.threadId}?session_id=session-a`,
    );
    expect(thread.status).toBe(200);
    expect(thread.body.data).toHaveLength(3);

    const unauthorized = await client.call(null, 'GET', '/v2/inbox?session_id=session-b');
    expect(unauthorized.status).toBe(401);

    const mismatchedIdentity = await client.call('token-a', 'GET', '/v2/inbox?session_id=session-b');
    expect(mismatchedIdentity.status).toBe(409);
  });

  it('keeps exclusive ownership and one notification after an uncertain MailTrigger failure', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const handoff = await client.call('token-a', 'POST', '/v2/handoffs?session_id=session-a', {
      to: 'relay-test-org/beta',
      subject: 'Confirm the release',
      body: 'Please acknowledge.',
    });
    expect(handoff.status).toBe(201);

    client.failNextMail = true;
    const failed = await client.call(
      'token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-b`,
    );

    expect(failed.status, 'MailTrigger failure must be surfaced').toBe(502);

    const pending = await client.call('token-b', 'GET', '/v2/agent-inbox?session_id=session-b');
    expect(pending.body.data, 'A committed acceptance is not offered to another Session').toHaveLength(0);

    const transmissions = client.deliveries.length;
    const retry = await client.call(
      'token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-b`,
    );

    expect(retry.status, 'The accepting Session can read its committed outcome').toBe(201);
    expect(retry.body.data.alreadyAccepted).toBe(true);
    expect(retry.body.data.notificationStatus, 'Transport uncertainty must remain observable').toBe('failed');
    expect(client.deliveries, 'A retry must not generate an uncertain duplicate email').toHaveLength(transmissions);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND kind = 'acceptance'",
    ).bind(handoff.body.data.threadId).first<{ count: number }>();
    expect(count?.count, 'Only one acceptance message may exist').toBe(1);
  });

  it('retains one accepted Session when MailTrigger delivers but its acknowledgement is lost', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const handoff = await client.call('token-a', 'POST', '/v2/handoffs?session_id=session-a', {
      to: 'relay-test-org/beta',
      subject: 'Review the release',
      body: 'Please inspect the release before deployment.',
    });
    expect(handoff.status).toBe(201);

    client.loseNextMailAcknowledgement = true;
    const interrupted = await client.call('token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-b`);
    expect(interrupted.status, 'A missing provider acknowledgement must remain visible').toBe(502);

    const owner = await env.DB.prepare(
      'SELECT accepted_session_id AS acceptedSessionID FROM threads WHERE id = ?',
    ).bind(handoff.body.data.threadId).first<{ acceptedSessionID: string | null }>();
    expect(owner?.acceptedSessionID, 'The accepted Runtime must remain the exclusive owner').toBe('session-b');

    const acceptance = await env.DB.prepare(
      "SELECT id, delivery_status AS deliveryStatus FROM messages WHERE thread_id = ? AND kind = 'acceptance'",
    ).bind(handoff.body.data.threadId).all<{ id: string; deliveryStatus: string }>();
    expect(acceptance.results, 'A single durable acceptance notification must exist').toHaveLength(1);
    expect(acceptance.results[0].deliveryStatus).toBe('failed');

    const mailboxes = await env.DB.prepare(
      'SELECT agent_id AS agentID, mailbox_email AS mailboxEmail FROM agent_mailboxes',
    ).all<{ agentID: string; mailboxEmail: string }>();
    const from = mailboxes.results.find((row) => row.agentID === 'agent-000b')?.mailboxEmail;
    const receiver = mailboxes.results.find((row) => row.agentID === 'agent-000a')?.mailboxEmail;
    expect(from).toBeTruthy();
    expect(receiver).toBeTruthy();

    const receipt = await client.callWithHeaders('POST', '/v1/mailtrigger/receipt', {
      from, receiver, subject: client.deliveries.at(-1)!.subject,
    }, { 'x-relay-inbound-key': 'test-inbound-key' });
    expect(receipt.status, 'The independent recipient receipt must be accepted').toBe(200);
    expect(receipt.body.data.matched).toBe(true);

    const confirmed = await env.DB.prepare(
      'SELECT received_at AS receivedAt, delivery_status AS deliveryStatus FROM messages WHERE id = ?',
    ).bind(acceptance.results[0].id)
      .first<{ receivedAt: string | null; deliveryStatus: string }>();
    expect(confirmed?.receivedAt, 'MailTrigger receipt overrides missing send acknowledgement').toBeTruthy();
    expect(confirmed?.deliveryStatus).toBe('sent');

    const deliveryCount = client.deliveries.length;
    const retried = await client.call('token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-b`);
    expect(retried.status, 'The same Session may safely retry the accepted operation').toBe(201);
    expect(retried.body.data.id).toBe(acceptance.results[0].id);
    expect(client.deliveries, 'The retry must not submit a second acceptance').toHaveLength(deliveryCount);

    const competing = await client.call('token-c', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-c`);
    expect(competing.status, 'A sibling Session must never steal the Handoff').toBe(409);

    const reply = await client.call('token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/reply?session_id=session-b`,
      { body: 'Release reviewed by the original accepting Session.' });
    expect(reply.status).toBe(201);

    const history = await client.call('token-a', 'GET',
      `/v2/threads/${handoff.body.data.threadId}?session_id=session-a`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(3);
  });

  it('keeps Agent-level handoff exclusive across sibling Sessions', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const handoff = await client.call('token-a', 'POST', '/v2/handoffs?session_id=session-a', {
      to: 'relay-test-org/beta',
      subject: 'Review deployment',
      body: 'One Session accepts.',
    });
    expect(handoff.status).toBe(201);

    const pending = await client.call('token-c', 'GET', '/v2/agent-inbox?session_id=session-c');
    expect(pending.body.data.some((item: { id: string }) => item.id === handoff.body.data.id))
      .toBe(true);

    const accepted = await client.call('token-c', 'POST',
      '/v2/handoffs/' + handoff.body.data.id + '/accept?session_id=session-c');
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.acceptedBy).toBe('relay-test-org/beta/observer');

    const duplicate = await client.call('token-b', 'POST',
      '/v2/handoffs/' + handoff.body.data.id + '/accept?session_id=session-b');
    expect(duplicate.status).toBe(409);

    const foreignHistory = await client.call('token-b', 'GET',
      '/v2/threads/' + handoff.body.data.threadId + '?session_id=session-b');
    expect(foreignHistory.status).toBe(404);

    const reply = await client.call('token-c', 'POST',
      '/v2/handoffs/' + handoff.body.data.id + '/reply?session_id=session-c',
      { body: 'Reviewed by the accepted Session.' });
    expect(reply.status).toBe(201);

    const history = await client.call('token-a', 'GET',
      '/v2/threads/' + handoff.body.data.threadId + '?session_id=session-a');
    expect(history.body.data.map((message: { body: string }) => message.body))
      .toContain('Reviewed by the accepted Session.');
  });
});
