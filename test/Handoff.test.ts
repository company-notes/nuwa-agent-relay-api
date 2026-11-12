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

    const alreadyAccepted = await client.call(
      'token-b', 'POST', `/v2/handoffs/${handoffId}/accept?session_id=session-b`,
    );
    expect(alreadyAccepted.status).toBe(409);

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

  it('can retry accepting an Agent handoff after a MailTrigger delivery failure', async () => {
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
    expect(pending.body.data, 'A failed acknowledgement must not permanently consume the handoff').toHaveLength(1);

    const retry = await client.call(
      'token-b', 'POST',
      `/v2/handoffs/${handoff.body.data.id}/accept?session_id=session-b`,
    );

    expect(retry.status, 'The same Session must be able to retry acceptance').toBe(201);
  });
});
