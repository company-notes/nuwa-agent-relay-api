import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailReceipt } from '../src/MailReceipt';
import { WakeService } from '../src/WakeService';
import { RelayTestClient } from './RelayTestClient';

describe('Relay resolves familiar colleague names in the one send request', () => {
  it('sends by Chinese display name; Gateway receives already-resolved destination; reply never resolves again', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const send = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: '大熊',
      body: '你好，大熊！密語是星河。',
    });

    expect(send.status).toBe(201);
    expect(client.nameDirectoryLookups, 'One deterministic directory lookup in Relay').toBe(1);
    expect(client.deliveries).toHaveLength(1);

    const saved = await env.DB.prepare(
      'SELECT recipient_agent_id AS agentID, recipient_session_id AS sessionID FROM messages WHERE id = ?',
    ).bind(send.body.data.id).first<{ agentID: string; sessionID: string }>();

    expect(saved).toEqual({ agentID: 'agent-000b', sessionID: 'session-b' });

    const reply = await client.call('token-b', 'POST',
      '/v2/threads/' + send.body.data.threadId + '/messages?session_id=session-b', {
        body: '收到星河。',
      });

    expect(reply.status).toBe(201);
    expect(client.nameDirectoryLookups,
      'An existing Thread reply must not repeat name resolution').toBe(1);
    expect(client.deliveries).toHaveLength(2);

    const history = await client.call('token-a', 'GET',
      '/v2/threads/' + send.body.data.threadId + '?session_id=session-a');

    expect(history.status).toBe(200);
    expect(history.body.data.map((m: { body: string }) => m.body))
      .toEqual(['你好，大熊！密語是星河。', '收到星河。']);
  });

  it('sends the already-selected Bot ID in signed Wake without asking Gateway to resolve names', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const removed = await client.call('token-b', 'DELETE',
      '/v2/gateway-route?session_id=session-b');
    expect(removed.status).toBe(200);

    await client.provisionAgentMailboxes();
    await client.registerVerifiedWake();

    const route = await client.call('token-b', 'PUT',
      '/v2/gateway-route?session_id=session-b', {
        recipientBotID: 'immutable-bear-bot',
        threadMode: 'platform',
      });
    expect(route.status).toBe(200);

    const send = await client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: '大熊', body: '這是直接指定助理名稱的來電。',
      });
    expect(send.status).toBe(201);

    await MailReceipt.confirmArrival(env, send.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    expect(client.wakeCallbacks).toHaveLength(1);
    expect(client.wakeCallbacks[0].signature, 'Wake is still signed').not.toBeNull();
    expect(client.wakeCallbacks[0].body).toMatchObject({
      event: 'nuwa.message.available',
      eventVersion: 2,
      recipientSessionID: 'session-b',
      recipientBotID: 'immutable-bear-bot',
      senderSessionID: 'session-a',
      relayThreadID: send.body.data.threadId,
    });
    expect(client.nameDirectoryLookups,
      'The Gateway receives a preselected Bot, with no extra name lookup').toBe(1);
  });

  it('rejects duplicate, unknown or not-yet-ready names before any message is stored or sent', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    for (const [name, status, code] of [
      ['雙胞胎', 409, 'recipient_name_ambiguous'],
      ['未註冊助理', 404, 'recipient_name_not_found'],
      ['未啟用', 409, 'recipient_name_not_ready'],
    ] as const) {
      const result = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
        to: name, body: 'Must never guess where to send this.',
      });
      expect(result.status, name).toBe(status);
      expect(result.body.error.code, name).toBe(code);
    }

    expect(client.deliveries).toHaveLength(0);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE body = ?",
    ).bind('Must never guess where to send this.').first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });

  it('fails closed on contradictory directory records before delivering', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();
    client.corruptNameDirectory = true;

    const sent = await client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: '大熊', body: 'Do not deliver with untrusted identity data.',
      });

    expect(sent.status).toBe(502);
    expect(sent.body.error.code).toBe('address_response_invalid');
    expect(client.deliveries).toHaveLength(0);
  });

  it('preserves fast canonical-address sends without a directory lookup', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const sent = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Direct canonical addressing still works.',
    });

    expect(sent.status).toBe(201);
    expect(client.nameDirectoryLookups).toBe(0);
  });
});
