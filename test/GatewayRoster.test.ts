import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailReceipt } from '../src/MailReceipt';
import { WakeService } from '../src/WakeService';
import { RelayTestClient } from './RelayTestClient';

class GatewayRosterScenario {
  readonly client = new RelayTestClient();

  async setup() {
    this.client.installExternalTestTransport();

    // Wrangler's D1 test environment survives across scenarios in this file.
    // Revoke previous teammate memberships before creating this independent office.
    for (const [token, sessionID] of [
      ['token-b', 'session-b'], ['token-d', 'session-d'],
    ] as const) {
      const removed = await this.client.call(token, 'DELETE',
        '/v2/gateway-invitation?session_id=' + sessionID);
      expect([200, 404]).toContain(removed.status);
    }

    const oldWake = await this.client.call('token-g', 'DELETE',
      '/v2/wake-subscription?session_id=session-g');
    expect(oldWake.status).toBe(200);

    await this.client.provisionAgentMailboxes();
    const another = await this.client.call('token-d', 'POST',
      '/v2/agent-mailboxes?session_id=session-d');
    expect(another.status).toBe(201);

    const wake = await this.client.call('token-g', 'POST',
      '/v2/wake-subscription?session_id=session-g', {
        callbackUrl: 'https://agent-hook.example.com/gateway',
      });
    expect(wake.status).toBe(201);
    await this.client.confirmLatestWake('token-g');
    expect(this.client.wakeChallenges).toHaveLength(1);
  }

  private gateway(method: string, path: string, body?: object) {
    return this.client.call('token-g', method, path + '?session_id=session-g', body);
  }

  invite(address: string, botID: string, threadMode: string = 'platform',
         firstContactMode: string = 'manual') {
    return this.gateway('POST', '/v2/gateway-teammates', {
      recipientAddress: address, recipientBotID: botID,
      threadMode, firstContactMode,
    });
  }

  approve(token: 'token-b' | 'token-d', sessionID: string) {
    return this.client.call(token, 'PUT',
      '/v2/gateway-invitation?session_id=' + sessionID);
  }

  async send(token: 'token-a' | 'token-c', sessionID: string, to: string, body: string) {
    const sent = await this.client.call(token, 'POST',
      '/v2/messages?session_id=' + sessionID, { to, body });
    expect(sent.status, 'A coworker must be able to call the other independently').toBe(201);

    await MailReceipt.confirmArrival(env, sent.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);
    return sent.body.data.id as string;
  }
}

describe('Office Gateway registration and shared Wake use cases', () => {
  it('uses one verified office receiver for multiple independent coworkers', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const bear = 'relay-test-org/beta/reviewer';
    const analyst = 'relay-test-org/gamma/main';
    expect((await scenario.invite(bear, 'local-bear-bot')).status).toBe(201);
    expect((await scenario.invite(analyst, 'local-analyst-bot')).status).toBe(201);

    // A Gateway knows its coworkers but cannot act for them until each approves.
    const pending = await scenario.client.call('token-b', 'GET',
      '/v2/gateway-invitation?session_id=session-b');
    expect(pending.body.data).toMatchObject({
      gatewaySessionID: 'session-g', recipientBotID: 'local-bear-bot',
      status: 'pending',
    });

    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);
    expect((await scenario.approve('token-d', 'session-d')).status).toBe(200);

    const first = await scenario.send('token-a', 'session-a', bear, 'Hello coworker B.');
    const second = await scenario.send('token-a', 'session-a', analyst, 'Hello coworker D.');

    expect(scenario.client.wakeChallenges, 'Only the office Gateway receives verification')
      .toHaveLength(1);
    expect(scenario.client.wakeCallbacks).toHaveLength(2);

    const messages = scenario.client.wakeCallbacks.map((item) => item.body);
    expect(messages.map((body) => ({
      id: body.messageID,
      session: body.recipientSessionID,
      bot: body.recipientBotID,
    }))).toEqual([
      { id: first, session: 'session-b', bot: 'local-bear-bot' },
      { id: second, session: 'session-d', bot: 'local-analyst-bot' },
    ]);
    expect(messages[0]).toMatchObject({
      event: 'nuwa.message.available', eventVersion: 2,
      senderSessionID: 'session-a',
      senderCanonicalAddress: 'relay-test-org/alpha/author',
      recipientCanonicalAddress: bear,
      body: 'Hello coworker B.',
    });
    expect(messages[1]).not.toHaveProperty('recipientPlatformThreadID');

    const roster = await scenario.client.call('token-g', 'GET',
      '/v2/gateway-teammates?session_id=session-g');
    expect(roster.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientSessionID: 'session-b', status: 'active' }),
      expect.objectContaining({ recipientSessionID: 'session-d', status: 'active' }),
    ]));
  });

  it('rejects unapproved teammates and cross-Session takeover attempts', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const bear = 'relay-test-org/beta/reviewer';
    expect((await scenario.invite(bear, 'local-bear-bot')).status).toBe(201);

    const before = await scenario.send('token-a', 'session-a', bear, 'No consent yet.');
    expect(before).toBeTruthy();
    expect(scenario.client.wakeCallbacks).toHaveLength(0);

    const attacker = await scenario.client.call('token-a', 'PUT',
      '/v2/gateway-invitation?session_id=session-b');
    expect(attacker.status).toBe(409);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);

    const duplicate = await scenario.invite(bear, 'another-bot');
    expect(duplicate.status).toBe(409);

    const revocation = await scenario.client.call('token-b', 'DELETE',
      '/v2/gateway-invitation?session_id=session-b');
    expect(revocation.status).toBe(200);

    await scenario.send('token-a', 'session-a', bear, 'After revocation.');
    expect(scenario.client.wakeCallbacks).toHaveLength(0);
  });
});
