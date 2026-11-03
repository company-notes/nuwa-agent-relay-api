import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Scoped Smoke resource deletion', () => {
  it('refuses ordinary Host and mismatched run ID without touching data', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const denied = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=0123456789');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('smoke_cleanup_forbidden');

    client.enableSmokeIdentities('aabbccddee');

    const wrongRun = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=0123456789');
    expect(wrongRun.status).toBe(403);

    const paired = await env.DB.prepare(
      'SELECT mailbox_id FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first();
    expect(paired).not.toBeNull();
  });

  it('deletes only exact smoke Host Mailboxes and linked D1 records, is idempotent', async () => {
    const client = new RelayTestClient();
    client.enableSmokeIdentities('aabbccddee');
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const message = await client.call('token-a', 'POST',
      '/v1/messages?work_address_id=work-a', {
        to: '@relay-smoke-aabbccddee-b/relay-smoke-aabbccddee-b',
        body: 'Scoped test message should be removed during cleanup.',
      });
    expect(message.status).toBe(201);

    const deletedA = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=aabbccddee');
    expect(deletedA.status).toBe(200);
    expect(deletedA.body.data.mailboxRemoved).toBe(true);

    const remaining = await env.DB.prepare(
      'SELECT id FROM threads WHERE id = ?',
    ).bind(message.body.data.threadId).first();
    expect(remaining).toBeNull();

    const again = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=aabbccddee');
    expect(again.status).toBe(200);
    expect(again.body.data.mailboxRemoved).toBe(false);

    const deletedB = await client.call('token-b', 'DELETE',
      '/v1/smoke/host?work_address_id=work-b&run_id=aabbccddee');
    expect(deletedB.status).toBe(200);

    const hosts = await env.DB.prepare(
      'SELECT host_address_id FROM paired_hosts WHERE host_address_id IN (?, ?)',
    ).bind('host-a', 'host-b').all();
    expect(hosts.results).toHaveLength(0);
  });
});
