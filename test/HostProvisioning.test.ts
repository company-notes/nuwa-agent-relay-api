import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailTriggerClient } from '../src/MailTriggerClient';
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

      expect(mailbox?.value).toBe('^' + address.replace('.', '\\.') + '$');
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

    expect(client.routeCreationBodies).toHaveLength(2);
    expect(client.routeCreationBodies.every((body) => !('ruleGroup' in body))).toBe(true);
  });

  it('removes only SMTP to Origin defaults after verifying each managed Route', async () => {
    const client = new RelayTestClient();
    client.providerCreatesOriginRoutes = true;
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    expect(client.routes).toHaveLength(4);
    expect(client.routes.filter((route) => route.name === 'SMTP to Origin Router')).toHaveLength(0);
    expect(client.routes.filter((route) => route.name === 'Relay to Origin')).toHaveLength(2);
    expect(client.routes.filter((route) => String(route.name).startsWith('NAR route '))).toHaveLength(2);

    const again = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(again.status).toBe(201);
    expect(client.routes).toHaveLength(4);
  });

  it('deletes only the exact inbound Relay to Origin Route after the receipt Route is active', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const a = await client.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');
    const b = await client.call('token-b', 'POST', '/v1/hosts/provision?work_address_id=work-b');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const mailboxA = Number(a.body.data.mailboxId);
    const mailboxB = Number(b.body.data.mailboxId);
    for (const [id, mailbox] of [[155, mailboxA], [156, mailboxB]]) {
      client.routes.push({
        id, name: 'Relay to Origin Route', mailbox, ruleGroup: 1,
        filterOption: 1, ruleConfigs: [], actions: [], isActive: true,
      });
    }

    const provider = new MailTriggerClient({
      ...env,
      MAILTRIGGER_RECEIPT_URL: 'https://agent-relay.company-notes.com/v1/mailtrigger/receipt',
      MAILTRIGGER_INBOUND_KEY: 'test-inbound-key',
    });
    await provider.ensureManagedSMTPRoute({
      mailboxId: a.body.data.mailboxId,
      mailboxEmail: a.body.data.mailboxEmail,
      created: false,
    });

    expect(client.routes.some((route) => route.id === 155)).toBe(false);
    expect(client.routes.find((route) => route.id === 156)).toMatchObject({
      name: 'Relay to Origin Route', mailbox: mailboxB,
    });
    expect(client.routes.find((route) => route.name === `NAR receipt ${mailboxA}`))
      .toMatchObject({ mailbox: mailboxA, isActive: true });
  });

  it('also cleans up the legacy SMTP to Origin default for the same mailbox', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const first = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(first.status).toBe(201);

    client.routes.push({
      id: 901,
      name: 'SMTP to Origin',
      mailbox: 1,
      ruleGroup: 1,
      filterOption: 3,
      ruleConfigs: [],
      actions: [],
      isActive: true,
    });

    const repaired = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');

    expect(repaired.status).toBe(201);
    expect(client.routes.some((route) => route.id === 901)).toBe(false);
    expect(client.routes.find((route) => route.name === 'NAR route 1')?.isActive).toBe(true);
  });

  it('keeps unrelated custom routes and another mailbox default untouched', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.routes.push({
      id: 100,
      name: 'SMTP to Origin Router',
      mailbox: 9999,
      ruleGroup: 1,
      filterOption: 3,
      ruleConfigs: [],
      actions: [],
      isActive: true,
    });
    client.routes.push({
      id: 101,
      name: 'smtp to origin',
      mailbox: 1,
      ruleGroup: 1,
      filterOption: 3,
      ruleConfigs: [],
      actions: [],
      isActive: true,
    });
    client.routes.push({
      id: 102,
      name: 'Custom outbound route',
      mailbox: 1,
      ruleGroup: 1,
      filterOption: 3,
      ruleConfigs: [],
      actions: [],
      isActive: true,
    });

    const created = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');

    expect(created.status).toBe(201);
    expect(client.routes.map((route) => route.id)).toEqual(expect.arrayContaining([100, 101, 102]));
  });

  it('keeps Host unready if removing the default origin Route fails, and can retry', async () => {
    const client = new RelayTestClient();
    client.providerCreatesOriginRoutes = true;
    client.installExternalTestTransport();
    await env.DB.prepare('DELETE FROM paired_hosts WHERE host_address_id = ?').bind('host-a').run();
    client.failNextRouteDeletion = true;

    const failure = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');

    expect(failure.status).toBe(502);
    expect(failure.body.error.code).toBe('mailtrigger_cleanup_failed');
    expect(client.routes.some((route) => route.name === 'SMTP to Origin Router')).toBe(true);

    const paired = await env.DB.prepare(
      'SELECT mailbox_id FROM paired_hosts WHERE host_address_id = ?',
    ).bind('host-a').first();
    expect(paired).toBeNull();

    const retry = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(retry.status).toBe(201);
    expect(client.routes.some((route) => route.name === 'SMTP to Origin Router')).toBe(false);
  });

  it('refuses ambiguous or Nuwa-linked SMTP to Origin routes without deleting them', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const initial = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(initial.status).toBe(201);

    const managed = client.routes.find((route) => route.name === 'NAR route 1')!;
    client.routes.push({
      id: 900,
      name: 'SMTP to Origin Router',
      mailbox: 1,
      ruleGroup: 1,
      filterOption: 1,
      ruleConfigs: managed.ruleConfigs,
      actions: managed.actions,
      isActive: true,
    });

    const protectedResult = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(protectedResult.status).toBe(409);
    expect(protectedResult.body.error.code).toBe('mailtrigger_origin_route_conflict');
    expect(client.routes.find((route) => route.id === 900)).toBeDefined();

    client.routes.push({
      id: 901,
      name: 'SMTP to Origin',
      mailbox: 1,
      ruleGroup: 1,
      filterOption: 3,
      ruleConfigs: [],
      actions: [],
      isActive: true,
    });

    const ambiguous = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(ambiguous.status).toBe(502);
    expect(ambiguous.body.error.code).toBe('mailtrigger_origin_route_ambiguous');
    expect(client.routes.filter((route) => ['SMTP to Origin', 'SMTP to Origin Router'].includes(String(route.name)))).toHaveLength(2);
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
