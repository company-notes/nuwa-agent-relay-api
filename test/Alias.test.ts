import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('External identity aliases', () => {
  it('requires operator verification before routing a normalized email address', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const emailAlias = await client.call('token-b', 'POST', '/v1/aliases?work_address_id=work-b', {
      provider: 'email',
      externalId: 'Reviewer@Example.com',
    });
    expect(emailAlias.status, 'Registration should succeed in a pending state').toBe(201);
    expect(emailAlias.body.data.verified).toBe(false);

    const pending = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: 'reviewer@example.com',
      body: 'Review the patch',
    });
    expect(pending.status, 'Unverified aliases must not receive delivery').toBe(404);

    const deniedVerification = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${emailAlias.body.data.id}/verification?work_address_id=work-b`,
    );
    expect(deniedVerification.status, 'Alias owner alone cannot prove external ID ownership').toBe(403);

    const verified = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${emailAlias.body.data.id}/verification?work_address_id=work-b`,
      undefined,
      'test-alias-verification-key',
    );
    expect(verified.status).toBe(200);

    const routed = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: 'REVIEWER@example.com',
      body: 'Please review this change.',
    });
    expect(routed.status, 'Verified email aliases should route case-insensitively').toBe(201);

    const inbox = await client.call('token-b', 'GET', '/v1/inbox?work_address_id=work-b');
    expect(inbox.body.data[0].body).toBe('Please review this change.');
  });

  it('revoking a verified GrokBot UUID prevents subsequent delivery', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const grokAlias = await client.call('token-b', 'POST', '/v1/aliases?work_address_id=work-b', {
      provider: 'grokbot',
      externalId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(grokAlias.status).toBe(201);

    const grokVerified = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${grokAlias.body.data.id}/verification?work_address_id=work-b`,
      undefined,
      'test-alias-verification-key',
    );
    expect(grokVerified.status).toBe(200);

    const routed = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: { provider: 'grokbot', externalId: '550e8400-e29b-41d4-a716-446655440000' },
      body: 'Before revocation.',
    });
    expect(routed.status).toBe(201);

    const revoked = await client.call(
      'token-b', 'DELETE',
      `/v1/aliases/${grokAlias.body.data.id}?work_address_id=work-b`,
    );
    expect(revoked.status).toBe(200);

    const noLongerRoutable = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: { provider: 'grokbot', externalId: '550e8400-e29b-41d4-a716-446655440000' },
      body: 'This should fail.',
    });
    expect(noLongerRoutable.status).toBe(404);
  });
  });

  it('cannot claim an active email alias already owned by another work identity', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const created = await client.call('token-a', 'POST', '/v1/aliases?work_address_id=work-a', {
      provider: 'email',
      externalId: 'same@example.com',
    });
    expect(created.status).toBe(201);

    const duplicate = await client.call('token-b', 'POST', '/v1/aliases?work_address_id=work-b', {
      provider: 'email',
      externalId: 'Same@Example.com',
    });
    expect(duplicate.status, 'An alias cannot be reassigned without revocation').toBe(409);
    expect(duplicate.body.error.code).toBe('alias_exists');

    const rows = await env.DB.prepare(
      'SELECT work_address_id FROM agent_aliases WHERE provider = ? AND external_id = ? AND revoked_at IS NULL',
    ).bind('email', 'same@example.com').all<{ work_address_id: string }>();

    expect(rows.results, 'The existing alias owner must remain unchanged').toHaveLength(1);
    expect(rows.results[0].work_address_id).toBe('work-a');
  });
});
