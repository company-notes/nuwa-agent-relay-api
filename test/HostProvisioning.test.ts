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
      const mailbox = client.rules.find((rule) => rule.id === (route.ruleConfigs as number[])[0]);
      const action = client.actions.find((candidate) => candidate.id === (route.actions as number[])[0]);

      expect(mailbox).toMatchObject({
        target: 1,
        ruleType: 1,
        user: 31,
      });
      const address = 'nar-host' + (route.mailbox === 1 ? 'a' : 'b') + '@relay-test.example';
      const expression = new RegExp(mailbox?.value as string);

      expect(mailbox?.value).toBe('^' + address.replace('.', '\\.') + '
      expect(route).toMatchObject({
        isActive: true,
        filterOption: 1,
        ruleGroup: 1,
      });
    }

    expect(client.routeCreationBodies).toHaveLength(2);
    expect(client.routeCreationBodies.every((body) => !('ruleGroup' in body))).toBe(true);
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

    const damaged = client.routes.find((route) => route.mailbox === 1);

    expect(damaged).toBeDefined();

    damaged!.isActive = false;

    const repaired = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(repaired.status).toBe(201);
    expect(damaged!.isActive).toBe(true);
  });

  it('does not persist Host readiness when route creation fails, and retries safely', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    // The isolated D1 database can retain an earlier test case's Host.
    await env.DB.prepare('DELETE FROM paired_hosts WHERE host_address_id = ?').bind('host-a').run();

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

  it('rejects an action template that is not MailTrigger SMTP', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.templates[0].displayName = 'SMTP to Origin';
    client.templates[0].actionName = 'SMTPOrigin';

    const invalid = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(invalid.status).toBe(503);
    expect(invalid.body.error.code).toBe('mailtrigger_smtp_template_invalid');
    expect(client.routes).toHaveLength(0);
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
);
      expect(expression.test(address)).toBe(true);
      expect(expression.test(address.replace('.example', 'Xexample'))).toBe(false);
      expect(expression.test('prefix-' + address)).toBe(false);
      expect(expression.test(address + '-suffix')).toBe(false);
      expect(action).toMatchObject({ action: 21, user: 31 });
      expect(route).toMatchObject({
        isActive: true,
        filterOption: 1,
        ruleGroup: 1,
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

    const damaged = client.routes.find((route) => route.mailbox === 1);

    expect(damaged).toBeDefined();

    damaged!.isActive = false;

    const repaired = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(repaired.status).toBe(201);
    expect(damaged!.isActive).toBe(true);
  });

  it('does not persist Host readiness when route creation fails, and retries safely', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    // The isolated D1 database can retain an earlier test case's Host.
    await env.DB.prepare('DELETE FROM paired_hosts WHERE host_address_id = ?').bind('host-a').run();

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

  it('rejects an action template that is not MailTrigger SMTP', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.templates[0].displayName = 'SMTP to Origin';
    client.templates[0].actionName = 'SMTPOrigin';

    const invalid = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');

    expect(invalid.status).toBe(503);
    expect(invalid.body.error.code).toBe('mailtrigger_smtp_template_invalid');
    expect(client.routes).toHaveLength(0);
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
