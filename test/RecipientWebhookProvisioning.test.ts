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

describe('Recipient MailTrigger Webhook Route', () => {
  it('creates a verified recipient route and configured Webhook Action alongside sender RelaySMTP', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const ready = await client.call('token-a', 'POST',
      '/v1/hosts/provision?work_address_id=work-a');
    expect(ready.status).toBe(201);

    const mailbox = ready.body.data;
    const provider = enabledProvider();

    await provider.ensureManagedSMTPRoute({
      mailboxId: mailbox.mailboxId,
      mailboxEmail: mailbox.mailboxEmail,
      created: false,
    });

    expect(client.rules).toHaveLength(1);
    expect(client.actions).toHaveLength(2);
    expect(client.routes).toHaveLength(2);

    const smtp = client.routes.find((row) => row.name === 'NAR route 1')!;
    const receipt = client.routes.find((row) => row.name === 'NAR receipt 1')!;
    const webhook = client.actions.find((row) => row.name === 'NAR receipt webhook 1')!;

    expect(smtp.actions).toHaveLength(1);
    expect(receipt).toMatchObject({
      isActive: true,
      filterOption: 3,
      ruleConfigs: [],
      actions: [webhook.id],
      mailbox: 1,
      passToNextRouter: true,
    });
    expect(webhook).toMatchObject({ action: 22, user: 31 });

    const params = new Map(client.webhookParameters.get(Number(webhook.id))!
      .map((row) => [row.name, row.value]));
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
      '/v1/hosts/provision?work_address_id=work-a');
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
      '/v1/hosts/provision?work_address_id=work-a');
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
      '/v1/hosts/provision?work_address_id=work-a');
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
});
