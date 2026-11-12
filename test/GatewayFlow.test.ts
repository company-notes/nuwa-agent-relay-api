import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailReceipt } from '../src/MailReceipt';
import { WakeService } from '../src/WakeService';
import { RelayTestClient } from './RelayTestClient';

class GatewayScenario {
  readonly client = new RelayTestClient();

  async setup() {
    this.client.installExternalTestTransport();

    // Each scenario starts with its own recipient configuration, including D1 bindings.
    const cleared = await this.client.call('token-b', 'DELETE',
      '/v2/gateway-routes/current?session_id=session-b');
    expect(cleared.status).toBe(200);

    await this.client.provisionAgentMailboxes();
    await this.client.registerVerifiedWake();
  }

  private async callB(method: 'GET' | 'PUT' | 'DELETE', path: string, data?: Record<string, unknown>) {
    return this.client.call('token-b', method, path + '?session_id=session-b', data);
  }

  async route(mode: 'explicit' | 'platform' = 'explicit') {
    return this.callB('PUT', '/v2/gateway-routes/current', {
      recipientBotID: 'cosmo-bot-immutable',
      threadMode: mode,
    });
  }

  async bind(senderSessionID: string, nativeThreadID: string) {
    return this.callB('PUT', '/v2/gateway-conversations/' + senderSessionID, { nativeThreadID });
  }

  async unbind(senderSessionID: string) {
    return this.callB('DELETE', '/v2/gateway-conversations/' + senderSessionID);
  }

  async send(sender: 'a' | 'c', body: string) {
    const sent = await this.client.call(sender === 'a' ? 'token-a' : 'token-c', 'POST',
      '/v2/messages?session_id=session-' + sender, {
        to: 'relay-test-org/beta/reviewer',
        body,
      });
    expect(sent.status, 'Sending a normal message should not depend on a Gateway route').toBe(201);

    const mailbox = await this.client.call('token-b', 'POST',
      '/v2/agents/mailbox?session_id=session-b');
    this.client.archiveDeliveredEmail(
      mailbox.body.data.mailboxId,
      '[NAR:' + sent.body.data.id + '] Agent Relay message',
    );

    return sent.body.data.id as string;
  }

  async deliver() {
    await MailReceipt.reconcileArchives(env);
    await WakeService.dispatchDue(env);
  }

  async retry(messageID: string) {
    await env.DB.prepare(
      'UPDATE wake_events SET next_attempt_at = ? WHERE message_id = ?',
    ).bind(new Date(Date.now() - 1000).toISOString(), messageID).run();
    await WakeService.dispatchDue(env);
  }
}

describe('Nuwa Relay V2 Gateway use cases', () => {
  it('routes separate messages from the same sender into one recipient native conversation', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    expect((await scenario.route()).status).toBe(200);
    expect((await scenario.bind('session-a', 'cosmo-thread-x')).status).toBe(200);

    const first = await scenario.send('a', 'Hello Cosmo, remember the phrase star river.');
    const second = await scenario.send('a', 'Continue our conversation.');
    await scenario.deliver();

    const bodies = scenario.client.wakeCallbacks.map((callback) => callback.body);
    expect(bodies, 'Two independent Relay Thread messages must reuse one native Thread').toHaveLength(2);
    expect(bodies.map((body) => body.recipientPlatformThreadID)).toEqual([
      'cosmo-thread-x', 'cosmo-thread-x',
    ]);
    expect(bodies.map((body) => body.messageID)).toEqual([first, second]);
    expect(bodies[0]).toMatchObject({
      event: 'nuwa.message.available',
      eventVersion: 2,
      recipientAgentID: 'agent-000b',
      recipientSessionID: 'session-b',
      recipientBotID: 'cosmo-bot-immutable',
      senderSessionID: 'session-a',
      senderCanonicalAddress: 'relay-test-org/alpha/author',
      recipientCanonicalAddress: 'relay-test-org/beta/reviewer',
      body: 'Hello Cosmo, remember the phrase star river.',
    });
    expect(bodies[0].relayThreadID).not.toBe(bodies[1].relayThreadID);
  });

  it('isolates each sender and allows the recipient to reset one conversation independently', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    await scenario.route();
    await scenario.bind('session-a', 'thread-for-a');
    await scenario.bind('session-c', 'thread-for-c');

    const a = await scenario.send('a', 'Private context of sender A.');
    const c = await scenario.send('c', 'Unrelated context of sender C.');
    await scenario.deliver();

    const byID = new Map(scenario.client.wakeCallbacks.map((item) => [item.body.messageID, item.body]));
    expect(byID.get(a)?.recipientPlatformThreadID).toBe('thread-for-a');
    expect(byID.get(c)?.recipientPlatformThreadID).toBe('thread-for-c');

    expect((await scenario.unbind('session-a')).body.data.removed).toBe(true);
    await scenario.bind('session-a', 'fresh-thread-for-a');
    const again = await scenario.send('a', 'New chapter after reset.');
    await scenario.deliver();

    expect(scenario.client.wakeCallbacks.find((item) =>
      item.body.messageID === again)?.body.recipientPlatformThreadID).toBe('fresh-thread-for-a');
    const stillB = await scenario.client.call('token-b', 'GET',
      '/v2/gateway-conversations?session_id=session-b');
    expect(stillB.body.data).toEqual([
      { senderSessionID: 'session-a', nativeThreadID: 'fresh-thread-for-a' },
      { senderSessionID: 'session-c', nativeThreadID: 'thread-for-c' },
    ]);
  });

  it('does not forward unbound explicit-thread events, and retries only after binding', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    await scenario.route();

    const sent = await scenario.send('a', 'Must not create a new UI conversation by accident.');
    await scenario.deliver();

    expect(scenario.client.wakeCallbacks, 'Missing native Thread binding must fail closed').toHaveLength(0);
    const before = await scenario.client.call('token-b', 'GET',
      '/v2/wake-events?session_id=session-b');
    expect(before.body.data[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'gateway_conversation_unbound',
    });

    await scenario.bind('session-a', 'ready-native-thread');
    await scenario.retry(sent);
    expect(scenario.client.wakeCallbacks).toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body.recipientPlatformThreadID).toBe('ready-native-thread');
  });

  it('supports platforms with no native Thread ID and denies cross-Session route mutation', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();

    const unauthorized = await scenario.client.call('token-a', 'PUT',
      '/v2/gateway-routes/current?session_id=session-b', {
        recipientBotID: 'attacker-bot',
        threadMode: 'platform',
      });
    expect(unauthorized.status, 'Organization OAuth alone cannot take over Session B').toBe(409);

    const route = await scenario.route('platform');
    expect(route.status).toBe(200);
    const forbiddenThread = await scenario.bind('session-a', 'thread-from-client');
    expect(forbiddenThread.status).toBe(409);

    const sent = await scenario.send('a', 'Hello platform-managed Bot.');
    await scenario.deliver();

    const dispatch = scenario.client.wakeCallbacks.find((item) => item.body.messageID === sent)?.body;
    expect(dispatch.recipientBotID).toBe('cosmo-bot-immutable');
    expect(dispatch).not.toHaveProperty('recipientPlatformThreadID');
  });
});
