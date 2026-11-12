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
      '/v2/gateway-route?session_id=session-b');
    expect(cleared.status).toBe(200);

    await this.client.provisionAgentMailboxes();
    await this.client.registerVerifiedWake();
  }

  private async callB(method: 'GET' | 'PUT' | 'DELETE', path: string, data?: Record<string, unknown>) {
    return this.client.call('token-b', method, path + '?session_id=session-b', data);
  }

  async route(
    mode: 'explicit' | 'platform' = 'explicit',
    firstContactMode: 'manual' | 'automatic' = 'manual',
  ) {
    return this.callB('PUT', '/v2/gateway-route', {
      recipientBotID: 'cosmo-bot-immutable',
      threadMode: mode,
      firstContactMode,
    });
  }

  async complete(senderSessionID: string, messageID: string, nativeThreadID: string) {
    return this.callB('PUT', '/v2/gateway-first-contacts/' + senderSessionID, {
      messageID, nativeThreadID,
    });
  }

  async pendingFirstContacts() {
    return this.callB('GET', '/v2/gateway-first-contacts');
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
      '/v2/agent-mailboxes?session_id=session-b');
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
      '/v2/gateway-route?session_id=session-b', {
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

  it('automatically creates the first native conversation only once, then continues it', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    expect((await scenario.route('explicit', 'automatic')).status).toBe(200);

    const first = await scenario.send('a', 'First contact: remember the phrase 星河.');
    const second = await scenario.send('a', 'Second contact: continue our first conversation.');
    await scenario.deliver();

    expect(scenario.client.wakeCallbacks, 'Only one initial native conversation may be opened').toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body).toMatchObject({
      messageID: first,
      recipientPlatformThreadID: null,
      senderSessionID: 'session-a',
      recipientBotID: 'cosmo-bot-immutable',
    });
    expect(scenario.client.wakeCallbacks[0].body).not.toHaveProperty('gatewayAction');

    // The deployed Studio WakeReceiver permits these V2 fields only.
    const allowedWakeFields = new Set([
      'event', 'eventVersion', 'messageID', 'recipientSessionID',
      'relayThreadID', 'senderSessionID', 'senderCanonicalAddress',
      'recipientAgentID', 'recipientCanonicalAddress', 'recipientBotID',
      'body', 'recipientPlatformThreadID',
    ]);
    expect(Object.keys(scenario.client.wakeCallbacks[0].body)
      .every((field) => allowedWakeFields.has(field))).toBe(true);

    expect((await scenario.pendingFirstContacts()).body.data).toEqual([
      expect.objectContaining({ senderSessionID: 'session-a', messageID: first }),
    ]);

    const waiting = await scenario.client.call('token-b', 'GET',
      '/v2/wake-events?session_id=session-b');
    expect(waiting.body.data.find((item: { messageId: string }) => item.messageId === second))
      .toMatchObject({
        status: 'pending',
        attempts: 0,
        lastError: 'gateway_first_contact_pending',
      });

    const incorrect = await scenario.complete('session-a', second, 'unexpected-thread');
    expect(incorrect.status).toBe(409);

    const confirmed = await scenario.complete('session-a', first, 'cosmo-native-thread-1');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      nativeThreadID: 'cosmo-native-thread-1', alreadyConfirmed: false,
    });

    const again = await scenario.complete('session-a', first, 'cosmo-native-thread-1');
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyConfirmed).toBe(true);

    await scenario.deliver();

    const secondDispatch = scenario.client.wakeCallbacks.find((entry) => entry.body.messageID === second);
    expect(secondDispatch?.body.recipientPlatformThreadID).toBe('cosmo-native-thread-1');
    expect(secondDispatch?.body).not.toHaveProperty('gatewayAction');
    expect(scenario.client.wakeCallbacks).toHaveLength(2);
    expect((await scenario.pendingFirstContacts()).body.data).toEqual([]);
  });

  it('separates two simultaneous first-contact senders and protects the first native thread', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    await scenario.route('explicit', 'automatic');

    const a = await scenario.send('a', '小晴向 Cosmo 打招呼');
    const c = await scenario.send('c', '徐哥向 Cosmo 打招呼');
    await scenario.deliver();

    expect(scenario.client.wakeCallbacks).toHaveLength(2);
    expect(scenario.client.wakeCallbacks.map((entry) => entry.body.recipientPlatformThreadID))
      .toEqual([null, null]);
    expect((await scenario.pendingFirstContacts()).body.data).toHaveLength(2);

    expect((await scenario.complete('session-a', a, 'thread-xiaoqing')).status).toBe(200);
    expect((await scenario.complete('session-c', c, 'thread-xuge')).status).toBe(200);
    expect((await scenario.complete('session-a', a, 'thread-xuge')).status).toBe(409);

    await scenario.send('a', '小晴繼續說話');
    await scenario.send('c', '徐哥繼續說話');
    await scenario.deliver();
    const continuing = scenario.client.wakeCallbacks.slice(2).map((entry) =>
      ({ sender: entry.body.senderSessionID, thread: entry.body.recipientPlatformThreadID }));
    expect(continuing).toEqual([
      { sender: 'session-a', thread: 'thread-xiaoqing' },
      { sender: 'session-c', thread: 'thread-xuge' },
    ]);
  });

  it('requires recipient Runtime authorization to confirm or reset a pending first contact', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    await scenario.route('explicit', 'automatic');

    const first = await scenario.send('a', 'First contact should never grant sender control.');
    await scenario.deliver();

    const stolenSession = await scenario.client.call('token-a', 'PUT',
      '/v2/gateway-first-contacts/session-a?session_id=session-b', {
        messageID: first, nativeThreadID: 'attacker-thread',
      });
    expect(stolenSession.status).toBe(409);

    const blindBinding = await scenario.bind('session-a', 'blind-untrusted-thread');
    expect(blindBinding.status).toBe(409);
    expect((await scenario.route('explicit', 'manual')).status).toBe(409);

    const confirmed = await scenario.complete('session-a', first, 'native-thread-verified');
    expect(confirmed.status).toBe(200);
    expect((await scenario.complete('session-a', first, 'another-thread')).status).toBe(409);

    const changed = await scenario.bind('session-a', 'recipient-manually-rebound-thread');
    expect(changed.status).toBe(200);
    expect((await scenario.complete('session-a', first, 'native-thread-verified')).status).toBe(409);

    expect((await scenario.unbind('session-a')).status).toBe(200);
    const next = await scenario.send('a', 'After reset, a new conversation must be created.');
    await scenario.deliver();

    const newEvent = scenario.client.wakeCallbacks.find((entry) => entry.body.messageID === next);
    expect(newEvent?.body.recipientPlatformThreadID).toBeNull();
  });

  it('never retries a reserved first-contact event into another new native thread', async () => {
    const scenario = new GatewayScenario();
    await scenario.setup();
    await scenario.route('explicit', 'automatic');

    const first = await scenario.send('a', 'Create exactly one platform conversation.');
    await scenario.deliver();
    expect(scenario.client.wakeCallbacks).toHaveLength(1);

    // Simulate an ambiguous provider acknowledgment after the native work was sent.
    await env.DB.prepare(
      `UPDATE wake_events SET status = 'pending', next_attempt_at = ?
        WHERE message_id = ?`,
    ).bind(new Date(Date.now() - 1000).toISOString(), first).run();

    await scenario.deliver();

    expect(scenario.client.wakeCallbacks, 'Retry must not create another native conversation')
      .toHaveLength(1);
    const before = await scenario.client.call('token-b', 'GET',
      '/v2/wake-events?session_id=session-b');
    expect(before.body.data.find((item: { messageId: string }) => item.messageId === first))
      .toMatchObject({ status: 'pending', lastError: 'gateway_first_contact_pending' });

    await scenario.complete('session-a', first, 'resolved-native-thread');
    await scenario.deliver();

    expect(scenario.client.wakeCallbacks,
      'Confirmation must not replay the already-forwarded bootstrap message').toHaveLength(1);
  });

});
