import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailTriggerClient } from '../src/MailTriggerClient';
import { RelayTestClient } from './RelayTestClient';

const RECEIPT_URL = 'https://nuwa-tunnel.example.com/v1/mailtrigger/receipt';

function enabledProvider(overrides: Record<string, string> = {}) {
  return new MailTriggerClient({
    ...env,
    MAILTRIGGER_RECEIPT_URL: RECEIPT_URL,
    MAILTRIGGER_INBOUND_KEY: 'test-inbound-key',
    ...overrides,
  });
}

function addProviderOriginRoute(
  client: RelayTestClient,
  id: number,
  mailbox: number,
  name = 'Relay to Origin Route',
  ruleConfigs: number[] = [],
  actions: number[] = [],
): void {
  client.routes.push({
    id, name, mailbox, ruleGroup: 1, filterOption: 1,
    ruleConfigs, actions, isActive: true,
  });
}

describe('Recipient MailTrigger Webhook Route', () => {
  it('creates a verified recipient route and configured Webhook Action alongside sender RelaySMTP', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST',
      '/v2/agents/mailbox?session_id=session-a');
    expect(ready.status).toBe(201);

    const mailbox = ready.body.data;
    const provider = enabledProvider();

    await provider.ensureManagedSMTPRoute({
      mailboxId: mailbox.mailboxId,
      mailboxEmail: mailbox.mailboxEmail,
      created: false,
    });

    expect(client.rules).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
    expect(client.routes).toHaveLength(2);

    const smtp = client.routes.find((row) => row.name === 'NAR route 1')!;
    const receipt = client.routes.find((row) => row.name === 'NAR receipt 1')!;
    const webhook = client.actions.find((row) => row.name === 'NAR receipt webhook 1')!;

    expect(smtp.actions).toHaveLength(1);
    expect(receipt).toMatchObject({
      isActive: true,
      filterOption: 1,
      ruleConfigs: [client.rules.find((rule) => rule.note === 'NAR recipient 1')?.id],
      actions: [webhook.id],
      mailbox: 1,
      passToNextRouter: true,
    });
    expect(webhook).toMatchObject({ action: 22, user: 31 });
    expect(client.rules.find((rule) => rule.note === 'NAR recipient 1')).toMatchObject({
      target: 2,
      ruleType: 1,
      value: '^nar-hosta@relay-test\\.example$',
      user: 31,
    });

    const params = new Map(client.webhookParameters.get(Number(webhook.id))!
      .map((row) => [row.fieldName, row.value]));
    expect(params.get('method')).toBe('POST');
    expect(params.get('webhook_url')).toBe(RECEIPT_URL);
    expect(JSON.parse(String(params.get('headers')))).toEqual({
      'Content-Type': 'application/json',
      'X-Relay-Inbound-Key': 'test-inbound-key',
    });
    expect(JSON.parse(String(params.get('data')))).toEqual({
      from: '$SENDER',
      receiver: '$RECEIVERS',
      subject: '$SUBJECT',
    });

    // Repeat provisioning must not duplicate either Action or Route.
    await provider.ensureManagedSMTPRoute({
      mailboxId: mailbox.mailboxId,
      mailboxEmail: mailbox.mailboxEmail,
      created: false,
    });
    expect(client.routes).toHaveLength(2);
    expect(client.actions).toHaveLength(2);
  });

  it('fails closed when Webhook Action parameters cannot be configured; retries safely', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const ready = await client.call('token-a', 'POST',
      '/v2/agents/mailbox?session_id=session-a');
    expect(ready.status).toBe(201);

    const provider = enabledProvider();
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };

    client.failNextWebhookParameterUpdate = true;
    await expect(provider.ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_webhook_parameters_failed',
    });
    expect(client.routes.some((route) => route.name === 'NAR receipt 1')).toBe(false);

    await provider.ensureManagedSMTPRoute(mailbox);
    expect(client.routes.some((route) => route.name === 'NAR receipt 1')).toBe(true);
  });

  it('refuses missing receipt key and invalid URL without publishing a recipient route', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const ready = await client.call('token-a', 'POST',
      '/v2/agents/mailbox?session_id=session-a');
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };

    await expect(enabledProvider({ MAILTRIGGER_INBOUND_KEY: '' })
      .ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_receipt_unconfigured',
    });
    await expect(enabledProvider({
      MAILTRIGGER_RECEIPT_URL: 'http://nuwa-tunnel.example.com/v1/mailtrigger/receipt',
    }).ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_receipt_url_invalid',
    });
    expect(client.routes.some((route) => route.name === 'NAR receipt 1')).toBe(false);
  });

  it('smoke cleanup deletes both managed routes and actions without leaving webhook configuration', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const ready = await client.call('token-a', 'POST',
      '/v2/agents/mailbox?session_id=session-a');
    const provider = enabledProvider();
    await provider.ensureManagedSMTPRoute({
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    });
    expect(client.routes).toHaveLength(2);
    expect(client.actions).toHaveLength(2);

    await provider.deleteManagedMailbox(String(ready.body.data.mailboxId), 'nar-hosta');

    expect(client.routes).toHaveLength(0);
    expect(client.actions).toHaveLength(0);
    expect(client.rules).toHaveLength(0);
    expect(client.webhookParameters.size).toBe(0);

    await provider.deleteManagedMailbox(String(ready.body.data.mailboxId), 'nar-hosta');
  });
  it('removes only the exact provider inbound origin route after the NAR receipt route is active', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    expect(ready.status).toBe(201);
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };
    const mailboxId = Number(mailbox.mailboxId);

    addProviderOriginRoute(client, 155, mailboxId);
    addProviderOriginRoute(client, 157, 9999);
    addProviderOriginRoute(client, 158, mailboxId, 'Relay to Origin');
    addProviderOriginRoute(client, 159, mailboxId, 'Relay to Origin Route - Custom');

    await enabledProvider().ensureManagedSMTPRoute(mailbox);

    expect(client.routes.find((route) => route.id === 155)).toBeUndefined();
    expect(client.routes.find((route) => route.id === 157)).toBeDefined();
    expect(client.routes.find((route) => route.id === 158)).toBeDefined();
    expect(client.routes.find((route) => route.id === 159)).toBeDefined();
    expect(client.routes.find((route) => route.name === `NAR receipt ${mailboxId}`))
      .toMatchObject({ isActive: true, mailbox: mailboxId });
  });

  it('keeps the provider inbound origin route when the receipt callback is not configured', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    expect(ready.status).toBe(201);
    const mailboxId = Number(ready.body.data.mailboxId);
    addProviderOriginRoute(client, 155, mailboxId);

    const repeated = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');

    expect(repeated.status).toBe(201);
    expect(client.routes.find((route) => route.id === 155)).toBeDefined();
    expect(client.routes.some((route) => route.name === `NAR receipt ${mailboxId}`)).toBe(false);
  });

  it('does not delete inbound origin fallback if actual MailTrigger webhook fields are duplicated', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    expect(ready.status).toBe(201);
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };
    const mailboxId = Number(mailbox.mailboxId);
    addProviderOriginRoute(client, 155, mailboxId);
    client.duplicateWebhookParameterFields = true;

    await expect(enabledProvider().ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_webhook_parameters_invalid',
    });

    expect(client.routes.find((route) => route.id === 155)).toBeDefined();
    expect(client.routes.some((route) => route.name === `NAR receipt ${mailboxId}`)).toBe(false);
    const webhook = client.actions.find((row) => row.name === `NAR receipt webhook ${mailboxId}`)!;
    const rows = client.webhookParameters.get(Number(webhook.id))!;
    expect(rows.filter((row) => row.fieldName === 'method')).toHaveLength(2);
    expect(rows.filter((row) => row.fieldName === 'data')).toHaveLength(2);
    expect(rows.every((row) => row.value === '')).toBe(true);
  });

  it('refuses duplicate exact-name inbound origin routes without removing either one', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };
    const mailboxId = Number(mailbox.mailboxId);
    addProviderOriginRoute(client, 155, mailboxId);
    addProviderOriginRoute(client, 156, mailboxId);

    await expect(enabledProvider().ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_relay_origin_ambiguous',
    });

    expect(client.routes.find((route) => route.id === 155)).toBeDefined();
    expect(client.routes.find((route) => route.id === 156)).toBeDefined();
    expect(client.routes.find((route) => route.name === `NAR receipt ${mailboxId}`))
      .toMatchObject({ isActive: true });
  });

  it('refuses to delete inbound origin route referencing the NAR receipt rule', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    const mailbox = {
      mailboxId: ready.body.data.mailboxId,
      mailboxEmail: ready.body.data.mailboxEmail,
      created: false,
    };
    const mailboxId = Number(mailbox.mailboxId);

    await enabledProvider().ensureManagedSMTPRoute(mailbox);
    const receiptRule = client.rules.find((row) => row.note === `NAR recipient ${mailboxId}`)!;
    addProviderOriginRoute(client, 155, mailboxId, 'Relay to Origin Route', [Number(receiptRule.id)]);

    await expect(enabledProvider().ensureManagedSMTPRoute(mailbox)).rejects.toMatchObject({
      code: 'mailtrigger_relay_origin_conflict',
    });
    expect(client.routes.find((route) => route.id === 155)).toBeDefined();
  });

});
