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

    const acknowledged = await client.call('token-b', 'POST',
      '/v1/messages/' + message.body.data.id + '/read?work_address_id=work-b');
    expect(acknowledged.status).toBe(201);

    const deletedA = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=aabbccddee');
    expect(deletedA.status).toBe(200);
    expect(deletedA.body.data.mailboxRemoved).toBe(true);
    expect(deletedA.body.data.managedRoutingChecked).toBe(true);
    expect(deletedA.body.data.providerUserCleanup).toBe('not_verified');
    expect(client.routes).toHaveLength(1);
    expect(client.actions).toHaveLength(1);
    expect(client.rules).toHaveLength(1);

    const remaining = await env.DB.prepare(
      'SELECT id FROM threads WHERE id = ?',
    ).bind(message.body.data.threadId).first();
    expect(remaining).toBeNull();

    const readReceipts = await env.DB.prepare(
      'SELECT message_id FROM message_read_receipts WHERE message_id = ?',
    ).bind(message.body.data.id).all();
    expect(readReceipts.results).toHaveLength(0);

    const again = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=aabbccddee');
    expect(again.status).toBe(200);
    expect(again.body.data.mailboxRemoved).toBe(false);

    const deletedB = await client.call('token-b', 'DELETE',
      '/v1/smoke/host?work_address_id=work-b&run_id=aabbccddee');
    expect(deletedB.status).toBe(200);
    expect(client.routes).toHaveLength(0);
    expect(client.actions).toHaveLength(0);
    expect(client.rules).toHaveLength(0);

    const hosts = await env.DB.prepare(
      'SELECT host_address_id FROM paired_hosts WHERE host_address_id IN (?, ?)',
    ).bind('host-a', 'host-b').all();
    expect(hosts.results).toHaveLength(0);
  });

  it('does not delete D1 records or a mailbox when managed Route cleanup fails', async () => {
    const client = new RelayTestClient();
    client.enableSmokeIdentities('bbccddeeaa');
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    client.failNextRouteDeletion = true;

    const failed = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=bbccddeeaa');

    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('mailtrigger_cleanup_failed');
    expect(client.routes).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
    expect(client.rules).toHaveLength(2);

    const pending = await env.DB.prepare(
      'SELECT mailbox_id FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first();

    expect(pending).not.toBeNull();

    const retried = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=bbccddeeaa');

    expect(retried.status).toBe(200);
    expect(client.routes).toHaveLength(1);
    expect(client.actions).toHaveLength(1);
    expect(client.rules).toHaveLength(1);
  });

  it('refuses to remove a managed resource shared with an unrelated Route', async () => {
    const client = new RelayTestClient();
    client.enableSmokeIdentities('ccddee1122');
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    client.routes.push({
      id: 999,
      name: 'External Route',
      mailbox: 2,
      ruleGroup: 1,
      filterOption: 1,
      ruleConfigs: [client.rules[0].id],
      actions: [client.actions[0].id],
      isActive: true,
    });

    const blocked = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=ccddee1122');

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('mailtrigger_cleanup_shared_resource');
    expect(client.routes).toHaveLength(3);
    expect(client.actions).toHaveLength(2);
    expect(client.rules).toHaveLength(2);

    const paired = await env.DB.prepare(
      'SELECT mailbox_id FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first();

    expect(paired).not.toBeNull();
  });

  it('retries after a partial Route delete without losing the D1 Host', async () => {
    const client = new RelayTestClient();
    client.enableSmokeIdentities('ddeeff1122');
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    client.failNextActionDeletion = true;

    const failed = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=ddeeff1122');

    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('mailtrigger_cleanup_failed');
    expect(client.routes).toHaveLength(1);
    expect(client.actions).toHaveLength(2);
    expect(client.rules).toHaveLength(2);

    const pending = await env.DB.prepare(
      'SELECT mailbox_id FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first();

    expect(pending).not.toBeNull();

    const retried = await client.call('token-a', 'DELETE',
      '/v1/smoke/host?work_address_id=work-a&run_id=ddeeff1122');

    expect(retried.status).toBe(200);
    expect(client.routes).toHaveLength(1);
    expect(client.actions).toHaveLength(1);
    expect(client.rules).toHaveLength(1);
  });
});
