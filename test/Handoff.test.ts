import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Host handoff flow', () => {
  it('requires the same work identity for threads and permits host-targeted handoff acceptance', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const handoff = await client.call('token-a', 'POST', '/v1/handoffs?work_address_id=work-a', {
      to: '@beta',
      subject: 'Sign this release',
      body: 'Please sign the attached artifacts.',
    });

    expect(handoff.status).toBe(201);
    const handoffId = handoff.body.data.id as string;

    const waiting = await client.call('token-b', 'GET', '/v1/host-inbox?work_address_id=work-b');
    expect(waiting.status).toBe(200);
    expect(waiting.body.data[0].body).toBe('Please sign the attached artifacts.');

    const rejectedUnacceptedReply = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/reply?work_address_id=work-b`,
      { body: 'Not accepted yet' },
    );
    expect(rejectedUnacceptedReply.status).toBe(404);

    const accepted = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/accept?work_address_id=work-b`,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.acceptedBy).toBe('relay-test-org/beta/reviewer');

    const alreadyAccepted = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/accept?work_address_id=work-b`,
    );
    expect(alreadyAccepted.status).toBe(409);

    const reply = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/reply?work_address_id=work-b`,
      { body: 'The release is signed.' },
    );
    expect(reply.status).toBe(201);

    const thread = await client.call(
      'token-a', 'GET', `/v1/threads/${handoff.body.data.threadId}?work_address_id=work-a`,
    );
    expect(thread.status).toBe(200);
    expect(thread.body.data).toHaveLength(3);

    const unauthorized = await client.call(null, 'GET', '/v1/inbox?work_address_id=work-b');
    expect(unauthorized.status).toBe(401);

    const mismatchedIdentity = await client.call('token-a', 'GET', '/v1/inbox?work_address_id=work-b');
    expect(mismatchedIdentity.status).toBe(403);
  });

  it('can retry accepting a host handoff after a MailTrigger delivery failure', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const handoff = await client.call('token-a', 'POST', '/v1/handoffs?work_address_id=work-a', {
      to: '@beta',
      subject: 'Confirm the release',
      body: 'Please acknowledge.',
    });
    expect(handoff.status).toBe(201);

    client.failNextMail = true;
    const failed = await client.call(
      'token-b', 'POST',
      `/v1/handoffs/${handoff.body.data.id}/accept?work_address_id=work-b`,
    );

    expect(failed.status, 'MailTrigger failure must be surfaced').toBe(502);

    const pending = await client.call('token-b', 'GET', '/v1/host-inbox?work_address_id=work-b');
    expect(pending.body.data, 'A failed acknowledgement must not permanently consume the handoff').toHaveLength(1);

    const retry = await client.call(
      'token-b', 'POST',
      `/v1/handoffs/${handoff.body.data.id}/accept?work_address_id=work-b`,
    );

    expect(retry.status, 'The same host must be able to retry acceptance').toBe(201);
  });
});
