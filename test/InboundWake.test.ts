import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { WakeService } from '../src/WakeService';
import { MailReceipt } from '../src/MailReceipt';
import { RelayTestClient } from './RelayTestClient';

describe('Real D1 MailTrigger receipt and Agent wake integrations', () => {
  it('rejects spoofed receipts, tracks one authenticated mailbox arrival, and protects receipts by Session', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const readyA = await client.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    const readyB = await client.call('token-b', 'POST', '/v2/agents/mailbox?session_id=session-b');

    expect(readyA.status).toBe(201);
    expect(readyB.status).toBe(201);

    const mail = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Receipt tracking must only trust MailTrigger.',
    });
    expect(mail.status).toBe(201);

    const owned = await client.call('token-b', 'GET',
      '/v2/messages/' + mail.body.data.id + '?session_id=session-b');
    expect(owned.status).toBe(200);
    expect(owned.body.data.body).toBe('Receipt tracking must only trust MailTrigger.');

    const noMessage = await client.call('token-c', 'GET',
      '/v2/messages/' + mail.body.data.id + '?session_id=session-c');
    expect(noMessage.status).toBe(404);

    const receiptPath = '/v2/messages/' + mail.body.data.id + '/receipt?session_id=session-a';
    const initial = await client.call('token-a', 'GET', receiptPath);
    expect(initial.body.data).toMatchObject({
      submissionStatus: 'sent',
      arrivedInMailTrigger: false,
      receivedAt: null,
    });

    const payload = {
      from: readyA.body.data.mailboxEmail,
      receiver: readyB.body.data.mailboxEmail,
      subject: '[NAR:' + mail.body.data.id + '] Relay message',
    };

    const unauthenticated = await client.call(
      null, 'POST', '/v1/mailtrigger/receipt', payload,
    );
    expect(unauthenticated.status).toBe(401);

    const wrongSender = await client.callWithHeaders('POST', '/v1/mailtrigger/receipt', {
      ...payload,
      from: 'attacker@example.test',
    }, { 'x-relay-inbound-key': 'test-inbound-key' });
    expect(wrongSender.status).toBe(200);
    expect(wrongSender.body.data.matched).toBe(false);

    const noLeak = await client.call('token-c', 'GET',
      '/v2/messages/' + mail.body.data.id + '/receipt?session_id=session-c');
    expect(noLeak.status).toBe(404);

    const valid = await client.callWithHeaders('POST', '/v1/mailtrigger/receipt', payload, {
      'x-relay-inbound-key': 'test-inbound-key',
    });
    expect(valid.status).toBe(200);
    expect(valid.body.data).toMatchObject({
      matched: true,
      duplicate: false,
      messageId: mail.body.data.id,
    });

    const duplicate = await client.callWithHeaders('POST', '/v1/mailtrigger/receipt', payload, {
      'x-relay-inbound-key': 'test-inbound-key',
    });
    expect(duplicate.body.data.duplicate).toBe(true);

    const confirmed = await client.call('token-b', 'GET',
      '/v2/messages/' + mail.body.data.id + '/receipt?session_id=session-b');
    expect(confirmed.body.data.arrivedInMailTrigger).toBe(true);
    expect(confirmed.body.data.receivedAt).toBeTruthy();
    expect(confirmed.body.data.receiptSource).toBe('webhook');
    expect(confirmed.body.data.readBy).toHaveLength(0);

    const unauthorizedRead = await client.call('token-a', 'POST',
      '/v2/messages/' + mail.body.data.id + '/read?session_id=session-a');
    expect(unauthorizedRead.status).toBe(404);

    const outsiderRead = await client.call('token-c', 'POST',
      '/v2/messages/' + mail.body.data.id + '/read?session_id=session-c');
    expect(outsiderRead.status).toBe(404);

    const read = await client.call('token-b', 'POST',
      '/v2/messages/' + mail.body.data.id + '/read?session_id=session-b');
    expect(read.status).toBe(201);
    expect(read.body.data.sessionID).toBe('session-b');

    const againRead = await client.call('token-b', 'POST',
      '/v2/messages/' + mail.body.data.id + '/read?session_id=session-b');
    expect(againRead.body.data.readAt).toBe(read.body.data.readAt);

    const senderSeesReceipt = await client.call('token-a', 'GET', receiptPath);
    expect(senderSeesReceipt.body.data.readBy).toEqual([{
      sessionID: 'session-b',
      readAt: read.body.data.readAt,
    }]);
  });

  it('does not confuse an unrelated archive entry or outbound 201 with mailbox receipt', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const mail = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Must not become received unless its actual recipient mailbox archives the marker.',
    });
    expect(mail.status).toBe(201);

    const second = await client.call('token-b', 'POST', '/v2/agents/mailbox?session_id=session-b');
    client.archiveDeliveredEmail(
      second.body.data.mailboxId, '[NAR:00000000-0000-0000-0000-000000000000] Unrelated',
    );
    // No wake subscription here, so there is no background Archive polling.
    // The signed-in sender can explicitly check the recipient's provider Archive.
    const receipt = await client.call('token-a', 'GET',
      '/v2/messages/' + mail.body.data.id + '/receipt?session_id=session-a&refresh=archive');

    expect(receipt.body.data.arrivedInMailTrigger).toBe(false);
    expect(receipt.body.data.receiptSource).toBeNull();

    client.archiveDeliveredEmail(
      second.body.data.mailboxId, '[NAR:' + mail.body.data.id + '] Agent Relay message',
    );
    await env.DB.prepare(
      'UPDATE messages SET archive_checked_at = NULL WHERE id = ?',
    ).bind(mail.body.data.id).run();
    const nowReceived = await client.call('token-a', 'GET',
      '/v2/messages/' + mail.body.data.id + '/receipt?session_id=session-a&refresh=archive');
    expect(nowReceived.body.data.receiptSource).toBe('archive');
  });

  it('delivers an HMAC-signed wake to the registered work and reports durable success', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const blocked = await client.call('token-b', 'POST',
      '/v2/wake-subscription?session_id=session-b', {
        callbackUrl: 'https://localhost/internal',
      });
    expect(blocked.status).toBe(400);

    const subscribed = await client.registerVerifiedWake();
    expect(subscribed.status).toBe(201);
    const secret = subscribed.body.data.signingSecret as string;
    expect(secret.length).toBeGreaterThan(48);

    const sent = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Wake me without leaking the message body.',
    });
    expect(sent.status).toBe(201);

    // The MailTrigger send endpoint returned 201, but the recipient mailbox
    // archive has not yet observed the message: no Wake may be queued.
    const before = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(before.body.data).toHaveLength(0);
    await WakeService.dispatchDue(env);
    expect(client.wakeCallbacks).toHaveLength(0);

    const b = await client.call('token-b', 'POST', '/v2/agents/mailbox?session_id=session-b');
    client.archiveDeliveredEmail(
      b.body.data.mailboxId,
      '[NAR:' + sent.body.data.id + '] Agent Relay message',
    );
    await MailReceipt.reconcileArchives(env);

    const receipt = await client.call('token-b', 'GET',
      '/v2/messages/' + sent.body.data.id + '/receipt?session_id=session-b');
    expect(receipt.body.data).toMatchObject({
      arrivedInMailTrigger: true,
      receiptSource: 'archive',
    });
    const ready = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(ready.body.data[0].status).toBe('pending');

    await WakeService.dispatchDue(env);

    expect(client.wakeCallbacks).toHaveLength(1);
    const callback = client.wakeCallbacks[0];
    expect(callback.body).toEqual({
      event: 'nuwa.message.available',
      messageId: sent.body.data.id,
      sessionID: 'session-b',
    });
    expect(JSON.stringify(callback.body)).not.toContain('Wake me');

    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = await crypto.subtle.sign('HMAC', key,
      new TextEncoder().encode(JSON.stringify(callback.body)));
    const hex = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(callback.signature).toBe('sha256=' + hex);

    const after = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(after.body.data[0].status).toBe('delivered');

    await WakeService.dispatchDue(env);
    expect(client.wakeCallbacks).toHaveLength(1);

    const removed = await client.call('token-b', 'DELETE',
      '/v2/wake-subscription?session_id=session-b');
    expect(removed.status).toBe(200);
  });

  it('serializes simultaneous Cron and webhook wake dispatch using D1 leases', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    await client.registerVerifiedWake();

    const mail = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'One provider receipt, one concurrent dispatch.',
    });
    const recipient = await client.call('token-b', 'POST',
      '/v2/agents/mailbox?session_id=session-b');
    client.archiveDeliveredEmail(
      recipient.body.data.mailboxId, '[NAR:' + mail.body.data.id + '] Hello',
    );
    await MailReceipt.reconcileArchives(env);

    await Promise.all([WakeService.dispatchDue(env), WakeService.dispatchDue(env)]);
    const state = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(state.body.data[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(client.wakeCallbacks).toHaveLength(1);
  });

  it('retries rejected callback notifications and does not disclose other Session deliveries', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const subscribed = await client.registerVerifiedWake();
    expect(subscribed.status).toBe(201);

    client.failNextWake = true;

    const sent = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Retry the webhook without re-sending an email.',
    });
    expect(sent.status).toBe(201);

    // The retry path is tested after Archive evidence rather than after a
    // Webhook, so no independent waitUntil races this controlled retry test.
    const recipient = await client.call('token-b', 'POST',
      '/v2/agents/mailbox?session_id=session-b');
    client.archiveDeliveredEmail(
      recipient.body.data.mailboxId,
      '[NAR:' + sent.body.data.id + '] Agent Relay message',
    );
    await MailReceipt.reconcileArchives(env);

    await WakeService.dispatchDue(env);
    const history = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(history.body.data[0]).toMatchObject({ status: 'pending', attempts: 1 });

    const hidden = await client.call('token-a', 'GET', '/v2/wake-events?session_id=session-a');
    expect(hidden.body.data).toHaveLength(0);

    const body = await env.DB.prepare(
      "SELECT next_attempt_at AS due FROM wake_events WHERE message_id = ?",
    ).bind(sent.body.data.id).first<{ due: string }>();
    expect(new Date(body!.due).getTime()).toBeGreaterThan(Date.now());

    await env.DB.prepare(
      'UPDATE wake_events SET next_attempt_at = ? WHERE message_id = ?',
    ).bind(new Date(Date.now() - 1000).toISOString(), sent.body.data.id).run();
    await WakeService.dispatchDue(env);

    const completed = await client.call('token-b', 'GET', '/v2/wake-events?session_id=session-b');
    expect(completed.body.data[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });
  it('accepts a genuine B-side receipt before the /mail/send response, even if send HTTP fails', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const subscribed = await client.registerVerifiedWake();
    expect(subscribed.status).toBe(201);

    // MailTrigger B delivers and calls Nuwa before A's send HTTP response.
    client.autoReceiptDuringMailSend = true;
    client.failNextMail = true;

    const sent = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Early delivery notice must not be lost or cause a false send failure.',
    });

    expect(sent.status).toBe(201);
    const receipt = await client.call('token-b', 'GET',
      '/v2/messages/' + sent.body.data.id + '/receipt?session_id=session-b');
    expect(receipt.body.data).toMatchObject({
      submissionStatus: 'sent',
      arrivedInMailTrigger: true,
      receiptSource: 'webhook',
    });

    const wakes = await client.call('token-b', 'GET',
      '/v2/wake-events?session_id=session-b');
    expect(wakes.body.data.filter((row: { messageId: string }) =>
      row.messageId === sent.body.data.id)).toHaveLength(1);
    await WakeService.dispatchDue(env);
    const deliveredForMessage = client.wakeCallbacks.filter((item) =>
      item.body.messageId === sent.body.data.id);
    expect(deliveredForMessage).toHaveLength(1);
  });


});
