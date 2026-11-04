import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('automatic managed SMTP provisioning', () => {
  it('creates a sender rule, built-in SMTP action and an enabled route for each Host', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    expect(client.rules).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
    expect(client.routes).toHaveLength(2);

    for (const route of client.routes) {
      const mailbox = client.rules.find((rule) => rule.id === (route.rules as number[])[0]);
      const action = client.actions.find((candidate) => candidate.id === (route.actions as number[])[0]);

      expect(mailbox).toMatchObject({
        target: 'sender',
        ruleType: 'equals',
      });
      expect((mailbox?.value as string)).toMatch(/^nar-host[a-b]@relay-test\.example$/);
      expect(action).toMatchObject({ actionType: 'mailtrigger_smtp' });
      expect(route).toMatchObject({
        isEnabled: true,
        mailFilterOption: 'all',
        executionMechanism: 'sequential',
      });
    }
  });

  it('re-provisioning a Host reuses resources and repairs a missing or disabled route', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const original = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');
    expect(original.status).toBe(201);
    expect(original.body.data.created).toBe(false);
    expect(client.rules).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
    expect(client.routes).toHaveLength(2);

    client.routes.splice(0, 1);
    const restored = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(restored.status).toBe(201);
    expect(client.rules).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
    expect(client.routes).toHaveLength(2);

    const damaged = client.routes.find((route) => route.mailbox === '1');

    expect(damaged).toBeDefined();

    damaged!.isEnabled = false;

    const repaired = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(repaired.status).toBe(201);
    expect(damaged!.isEnabled).toBe(true);
  });

  it('does not persist Host readiness when route creation fails, and retries safely', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.failNextRouteCreation = true;

    const rejected = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe('mailtrigger_route_failed');

    const pending = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first<{ count: number }>();

    expect(pending?.count).toBe(0);

    const ready = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(ready.status).toBe(201);
    expect(ready.body.data.mailboxId).toBeDefined();
    expect(client.rules).toHaveLength(1);
    expect(client.actions).toHaveLength(1);
    expect(client.routes).toHaveLength(1);
  });

  it('does not report an existing Host ready if the upstream Route cannot be checked', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const initial = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');
    expect(initial.status).toBe(201);

    client.failNextRouteLookup = true;

    const failed = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('mailtrigger_route_lookup_failed');
  });
});
