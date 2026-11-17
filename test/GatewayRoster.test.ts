import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMailboxService } from '../src/AgentMailboxService';
import { GatewayFirstContacts } from '../src/GatewayFirstContacts';
import { MailReceipt } from '../src/MailReceipt';
import { WakeService } from '../src/WakeService';
import { RelayTestClient } from './RelayTestClient';

class GatewayRosterScenario {
  readonly client = new RelayTestClient();

  private async clearPreviousOfficeRegistration(): Promise<void> {
    // Test-only D1 data survives between scenarios. Discard the previous
    // synthetic office's provider-backed mailboxes before resetting its routes
    // and Gateway Wake, preserving unrelated Agents' mailbox registrations.
    const organizationID = 'org-id';
    const gatewaySessionID = 'session-g';
    const officeSessions = `SELECT recipient_session_id FROM gateway_office_coworkers
      WHERE org_id = ? AND gateway_session_id = ? AND recipient_session_id IS NOT NULL`;

    await env.DB.batch([
      env.DB.prepare('DELETE FROM wake_events WHERE session_id = ?')
        .bind(gatewaySessionID),

      env.DB.prepare(
        `DELETE FROM agent_aliases WHERE org_id = ? AND agent_id IN (
          SELECT recipient_agent_id FROM gateway_office_coworkers
            WHERE org_id = ? AND gateway_session_id = ?
              AND recipient_agent_id IS NOT NULL
        )`,
      ).bind(organizationID, organizationID, gatewaySessionID),
      env.DB.prepare(
        `DELETE FROM agent_mailboxes
          WHERE org_id = ? AND agent_id IN (
            SELECT recipient_agent_id FROM gateway_office_coworkers
              WHERE org_id = ? AND gateway_session_id = ?
                AND recipient_agent_id IS NOT NULL
          )`,
      ).bind(organizationID, organizationID, gatewaySessionID),
      env.DB.prepare(
        `DELETE FROM gateway_teammates
          WHERE org_id = ? AND gateway_session_id = ?
            AND recipient_session_id IN (${officeSessions})`,
      ).bind(organizationID, gatewaySessionID, organizationID, gatewaySessionID),
      env.DB.prepare(
        `DELETE FROM gateway_routes
          WHERE org_id = ? AND recipient_session_id IN (${officeSessions})`,
      ).bind(organizationID, organizationID, gatewaySessionID),
      env.DB.prepare(
        'DELETE FROM gateway_office_coworkers WHERE org_id = ? AND gateway_session_id = ?',
      ).bind(organizationID, gatewaySessionID),
    ]);
  }

  async setup() {
    this.client.installExternalTestTransport();
    await this.clearPreviousOfficeRegistration();

    // Wrangler's D1 test environment survives across scenarios in this file.
    // Revoke previous teammate memberships before creating this independent office.
    for (const [token, sessionID] of [
      ['token-a', 'session-a'], ['token-b', 'session-b'], ['token-d', 'session-d'],
    ] as const) {
      const removed = await this.client.call(token, 'DELETE',
        '/v2/gateway-invitation?session_id=' + sessionID);
      expect([200, 404]).toContain(removed.status);

      const route = await this.client.call(token, 'DELETE',
        '/v2/gateway-route?session_id=' + sessionID);
      expect(route.status).toBe(200);
    }

    for (const [token, sessionID] of [
      ['token-g', 'session-g'], ['token-h', 'session-h'],
    ] as const) {
      const oldWake = await this.client.call(token, 'DELETE',
        '/v2/wake-subscription?session_id=' + sessionID);
      expect(oldWake.status).toBe(200);
    }

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

  async send(token: 'token-a' | 'token-c' | 'token-d', sessionID: string, to: string, body: string) {
    const sent = await this.client.call(token, 'POST',
      '/v2/messages?session_id=' + sessionID, { to, body });
    expect(sent.status, 'A coworker must be able to call the other independently').toBe(201);

    await MailReceipt.confirmArrival(env, sent.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);
    return sent.body.data.id as string;
  }
}

// Restore dispatch instrumentation after each case, including failed assertions.
afterEach(() => vi.restoreAllMocks());

describe('Office Gateway registration and shared Wake use cases', () => {
  it('invites a known local Bot by its real display name without an extra Gateway directory call', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const invitation = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-teammates?session_id=session-g', {
        recipientName: '大熊',
        recipientBotID: 'native-bear-001',
        threadMode: 'platform',
      });

    expect(invitation.status).toBe(201);
    expect(invitation.body.data).toMatchObject({
      status: 'pending', recipientSessionID: 'session-b',
      recipientCanonicalAddress: 'relay-test-org/beta/reviewer',
      recipientBotID: 'native-bear-001',
    });
    expect(scenario.client.nameDirectoryLookups).toBe(1);

    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);

    const messageID = await scenario.send('token-a', 'session-a', '大熊',
      '你好！密語是星河。');
    expect(scenario.client.wakeCallbacks).toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body).toMatchObject({
      messageID,
      recipientSessionID: 'session-b',
      recipientBotID: 'native-bear-001',
      body: '你好！密語是星河。',
    });
    expect(scenario.client.nameDirectoryLookups,
      'One directory read for registration and one for message send; none in Gateway Wake.').toBe(2);

    const ambiguous = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-teammates?session_id=session-g', {
        recipientName: '雙胞胎',
        recipientBotID: 'never-route',
        threadMode: 'platform',
      });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('recipient_name_ambiguous');

    const invalid = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-teammates?session_id=session-g', {
        recipientName: '大熊',
        recipientAddress: 'relay-test-org/gamma/main',
        recipientBotID: 'never-route',
        threadMode: 'platform',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('gateway_recipient_required');
  });

  it('lets only an approved office Gateway confirm a real first-contact receipt for its coworker', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    expect((await scenario.invite('relay-test-org/beta/reviewer',
      'openmaus-bear-id', 'explicit', 'automatic')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);

    const first = await scenario.send('token-a', 'session-a',
      'relay-test-org/beta/reviewer', '第一次找大熊，建立原生對話。');
    const second = await scenario.send('token-a', 'session-a',
      'relay-test-org/beta/reviewer', '第二則應等待同一個原生 Thread。');
    expect(scenario.client.wakeCallbacks).toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body).toMatchObject({
      messageID: first,
      recipientSessionID: 'session-b',
      recipientBotID: 'openmaus-bear-id',
      recipientPlatformThreadID: null,
    });

    const waiting = await env.DB.prepare(
      'SELECT session_id AS sessionID, status FROM wake_events WHERE message_id = ?',
    ).bind(second).first<{ sessionID: string; status: string }>();
    expect(waiting, 'A shared Gateway owns the notification, not the recipient Session')
      .toMatchObject({ sessionID: 'session-g', status: 'pending' });

    const queuedMessage = await env.DB.prepare(
      `SELECT m.sender_session_id AS senderSessionID,
              m.recipient_session_id AS recipientSessionID,
              m.received_at AS receivedAt, t.org_id AS organizationID
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ?`,
    ).bind(second).first<{
      senderSessionID: string; recipientSessionID: string;
      organizationID: string; receivedAt: string | null;
    }>();
    expect(queuedMessage, 'Release must use the recorded Message pair, not the Wake callback Session')
      .toMatchObject({
        senderSessionID: 'session-a',
        recipientSessionID: 'session-b',
        organizationID: 'org-id',
      });
    expect(queuedMessage?.receivedAt,
      'Only a confirmed MailTrigger arrival can create the waiting Wake').not.toBeNull();

    const candidates = await env.DB.prepare(
      `SELECT m.id AS messageID FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND m.sender_session_id = ?
          AND m.recipient_session_id = ? AND m.received_at IS NOT NULL
          AND m.id <> ?`,
    ).bind('org-id', 'session-a', 'session-b', first)
      .all<{ messageID: string }>();
    expect(candidates.results.map((item) => item.messageID),
      'The verified-message selector must include the waiting shared-Gateway Wake')
      .toContain(second);

    const path = '/v2/gateway-teammates/session-b/first-contacts/session-a';
    const receipt = { messageID: first, nativeThreadID: 'cosmo-real-thread-1' };

    const outsider = await scenario.client.call('token-h', 'PUT',
      path + '?session_id=session-h', receipt);
    expect(outsider.status).toBe(403);
    const sender = await scenario.client.call('token-a', 'PUT',
      path + '?session_id=session-a', receipt);
    expect(sender.status).toBe(403);

    const mismatched = await scenario.client.call('token-g', 'PUT',
      path + '?session_id=session-g',
      { messageID: second, nativeThreadID: 'cosmo-real-thread-1' });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error.code).toBe('gateway_first_contact_mismatch');

    const confirmWithDispatchTrace = async () => {
      const dispatchSpy = vi.spyOn(WakeService, 'dispatchDue');

      try {
        const response = await scenario.client.call('token-g', 'PUT',
          path + '?session_id=session-g', receipt);

        return { response, dispatchCalls: dispatchSpy.mock.calls.length };
      } finally {
        dispatchSpy.mockRestore();
      }
    };
    const { response: confirmed, dispatchCalls } = await confirmWithDispatchTrace();
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      senderSessionID: 'session-a', recipientSessionID: 'session-b',
      nativeThreadID: 'cosmo-real-thread-1', alreadyConfirmed: false,
    });

    const wakeAfterConfirmation = await env.DB.prepare(
      `SELECT status, attempts, next_attempt_at AS nextAttempt,
              last_error AS lastError FROM wake_events WHERE message_id = ?`,
    ).bind(second).first<{
      status: string; attempts: number; nextAttempt: string; lastError: string | null;
    }>();
    expect(wakeAfterConfirmation).not.toBeNull();

    if (wakeAfterConfirmation!.status === 'delivered') {
      expect(scenario.client.wakeCallbacks.filter((entry) =>
        entry.body.messageID === second),
      'A delivered Wake must have a real matching callback; dispatch calls during confirmation: ' +
        dispatchCalls + ', persisted state: ' + JSON.stringify(wakeAfterConfirmation))
        .toHaveLength(1);
    } else {
      expect(wakeAfterConfirmation!.status,
        'Wake should remain pending only until a dispatch handles the released Message')
        .toBe('pending');
      expect(Date.parse(wakeAfterConfirmation!.nextAttempt),
        'A pending Wake must be eligible immediately after confirmation; dispatch calls: ' +
        dispatchCalls + ', persisted state: ' + JSON.stringify(wakeAfterConfirmation))
        .toBeLessThanOrEqual(Date.now());
    }

    const repeated = await scenario.client.call('token-g', 'PUT',
      path + '?session_id=session-g', receipt);
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.alreadyConfirmed).toBe(true);

    const conflicting = await scenario.client.call('token-g', 'PUT',
      path + '?session_id=session-g',
      { messageID: first, nativeThreadID: 'wrong-native-thread' });
    expect(conflicting.status).toBe(409);

    // The due timestamp is meaningful for pending events only. A delivered
    // event keeps its historic retry timestamp, even after a successful Wake.
    await WakeService.dispatchDue(env);
    expect(scenario.client.wakeCallbacks.map((entry) => entry.body.messageID))
      .toEqual([first, second]);
    expect(scenario.client.wakeCallbacks[1].body).toMatchObject({
      messageID: second, recipientSessionID: 'session-b',
      recipientBotID: 'openmaus-bear-id',
      recipientPlatformThreadID: 'cosmo-real-thread-1',
    });

    const recipientView = await scenario.client.call('token-b', 'GET',
      '/v2/gateway-conversations?session_id=session-b');
    expect(recipientView.status).toBe(200);
    expect(recipientView.body.data).toEqual([
      { senderSessionID: 'session-a', nativeThreadID: 'cosmo-real-thread-1' },
    ]);

    expect((await scenario.client.call('token-b', 'DELETE',
      '/v2/gateway-invitation?session_id=session-b')).status).toBe(200);
    const revoked = await scenario.client.call('token-g', 'PUT',
      path + '?session_id=session-g', receipt);
    expect(revoked.status).toBe(403);
  });

  it('does not release another coworker waiting on the same shared Gateway', async () => {
    const dispatchTrace: Array<{
      startedAt: number; endedAt?: number; state: string; caller: string;
      origin?: string; error?: string;
    }> = [];
    const originalDispatch = WakeService.dispatchDue;
    vi.spyOn(WakeService, 'dispatchDue').mockImplementation(async (currentEnv, origin) => {
      const run = {
        startedAt: Date.now(),
        state: 'running',
        origin: origin ?? 'direct',
        caller: (new Error().stack ?? '').split('\n').slice(2, 6).join(' | '),
      } as (typeof dispatchTrace)[number];
      dispatchTrace.push(run);

      try {
        await originalDispatch.call(WakeService, currentEnv, origin);
        run.state = 'completed';
      } catch (error) {
        run.state = 'rejected';
        run.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        run.endedAt = Date.now();
      }
    });
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    expect((await scenario.invite('relay-test-org/beta/reviewer',
      'bear-bot', 'explicit', 'automatic')).status).toBe(201);
    expect((await scenario.invite('relay-test-org/gamma/main',
      'analyst-bot', 'explicit', 'automatic')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);
    expect((await scenario.approve('token-d', 'session-d')).status).toBe(200);

    const bearFirst = await scenario.send('token-a', 'session-a',
      'relay-test-org/beta/reviewer', 'Start the bear conversation.');
    const bearWaiting = await scenario.send('token-a', 'session-a',
      'relay-test-org/beta/reviewer', 'Queue a bear follow-up.');
    const analystFirst = await scenario.send('token-a', 'session-a',
      'relay-test-org/gamma/main', 'Start the analyst conversation.');
    const analystWaiting = await scenario.send('token-a', 'session-a',
      'relay-test-org/gamma/main', 'Queue an analyst follow-up.');

    expect(scenario.client.wakeCallbacks.map((item) => item.body.messageID))
      .toEqual([bearFirst, analystFirst]);

    // Reproduce a Wake with an outstanding dispatch lease. Confirmation
    // overrides this stale lease for the confirmed recipient only.
    const heldUntil = new Date(Date.now() + 30_000).toISOString();
    const held = await env.DB.batch([
      env.DB.prepare(
        `UPDATE wake_events SET lease_owner = ?, lease_until = ?
          WHERE message_id = ? AND status = 'pending'`,
      ).bind('held-bear', heldUntil, bearWaiting),
      env.DB.prepare(
        `UPDATE wake_events SET lease_owner = ?, lease_until = ?
          WHERE message_id = ? AND status = 'pending'`,
      ).bind('held-analyst', heldUntil, analystWaiting),
    ]);
    expect(held.map((item) => item.meta.changes)).toEqual([1, 1]);

    // Reproduce the precise pair before confirming either coworker: a real
    // received Message with a pending, currently leased shared-Gateway Wake.
    const waitingPair = await env.DB.prepare(
      `SELECT e.message_id AS messageID
         FROM wake_events e JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND m.sender_session_id = ?
          AND m.recipient_session_id = ? AND m.received_at IS NOT NULL
          AND e.message_id <> ? AND e.status = 'pending'`,
    ).bind('org-id', 'session-a', 'session-b', bearFirst)
      .all<{ messageID: string }>();
    expect(waitingPair.results.map((entry) => entry.messageID),
      'Confirmed recipient must own a received, pending follow-up Wake')
      .toContain(bearWaiting);
    expect(waitingPair.results.map((entry) => entry.messageID),
      'A different coworker must not be released through this pair')
      .not.toContain(analystWaiting);

    const confirmSpy = vi.spyOn(GatewayFirstContacts.prototype, 'confirm');
    let bearConfirmed: Awaited<ReturnType<typeof scenario.client.call>>;

    try {
      bearConfirmed = await scenario.client.call('token-g', 'PUT',
        '/v2/gateway-teammates/session-b/first-contacts/session-a?session_id=session-g', {
          messageID: bearFirst, nativeThreadID: 'bear-work-thread',
        });

      expect(confirmSpy).toHaveBeenCalledWith(
        'session-a', bearFirst, 'bear-work-thread');
      const confirmingContact = confirmSpy.mock.instances[0] as unknown as {
        organizationID: string; recipientSessionID: string;
      };
      expect({
        organizationID: confirmingContact.organizationID,
        recipientSessionID: confirmingContact.recipientSessionID,
      }, 'The authorized Gateway confirmation must use the same immutable pair as the queued Message')
        .toEqual({ organizationID: 'org-id', recipientSessionID: 'session-b' });
    } finally {
      confirmSpy.mockRestore();
    }

    expect(bearConfirmed!.status).toBe(200);
    const confirmedAt = Date.now();

    const queue = await env.DB.prepare(
      `SELECT message_id AS messageID, next_attempt_at AS nextAttempt,
              status, attempts, last_error AS lastError,
              lease_owner AS leaseOwner, lease_until AS leaseUntil
         FROM wake_events WHERE message_id IN (?, ?)`,
    ).bind(bearWaiting, analystWaiting)
      .all<{
        messageID: string; nextAttempt: string; status: string;
        attempts: number; lastError: string | null;
        leaseOwner: string | null; leaseUntil: string | null;
      }>();
    const schedule = new Map(queue.results.map((item) => [item.messageID, item]));
    const bear = schedule.get(bearWaiting);
    const analyst = schedule.get(analystWaiting);
    expect(bear).toBeDefined();
    expect(analyst).toBeDefined();

    if (bear!.status === 'delivered') {
      expect(scenario.client.wakeCallbacks.filter((entry) =>
        entry.body.messageID === bearWaiting),
      'Delivered bear Wake must have an actual callback: ' + JSON.stringify(queue.results))
        .toHaveLength(1);
    } else {
      expect(bear!.status).toBe('pending');
      expect(Date.parse(bear!.nextAttempt),
        'Confirmed bear Wake must be due; actual states: ' + JSON.stringify(queue.results))
        .toBeLessThanOrEqual(Date.now());
    }

    // Snapshot before any diagnostic reads or writes, so a later lease
    // cannot be mistaken for the one present at confirmation time.
    const receiptSnapshot = {
      status: bear!.status, attempts: bear!.attempts,
      nextAttempt: bear!.nextAttempt, lastError: bear!.lastError,
      leaseOwner: bear!.leaseOwner, leaseUntil: bear!.leaseUntil,
    };

    if (receiptSnapshot.status === 'pending' &&
        (receiptSnapshot.leaseOwner !== null || receiptSnapshot.leaseUntil !== null)) {
      // This is an intentionally failing diagnostic, not a repair to the test
      // fixture. It runs before due-query assertions and reports both probes
      // in the exact failure that the Windows runner will print.
      let directReceipt: Record<string, unknown>;

      try {
        const retried = await new GatewayFirstContacts(
          env, 'org-id', 'session-b',
        ).confirm('session-a', bearFirst, 'bear-work-thread');
        const afterRetry = await env.DB.prepare(
          `SELECT status, lease_owner AS leaseOwner, lease_until AS leaseUntil
            FROM wake_events WHERE message_id = ?`,
        ).bind(bearWaiting).first<{
          status: string; leaseOwner: string | null; leaseUntil: string | null;
        }>();
        directReceipt = {
          alreadyConfirmed: retried.alreadyConfirmed, afterRetry,
        };
      } catch (error) {
        directReceipt = { error: error instanceof Error ? error.message : String(error) };
      }

      const forced = await env.DB.prepare(
        `UPDATE wake_events
            SET lease_owner = NULL, lease_until = NULL
          WHERE message_id = ? AND status = 'pending'`,
      ).bind(bearWaiting).run();
      const afterPrimaryKeyUpdate = await env.DB.prepare(
        `SELECT status, lease_owner AS leaseOwner, lease_until AS leaseUntil
          FROM wake_events WHERE message_id = ?`,
      ).bind(bearWaiting).first<{
        status: string; leaseOwner: string | null; leaseUntil: string | null;
      }>();

      throw new Error('WAKE_RELEASE_V12_RECEIPT_LEASE_DIAGNOSTIC ' + JSON.stringify({
        beforeProbes: receiptSnapshot, directReceipt,
        primaryKeyChanges: forced.meta.changes,
        afterPrimaryKeyUpdate,
        otherCoworker: {
          status: analyst!.status, leaseOwner: analyst!.leaseOwner,
          leaseUntil: analyst!.leaseUntil,
        },
      }));
    }

    expect(receiptSnapshot.leaseOwner,
      'Lease must be released at confirmation, not after the due query').toBeNull();
    expect(receiptSnapshot.leaseUntil).toBeNull();
    expect(analyst!.status, 'The other coworker must remain pending').toBe('pending');
    expect(analyst!.leaseOwner, 'Do not invalidate another coworker\'s Wake lease')
      .toBe('held-analyst');
    expect(analyst!.leaseUntil).toBe(heldUntil);
    expect(Date.parse(analyst!.nextAttempt),
      'The other coworker must retain its first-contact delay')
      .toBeGreaterThan(Date.now());

    // Mirror the dispatch query's eligibility rules to distinguish an
    // unselected Wake from a selected Wake whose dispatch fails or is leased.
    const now = new Date().toISOString();
    const dispatchCandidates = await env.DB.prepare(
      `SELECT e.message_id AS messageID
         FROM wake_events e
         JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
         LEFT JOIN gateway_teammates g
           ON g.org_id = t.org_id AND g.recipient_session_id = m.recipient_session_id
          AND g.gateway_session_id = e.session_id AND g.status = 'active'
         JOIN wake_subscriptions s
           ON s.org_id = t.org_id AND s.session_id = e.session_id
        WHERE e.status = 'pending' AND e.next_attempt_at <= ?
          AND m.received_at IS NOT NULL
          AND (e.lease_until IS NULL OR e.lease_until <= ?)
        ORDER BY e.next_attempt_at LIMIT 25`,
    ).bind(now, now).all<{ messageID: string }>();
    const eligibleIDs = dispatchCandidates.results.map((item) => item.messageID);
    const preDispatch = await env.DB.prepare(
      `SELECT e.message_id AS messageID, e.session_id AS wakeSessionID,
              e.status, e.attempts, e.next_attempt_at AS nextAttempt,
              e.last_error AS lastError, e.lease_owner AS leaseOwner,
              e.lease_until AS leaseUntil, m.received_at AS receivedAt
         FROM wake_events e JOIN messages m ON m.id = e.message_id
        WHERE e.message_id IN (?, ?)`,
    ).bind(bearWaiting, analystWaiting).all<{
      messageID: string; wakeSessionID: string; status: string; attempts: number;
      nextAttempt: string; lastError: string | null;
      leaseOwner: string | null; leaseUntil: string | null; receivedAt: string | null;
    }>();
    const wakeOwnerMembership = await env.DB.prepare(
      `SELECT e.message_id AS messageID, e.session_id AS wakeSessionID,
              g.gateway_session_id AS approvedGatewaySessionID,
              m.recipient_session_id AS recipientSessionID
         FROM wake_events e JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
         LEFT JOIN gateway_teammates g
           ON g.org_id = t.org_id AND g.recipient_session_id = m.recipient_session_id
          AND g.gateway_session_id = e.session_id AND g.status = 'active'
        WHERE e.message_id IN (?, ?)`,
    ).bind(bearWaiting, analystWaiting).all<{
      messageID: string; wakeSessionID: string;
      approvedGatewaySessionID: string | null; recipientSessionID: string;
    }>();
    expect(wakeOwnerMembership.results).toEqual(expect.arrayContaining([
      { messageID: bearWaiting, wakeSessionID: 'session-g',
        approvedGatewaySessionID: 'session-g', recipientSessionID: 'session-b' },
      { messageID: analystWaiting, wakeSessionID: 'session-g',
        approvedGatewaySessionID: 'session-g', recipientSessionID: 'session-d' },
    ]));
    const beforeDispatch = preDispatch.results.find(
      (entry) => entry.messageID === bearWaiting);
    expect(beforeDispatch).toBeDefined();
    const alreadyClaimed = beforeDispatch!.status === 'pending' &&
      beforeDispatch!.leaseOwner !== null &&
      beforeDispatch!.leaseUntil !== null &&
      Date.parse(beforeDispatch!.leaseUntil) > Date.now();
    const alreadyDelivered = beforeDispatch!.status === 'delivered';
    const locallyEligible = eligibleIDs.includes(bearWaiting);

    expect(locallyEligible || alreadyClaimed || alreadyDelivered,
      'WAKE_DISPATCH_V13_NO_OWNER: Bear must be due, legitimately in flight, ' +
      'or already delivered: ' + JSON.stringify({
        confirmedAt, receiptSnapshot, beforeDispatch,
        eligibleIDs, wakeOwnerMembership: wakeOwnerMembership.results,
        dispatchTrace,
      })).toBe(true);
    expect(eligibleIDs, 'The unconfirmed analyst must not be selected')
      .not.toContain(analystWaiting);

    // Another dispatcher may claim a released Wake between our snapshot and
    // this query. A claimed Wake correctly disappears from the due SELECT.
    // Do not race its outbound callback with a second forced dispatch.
    if (locallyEligible) {
      await WakeService.dispatchDue(env);
    }

    try {
      await vi.waitFor(async () => {
        const persisted = await env.DB.prepare(
          `SELECT status, lease_owner AS leaseOwner, lease_until AS leaseUntil,
                  attempts, last_error AS lastError
             FROM wake_events WHERE message_id = ?`,
        ).bind(bearWaiting).first<{
          status: string; leaseOwner: string | null;
          leaseUntil: string | null; attempts: number; lastError: string | null;
        }>();
        expect(persisted).toMatchObject({
          status: 'delivered', leaseOwner: null, leaseUntil: null,
        });
        expect(scenario.client.wakeCallbacks.filter(
          (entry) => entry.body.messageID === bearWaiting)).toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
    } catch (error) {
      const last = await env.DB.prepare(
        `SELECT status, attempts, next_attempt_at AS nextAttempt,
                last_error AS lastError, lease_owner AS leaseOwner,
                lease_until AS leaseUntil FROM wake_events WHERE message_id = ?`,
      ).bind(bearWaiting).first();
      throw new Error('WAKE_DISPATCH_V13_STUCK_IN_FLIGHT ' + JSON.stringify({
        confirmedAt, receiptSnapshot, beforeDispatch,
        eligibleIDs, last, dispatchTrace,
        callbackIDs: scenario.client.wakeCallbacks.map((item) => item.body.messageID),
        cause: error instanceof Error ? error.message : String(error),
      }));
    }

    expect(scenario.client.wakeCallbacks.map((item) => item.body.messageID))
      .toEqual([bearFirst, analystFirst, bearWaiting]);
    expect(scenario.client.wakeCallbacks[2].body).toMatchObject({
      messageID: bearWaiting, recipientSessionID: 'session-b',
      recipientBotID: 'bear-bot', recipientPlatformThreadID: 'bear-work-thread',
    });

    const analystQueued = await env.DB.prepare(
      'SELECT status FROM wake_events WHERE message_id = ?',
    ).bind(analystWaiting).first<{ status: string }>();
    expect(analystQueued?.status,
      'Confirming one recipient must not release another recipient on the same shared Gateway')
      .toBe('pending');

    const analystConfirmed = await scenario.client.call('token-g', 'PUT',
      '/v2/gateway-teammates/session-d/first-contacts/session-a?session_id=session-g', {
        messageID: analystFirst, nativeThreadID: 'analyst-work-thread',
      });
    expect(analystConfirmed.status).toBe(200);
    await WakeService.dispatchDue(env);

    try {
      await vi.waitFor(async () => {
        const delivered = await env.DB.prepare(
          `SELECT status, lease_owner AS leaseOwner, lease_until AS leaseUntil
            FROM wake_events WHERE message_id = ?`,
        ).bind(analystWaiting).first<{
          status: string; leaseOwner: string | null; leaseUntil: string | null;
        }>();
        expect(delivered).toMatchObject({
          status: 'delivered', leaseOwner: null, leaseUntil: null,
        });
        expect(scenario.client.wakeCallbacks.filter(
          (entry) => entry.body.messageID === analystWaiting)).toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
    } catch (error) {
      const analystState = await env.DB.prepare(
        `SELECT status, attempts, next_attempt_at AS nextAttempt,
                last_error AS lastError, lease_owner AS leaseOwner,
                lease_until AS leaseUntil FROM wake_events WHERE message_id = ?`,
      ).bind(analystWaiting).first();
      throw new Error('WAKE_DISPATCH_V13_ANALYST_STUCK ' + JSON.stringify({
        analystState, dispatchTrace,
        callbackIDs: scenario.client.wakeCallbacks.map((item) => item.body.messageID),
        cause: error instanceof Error ? error.message : String(error),
      }));
    }

    expect(scenario.client.wakeCallbacks.map((item) => ({
      messageID: item.body.messageID,
      nativeThreadID: item.body.recipientPlatformThreadID,
    }))).toEqual([
      { messageID: bearFirst, nativeThreadID: null },
      { messageID: analystFirst, nativeThreadID: null },
      { messageID: bearWaiting, nativeThreadID: 'bear-work-thread' },
      { messageID: analystWaiting, nativeThreadID: 'analyst-work-thread' },
    ]);
    console.info('WAKE_DISPATCH_V13_TRACE ' + JSON.stringify({
      confirmedAt, receiptSnapshot, beforeDispatch, dispatchTrace,
    }));
  }, 25_000);

  it('revokes a named coworker using a fresh authorized directory and preserves other routes', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    expect((await scenario.invite('relay-test-org/beta/reviewer',
      'bear-to-remove')).status).toBe(201);
    expect((await scenario.invite('relay-test-org/gamma/main',
      'analyst-to-keep')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);
    expect((await scenario.approve('token-d', 'session-d')).status).toBe(200);

    const ambiguous = await scenario.client.call('token-g', 'DELETE',
      '/v2/gateway-teammates?session_id=session-g&recipient_name=' +
        encodeURIComponent('雙胞胎'));
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('recipient_name_ambiguous');

    const outsider = await scenario.client.call('token-h', 'DELETE',
      '/v2/gateway-teammates?session_id=session-h&recipient_name=' +
        encodeURIComponent('大熊'));
    expect(outsider.status).toBe(404);

    const revoked = await scenario.client.call('token-g', 'DELETE',
      '/v2/gateway-teammates?session_id=session-g&recipient_name=' +
        encodeURIComponent('大熊'));
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({
      removed: true, recipientSessionID: 'session-b',
    });
    expect(scenario.client.nameDirectoryLookups,
      'Every destructive name resolution must read Agent Address freshly').toBe(3);


    const roster = await scenario.client.call('token-g', 'GET',
      '/v2/gateway-teammates?session_id=session-g');
    expect(roster.status).toBe(200);
    expect(roster.body.data).toHaveLength(1);
    expect(roster.body.data[0]).toMatchObject({
      recipientSessionID: 'session-d', recipientBotID: 'analyst-to-keep',
      status: 'active',
    });

    const both = await scenario.client.call('token-g', 'DELETE',
      '/v2/gateway-teammates?session_id=session-g&recipient_name=' +
        encodeURIComponent('大熊') + '&recipient_address=relay-test-org/gamma/main');
    expect(both.status).toBe(400);
  });

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

  it('isolates independent senders even when their native Threads use one office Webhook', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const bear = 'relay-test-org/beta/reviewer';
    expect((await scenario.invite(bear, 'local-bear-bot', 'explicit', 'automatic')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);

    const first = await scenario.send('token-a', 'session-a', bear, 'First sender, first contact.');
    const second = await scenario.send('token-d', 'session-d', bear, 'Unrelated second sender.');
    expect(scenario.client.wakeCallbacks).toHaveLength(2);
    expect(scenario.client.wakeCallbacks.map((event) => event.body.recipientPlatformThreadID))
      .toEqual([null, null]);

    const a = await scenario.client.call('token-b', 'PUT',
      '/v2/gateway-first-contacts/session-a?session_id=session-b', {
        messageID: first, nativeThreadID: 'thread-from-a',
      });
    const d = await scenario.client.call('token-b', 'PUT',
      '/v2/gateway-first-contacts/session-d?session_id=session-b', {
        messageID: second, nativeThreadID: 'thread-from-d',
      });
    expect(a.status).toBe(200);
    expect(d.status).toBe(200);

    const followA = await scenario.send('token-a', 'session-a', bear, 'Second message from first sender.');
    const followD = await scenario.send('token-d', 'session-d', bear, 'Second message from other sender.');
    expect(scenario.client.wakeCallbacks.slice(-2).map((event) =>
      ({ id: event.body.messageID, nativeThread: event.body.recipientPlatformThreadID })))
      .toEqual([
        { id: followA, nativeThread: 'thread-from-a' },
        { id: followD, nativeThread: 'thread-from-d' },
      ]);

    const fromSender = await scenario.client.call('token-a', 'PUT',
      '/v2/gateway-first-contacts/session-a?session_id=session-b', {
        messageID: first, nativeThreadID: 'attacker-thread',
      });
    expect(fromSender.status).toBe(409);

    const sharedWake = await scenario.client.call('token-b', 'GET',
      '/v2/wake-subscription?session_id=session-b');
    expect(sharedWake.body.data).toMatchObject({
      enabled: true, receiverMode: 'gateway', gatewaySessionID: 'session-g',
    });

    const cannotDisable = await scenario.client.call('token-g', 'DELETE',
      '/v2/wake-subscription?session_id=session-g');
    expect(cannotDisable.status).toBe(409);

    const cannotReplace = await scenario.client.call('token-b', 'PUT',
      '/v2/gateway-route?session_id=session-b', {
        recipientBotID: 'sneaky-bot', threadMode: 'platform',
      });
    expect(cannotReplace.status).toBe(409);
  });

  it('lets real coworkers converse through two separately approved office switchboards', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const officeAWake = await scenario.client.call('token-h', 'POST',
      '/v2/wake-subscription?session_id=session-h', {
        callbackUrl: 'https://agent-hook.example.com/office-a',
      });
    expect(officeAWake.status).toBe(201);
    await scenario.client.confirmLatestWake('token-h');

    const senderAddress = 'relay-test-org/alpha/author';
    const recipientAddress = 'relay-test-org/beta/reviewer';

    expect((await scenario.invite(recipientAddress, 'office-b-bot')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);

    const officeARegistration = await scenario.client.call('token-h', 'POST',
      '/v2/gateway-teammates?session_id=session-h', {
        recipientAddress: senderAddress,
        recipientBotID: 'office-a-bot',
        threadMode: 'platform',
      });
    expect(officeARegistration.status).toBe(201);
    const approvedA = await scenario.client.call('token-a', 'PUT',
      '/v2/gateway-invitation?session_id=session-a');
    expect(approvedA.status).toBe(200);

    const first = await scenario.client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: recipientAddress, body: 'Hello from office A to office B.',
      });
    expect(first.status).toBe(201);

    await MailReceipt.confirmArrival(env, first.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    const reply = await scenario.client.call('token-b', 'POST',
      '/v2/threads/' + first.body.data.threadId + '/messages?session_id=session-b', {
        body: 'Office B answered the same call.',
      });
    expect(reply.status).toBe(201);
    await MailReceipt.confirmArrival(env, reply.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    const later = await scenario.client.call('token-b', 'POST',
      '/v2/messages?session_id=session-b', {
        to: senderAddress, body: 'Office B proactively started a second call.',
      });
    expect(later.status).toBe(201);
    expect(later.body.data.threadId).not.toBe(first.body.data.threadId);
    await MailReceipt.confirmArrival(env, later.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    const returnReply = await scenario.client.call('token-a', 'POST',
      '/v2/threads/' + later.body.data.threadId + '/messages?session_id=session-a', {
        body: 'Office A answered the second call.',
      });
    expect(returnReply.status).toBe(201);
    await MailReceipt.confirmArrival(env, returnReply.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    const deliveries = scenario.client.wakeRequests.filter((item) =>
      item.body.event === 'nuwa.message.available');
    expect(deliveries, 'Each actual message is sent through exactly the opposite office')
      .toHaveLength(4);
    expect(deliveries.map((item) => ({
      path: new URL(item.url).pathname,
      recipient: item.body.recipientSessionID,
      bot: item.body.recipientBotID,
      relayThread: item.body.relayThreadID,
    }))).toEqual([
      { path: '/gateway', recipient: 'session-b',
        bot: 'office-b-bot', relayThread: first.body.data.threadId },
      { path: '/office-a', recipient: 'session-a',
        bot: 'office-a-bot', relayThread: first.body.data.threadId },
      { path: '/office-a', recipient: 'session-a',
        bot: 'office-a-bot', relayThread: later.body.data.threadId },
      { path: '/gateway', recipient: 'session-b',
        bot: 'office-b-bot', relayThread: later.body.data.threadId },
    ]);

    const history = await scenario.client.call('token-a', 'GET',
      '/v2/threads/' + first.body.data.threadId + '?session_id=session-a');
    expect(history.status).toBe(200);
    expect(history.body.data.map((message: { body: string }) => message.body))
      .toEqual(['Hello from office A to office B.', 'Office B answered the same call.']);

    const newHistory = await scenario.client.call('token-b', 'GET',
      '/v2/threads/' + later.body.data.threadId + '?session_id=session-b');
    expect(newHistory.status).toBe(200);
    expect(newHistory.body.data.map((message: { body: string }) => message.body))
      .toEqual(['Office B proactively started a second call.', 'Office A answered the second call.']);
  });

  it('does not delete a coworker-owned direct route when revoking an unapproved invitation', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const direct = await scenario.client.call('token-b', 'PUT',
      '/v2/gateway-route?session_id=session-b', {
        recipientBotID: 'recipient-existing-bot', threadMode: 'platform',
      });
    expect(direct.status).toBe(200);

    const invited = await scenario.invite('relay-test-org/beta/reviewer', 'recipient-existing-bot');
    expect(invited.status).toBe(201);

    const revoked = await scenario.client.call('token-g', 'DELETE',
      '/v2/gateway-teammates?session_id=session-g&recipient_address=' +
        encodeURIComponent('relay-test-org/beta/reviewer'));
    expect(revoked.status).toBe(200);

    const stillOwned = await scenario.client.call('token-b', 'GET',
      '/v2/gateway-route?session_id=session-b');
    expect(stillOwned.body.data, 'Unapproved Gateway must not remove independently owned routes')
      .toMatchObject({ recipientBotID: 'recipient-existing-bot', threadMode: 'platform' });
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

  it('revoking one shared office coworker cancels only that coworker\'s pending Wake', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    expect((await scenario.invite('relay-test-org/beta/reviewer',
      'bear-bot')).status).toBe(201);
    expect((await scenario.invite('relay-test-org/gamma/main',
      'analyst-bot')).status).toBe(201);
    expect((await scenario.approve('token-b', 'session-b')).status).toBe(200);
    expect((await scenario.approve('token-d', 'session-d')).status).toBe(200);

    const bear = await scenario.client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: '大熊', body: 'Please call the bear.',
      });
    const analyst = await scenario.client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: 'relay-test-org/gamma/main', body: 'Please call the analyst.',
      });
    expect(bear.status).toBe(201);
    expect(analyst.status).toBe(201);

    await MailReceipt.confirmArrival(env, bear.body.data.id, 'webhook');
    await MailReceipt.confirmArrival(env, analyst.body.data.id, 'webhook');

    const queued = await env.DB.prepare(
      'SELECT message_id AS messageID FROM wake_events WHERE message_id IN (?, ?) AND status = ?',
    ).bind(bear.body.data.id, analyst.body.data.id, 'pending')
      .all<{ messageID: string }>();
    expect(queued.results.map((row) => row.messageID))
      .toEqual(expect.arrayContaining([bear.body.data.id, analyst.body.data.id]));

    const removed = await scenario.client.call('token-g', 'DELETE',
      '/v2/gateway-teammates?session_id=session-g&recipient_address=' +
        encodeURIComponent('relay-test-org/beta/reviewer'));
    expect(removed.status).toBe(200);

    const remaining = await env.DB.prepare(
      'SELECT message_id AS messageID FROM wake_events WHERE message_id IN (?, ?) AND status = ?',
    ).bind(bear.body.data.id, analyst.body.data.id, 'pending')
      .all<{ messageID: string }>();
    expect(remaining.results.map((row) => row.messageID)).toEqual([analyst.body.data.id]);

    await WakeService.dispatchDue(env);
    expect(scenario.client.wakeCallbacks).toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body).toMatchObject({
      recipientBotID: 'analyst-bot',
      messageID: analyst.body.data.id,
    });
  });

  it('keeps office registration inside an authorized, verified Gateway and rejects name collisions', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const coworker = {
      displayName: '大熊', recipientBotID: 'office-must-not-steal',
      threadMode: 'platform',
    };
    const collision = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [coworker],
      });

    expect(collision.status).toBe(409);
    expect(collision.body.error.code).toBe('office_coworker_name_conflict');
    expect(scenario.client.officeRegistrations).toHaveLength(0);

    const unverified = await scenario.client.call('token-h', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-h', {
        coworkers: [{ ...coworker, displayName: '未登記' }],
      });
    expect(unverified.status).toBe(409);
    expect(unverified.body.error.code).toBe('gateway_wake_required');

    const duplicated = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [coworker, coworker],
      });
    expect(duplicated.status).toBe(409);
    expect(duplicated.body.error.code).toBe('office_roster_duplicate');
    expect(scenario.client.officeRegistrations).toHaveLength(0);
  });

  it('connects a whole native office under one authorized Gateway Wake without coworker OAuth', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const office = (coworkers: object[]) => scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', { coworkers });
    const members = [
      { displayName: '雲朵', recipientBotID: 'office-cloud-001', threadMode: 'platform' },
      { displayName: '小河', recipientBotID: 'office-river-002', threadMode: 'platform' },
    ];

    const missingBeforeEnrollment = await scenario.client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: '雲朵', body: 'Name not yet present in the office directory.',
      });
    expect(missingBeforeEnrollment.status).toBe(404);

    const enrolled = await office(members);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.data).toHaveLength(2);
    expect(scenario.client.officeRegistrations).toHaveLength(2);
    expect(enrolled.body.data.map((item: { recipientCanonicalAddress: string }) =>
      item.recipientCanonicalAddress))
      .toEqual(enrolled.body.data.map((item: { recipientCanonicalAddress: string }) =>
        expect.stringMatching(/^relay-test-org\/office-[a-f0-9]{32}\/main$/)));
    expect(JSON.stringify(enrolled.body)).not.toContain('private-office-resume');

    const directory = await scenario.client.call('token-g', 'GET',
      '/v2/gateway-office-coworkers?session_id=session-g');
    expect(directory.status).toBe(200);
    expect(directory.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayName: '雲朵', recipientBotID: 'office-cloud-001', enabled: true,
        recipientSessionID: enrolled.body.data[0].recipientSessionID,
      }),
      expect.objectContaining({
        displayName: '小河', recipientBotID: 'office-river-002', enabled: true,
        recipientSessionID: enrolled.body.data[1].recipientSessionID,
      }),
    ]));
    expect(JSON.stringify(directory.body)).not.toContain('resumeToken');

    const roster = await scenario.client.call('token-g', 'GET',
      '/v2/gateway-teammates?session_id=session-g');
    expect(roster.status).toBe(200);
    for (const member of members) {
      expect(roster.body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          recipientBotID: member.recipientBotID,
          status: 'active',
          gatewaySessionID: 'session-g',
        }),
      ]));
    }

    // A registered address is a real recipient, not authorization for the
    // office Gateway to send messages or accept work as that coworker.
    const gatewayCannotSpeak = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        to: '雲朵', body: 'Gateway tried to relay a coworker reply as itself.',
      });
    expect(gatewayCannotSpeak.status,
      'The office switchboard must not publish a coworker reply with Gateway authority').toBe(403);
    expect(gatewayCannotSpeak.body.error.code).toBe('gateway_voice_forbidden');

    const forbiddenVoice = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=' + enrolled.body.data[0].recipientSessionID, {
        to: '小晴', body: 'Gateway must never speak as 雲朵.',
      });
    expect(forbiddenVoice.status).toBe(409);
    expect(forbiddenVoice.body.error.code).toBe('address_authorization_failed');

    const mailbox = await env.DB.prepare(
      'SELECT mailbox_email AS email FROM agent_mailboxes WHERE org_id = ? AND agent_id = ?',
    ).bind('org-id', roster.body.data.find(
      (member: { recipientBotID: string }) => member.recipientBotID === 'office-cloud-001',
    ).recipientAgentID)
      .first<{ email: string }>();
    expect(mailbox?.email).toBeTruthy();

    const oneWake = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM wake_subscriptions WHERE session_id IN (?, ?)',
    ).bind(enrolled.body.data[0].recipientSessionID,
      enrolled.body.data[1].recipientSessionID).first<{ count: number }>();
    expect(oneWake?.count).toBe(0);

    const submitted = await scenario.client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: '雲朵', body: '小晴直接撥給雲朵，由辦公室總機接線。',
      });
    expect(submitted.status).toBe(201);
    await MailReceipt.confirmArrival(env, submitted.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    expect(scenario.client.wakeCallbacks).toHaveLength(1);
    expect(scenario.client.wakeCallbacks[0].body).toMatchObject({
      senderDisplayName: '小晴',
      body: '小晴直接撥給雲朵，由辦公室總機接線。',
      event: 'nuwa.message.available',
      recipientBotID: 'office-cloud-001',
      recipientSessionID: enrolled.body.data[0].recipientSessionID,
      senderSessionID: 'session-a',
    });

    const again = await office(members);
    expect(again.status).toBe(201);
    expect(again.body.data).toEqual(enrolled.body.data);
    expect(scenario.client.officeRegistrations,
      'Retried office onboarding reuses actual Agent Addresses').toHaveLength(2);

    const third = await office([
      { displayName: '山雀', recipientBotID: 'office-bird-003', threadMode: 'platform' },
    ]);
    expect(third.status).toBe(201);
    expect(scenario.client.officeRegistrations).toHaveLength(3);
  });

  it('enrolls one real office roster without serializing every slow provider provisioning', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const staleOfficeMailboxes = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM agent_mailboxes WHERE org_id = ? AND agent_id LIKE ?',
    ).bind('org-id', 'office-agent-%').first<{ count: number }>();
    expect(staleOfficeMailboxes?.count,
      'Each simulated office starts with no mailboxes from the previous scenario').toBe(0);

    scenario.client.mailboxCreationDelayMs = 80;
    const coworkers = Array.from({ length: 4 }, (_, index) => ({
      displayName: 'Office parallel coworker ' + index,
      recipientBotID: 'office-parallel-' + index,
      threadMode: 'platform',
    }));

    const enrolled = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', { coworkers });

    expect(enrolled.status, 'The whole office should be accepted together').toBe(201);
    expect(enrolled.body.data).toHaveLength(coworkers.length);
    expect(scenario.client.maxConcurrentMailboxCreations,
      'Independent coworkers should not wait for each prior MailTrigger mailbox').toBeGreaterThan(1);

    const office = await scenario.client.call('token-g', 'GET',
      '/v2/gateway-office-coworkers?session_id=session-g');
    expect(office.status).toBe(200);

    for (const coworker of coworkers) {
      expect(office.body.data,
        'Every actual Bot should have its own active route under the verified Gateway')
        .toEqual(expect.arrayContaining([expect.objectContaining({
          displayName: coworker.displayName,
          recipientBotID: coworker.recipientBotID,
          enabled: true,
        })]));
    }
  });
});


describe('Gateway coworker speaking scenarios', () => {
  it('delivers an office-declared conversation while auditing the real Gateway actor', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const office = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [
          { displayName: '小晴-辦公室', recipientBotID: 'xiaoqing-native', threadMode: 'platform' },
          { displayName: '小安-辦公室', recipientBotID: 'annie-native', threadMode: 'platform' },
        ],
      });
    expect(office.status).toBe(201);

    // A normal call must use the mailbox and routes already configured at enrollment.
    scenario.client.failNextRouteLookup = true;
    const deliveryLookup = vi.spyOn(AgentMailboxService.prototype, 'forDelivery');
    const senderLookup = vi.spyOn(AgentMailboxService.prototype, 'ready');
    const recipientLookup = vi.spyOn(AgentMailboxService.prototype, 'require');

    const beforeStatus = scenario.client.accountStatusLookups;
    const beforeSessions = scenario.client.sessionLookups;
    const beforeLeases = scenario.client.runtimeLeaseLookups;
    const sendStarted = performance.now();
    const sent = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        from: '小晴-辦公室', to: '小安-辦公室', body: '請確認 NUWA-GROK-01。',
      });
    const sendMS = performance.now() - sendStarted;
    expect(sent.status).toBe(201);
    expect(deliveryLookup).toHaveBeenCalledTimes(1);
    expect(senderLookup).not.toHaveBeenCalled();
    expect(recipientLookup).not.toHaveBeenCalled();
    expect(scenario.client.accountStatusLookups - beforeStatus).toBe(0);
    expect(scenario.client.sessionLookups - beforeSessions).toBe(0);
    expect(scenario.client.runtimeLeaseLookups - beforeLeases).toBe(1);

    const messageID = sent.body.data.id as string;
    const threadID = sent.body.data.threadId as string;

    const audit = await env.DB.prepare(
      'SELECT t.sender_session_id AS senderSessionID, t.recipient_session_id AS recipientSessionID, ' +
      'm.actor_session_id AS actorSessionID, m.sender_auth_mode AS senderAuthMode, ' +
      'm.sender_display_name AS senderDisplayName ' +
      'FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.id = ?',
    ).bind(messageID).first();
    expect(audit).toEqual({
      senderSessionID: office.body.data[0].recipientSessionID,
      recipientSessionID: office.body.data[1].recipientSessionID,
      actorSessionID: 'session-g',
      senderAuthMode: 'office-trust',
      senderDisplayName: '小晴-辦公室',
    });

    await MailReceipt.confirmArrival(env, messageID, 'webhook');
    await WakeService.dispatchDue(env);
    expect(scenario.client.wakeCallbacks.find((entry) => entry.body.messageID === messageID)?.body)
      .toMatchObject({
        body: '請確認 NUWA-GROK-01。', senderDisplayName: '小晴-辦公室',
        senderAuthMode: 'office-trust',
        recipientBotID: 'annie-native', relayThreadID: threadID,
      });

    deliveryLookup.mockClear();
    senderLookup.mockClear();
    recipientLookup.mockClear();

    const replyStarted = performance.now();
    const replied = await scenario.client.call('token-g', 'POST',
      '/v2/threads/' + threadID + '/messages?session_id=session-g', {
        from: '小安-辦公室', body: '小晴，已收到。',
      });
    const replyMS = performance.now() - replyStarted;
    expect(replied.status).toBe(201);
    expect(deliveryLookup).toHaveBeenCalledTimes(1);
    expect(senderLookup).not.toHaveBeenCalled();
    expect(recipientLookup).not.toHaveBeenCalled();
    expect(scenario.client.failNextRouteLookup).toBe(true);

    console.info('OFFICE_MESSAGE_TIMING ' + JSON.stringify({ sendMS, replyMS }));

    const replyID = replied.body.data.id as string;
    const reply = await env.DB.prepare(
      'SELECT sender_session_id AS senderSessionID, recipient_session_id AS recipientSessionID, ' +
      'actor_session_id AS actorSessionID, sender_auth_mode AS senderAuthMode ' +
      'FROM messages WHERE id = ?',
    ).bind(replyID).first();
    expect(reply).toEqual({
      senderSessionID: office.body.data[1].recipientSessionID,
      recipientSessionID: office.body.data[0].recipientSessionID,
      actorSessionID: 'session-g', senderAuthMode: 'office-trust',
    });

    await MailReceipt.confirmArrival(env, replyID, 'webhook');
    await WakeService.dispatchDue(env);
    expect(scenario.client.wakeCallbacks.find((entry) => entry.body.messageID === replyID)?.body)
      .toMatchObject({
        senderDisplayName: '小安-辦公室', senderAuthMode: 'office-trust',
        recipientBotID: 'xiaoqing-native',
        relayThreadID: threadID,
      });

    const messagePath = '/v2/messages/' + replyID + '?session_id=session-g';
    const unreadable = await scenario.client.call('token-g', 'GET', messagePath);
    expect(unreadable.status).toBe(404);

    const ownMessage = await scenario.client.call('token-g', 'GET',
      messagePath + '&from=' + encodeURIComponent('小晴-辦公室') + '&context_limit=8');
    expect(ownMessage.status).toBe(200);
    expect(ownMessage.body.data).toMatchObject({
      id: replyID, threadId: threadID, body: '小晴，已收到。',
      recipientSessionID: office.body.data[0].recipientSessionID,
      recentThreadMessages: [expect.objectContaining({ id: messageID })],
    });

    const unregistered = await scenario.client.call('token-g', 'GET',
      messagePath + '&from=' + encodeURIComponent('未登記同事'));
    expect(unregistered.status).toBe(403);
  });

  it('lets registered office coworkers send and reply without opt-in or passphrases', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const enrolled = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [
          { displayName: '小晴-辦公室', recipientBotID: 'xiaoqing-native', threadMode: 'platform' },
          { displayName: '小安-辦公室', recipientBotID: 'annie-native', threadMode: 'platform' },
        ],
      });
    expect(enrolled.status).toBe(201);

    // An existing optional passphrase from the former design is not a prerequisite.
    await env.DB.prepare(
      'UPDATE gateway_office_coworkers SET passphrase_salt = ?, passphrase_hash = ? ' +
      'WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?',
    ).bind('legacy-salt', 'legacy-hash', 'org-id', 'session-g', 'xiaoqing-native').run();

    const first = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        from: '小晴-辦公室', to: '小安-辦公室', body: '小安，請回覆。',
      });
    expect(first.status).toBe(201);

    const reply = await scenario.client.call('token-g', 'POST',
      '/v2/threads/' + first.body.data.threadId + '/messages?session_id=session-g', {
        from: '小安-辦公室', body: '小晴，收到。',
      });
    expect(reply.status).toBe(201);
    expect(reply.body.data.threadId).toBe(first.body.data.threadId);

    const messages = await env.DB.prepare(
      'SELECT sender_session_id AS senderSessionID, actor_session_id AS actorSessionID, ' +
      'sender_auth_mode AS senderAuthMode FROM messages WHERE id IN (?, ?) ORDER BY created_at, id',
    ).bind(first.body.data.id, reply.body.data.id).all();
    expect(messages.results).toHaveLength(2);
    expect(messages.results.map((message) => message.actorSessionID)).toEqual([
      'session-g', 'session-g',
    ]);
    expect(messages.results.map((message) => message.senderAuthMode)).toEqual([
      'office-trust', 'office-trust',
    ]);

    await MailReceipt.confirmArrival(env, first.body.data.id, 'webhook');
    await MailReceipt.confirmArrival(env, reply.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    const dispatched = scenario.client.wakeCallbacks.map((callback) => callback.body);
    expect(dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recipientBotID: 'annie-native', senderDisplayName: '小晴-辦公室',
        relayThreadID: first.body.data.threadId,
      }),
      expect.objectContaining({
        recipientBotID: 'xiaoqing-native', senderDisplayName: '小安-辦公室',
        relayThreadID: first.body.data.threadId,
      }),
    ]));

    const unregistered = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        from: '不是這個辦公室的同事', to: '小安-辦公室', body: '不得冒名。',
      });
    expect(unregistered.status).toBe(403);
    expect(unregistered.body.error.code).toBe('gateway_sender_not_enrolled');

    const anotherGateway = await scenario.client.call('token-h', 'POST',
      '/v2/messages?session_id=session-h', {
        from: '小晴-辦公室', to: '小安-辦公室', body: '不得跨辦公室借名。',
      });
    expect(anotherGateway.status).toBe(403);
  });

  it('uses registered native Bot IDs for sending, replying and reading without name lookup', async () => {
    const scenario = new GatewayRosterScenario();
    await scenario.setup();

    const senderBotID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const recipientBotID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const registered = await scenario.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [
          { displayName: 'Brian | Administration', recipientBotID: senderBotID, threadMode: 'platform' },
          { displayName: 'Nora | Human Resources', recipientBotID, threadMode: 'platform' },
        ],
      });
    expect(registered.status).toBe(201);
    const [sender, recipient] = registered.body.data;
    const directoryLookups = scenario.client.nameDirectoryLookups;

    const sent = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        from: senderBotID, to: recipientBotID, body: 'Could you confirm receipt?',
      });
    expect(sent.status, 'Native IDs must resolve the enrolled coworkers').toBe(201);
    expect(scenario.client.nameDirectoryLookups).toBe(directoryLookups);
    const threadID = sent.body.data.threadId as string;

    await MailReceipt.confirmArrival(env, sent.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);

    expect(scenario.client.wakeCallbacks.find((entry) => entry.body.messageID === sent.body.data.id)?.body)
      .toMatchObject({ recipientBotID, relayThreadID: threadID, senderDisplayName: 'Brian | Administration' });

    const reply = await scenario.client.call('token-g', 'POST',
      '/v2/threads/' + threadID + '/messages?session_id=session-g', {
        from: 'bot:' + recipientBotID, body: 'Confirmed.',
      });
    expect(reply.status).toBe(201);
    expect(reply.body.data.threadId).toBe(threadID);

    const received = await scenario.client.call('token-g', 'GET',
      '/v2/messages/' + reply.body.data.id + '?session_id=session-g&from=' + senderBotID);
    expect(received.status).toBe(200);
    expect(received.body.data.body).toBe('Confirmed.');

    const rows = await env.DB.prepare(
      `SELECT sender_session_id AS senderSessionID, recipient_session_id AS recipientSessionID,
              actor_session_id AS actorSessionID FROM messages WHERE id IN (?, ?)`,
    ).bind(sent.body.data.id, reply.body.data.id).all();
    expect(rows.results).toEqual(expect.arrayContaining([
      { senderSessionID: sender.recipientSessionID,
        recipientSessionID: recipient.recipientSessionID, actorSessionID: 'session-g' },
      { senderSessionID: recipient.recipientSessionID,
        recipientSessionID: sender.recipientSessionID, actorSessionID: 'session-g' },
    ]));

    const otherOffice = await scenario.client.call('token-h', 'POST',
      '/v2/messages?session_id=session-h', {
        from: senderBotID, to: recipientBotID, body: 'Unapproved sender.',
      });
    expect(otherOffice.status).toBe(403);

    const unknown = await scenario.client.call('token-g', 'POST',
      '/v2/messages?session_id=session-g', {
        from: senderBotID, to: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        body: 'An unregistered group must not be treated as a Bot.',
      });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('recipient_bot_not_found');

    const duplicate = await scenario.client.call('token-b', 'PUT',
      '/v2/gateway-route?session_id=session-b', { recipientBotID, threadMode: 'platform' });
    expect(duplicate.status).toBe(200);

    try {
      const ambiguous = await scenario.client.call('token-g', 'POST',
        '/v2/messages?session_id=session-g', {
          from: senderBotID, to: recipientBotID, body: 'Ambiguous native ID.',
        });
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.error.code).toBe('recipient_bot_ambiguous');
      expect(scenario.client.deliveries).toHaveLength(2);
    } finally {
      await scenario.client.call('token-b', 'DELETE', '/v2/gateway-route?session_id=session-b');
    }
  });

});
