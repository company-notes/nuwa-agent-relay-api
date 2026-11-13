import type { Env } from './Env';
import { GatewayBindings } from './GatewayBindings';
import { GatewayRoster } from './GatewayRoster';
import { APIError, HTTP } from './HTTP';
import type { SessionIdentity } from './SessionIdentityClient';
import { WakeRegistration } from './WakeRegistration';
import { WakeTarget, type WakeAuthMode } from './WakeTarget';
import { Logger } from './Logger';

type WakeRow = {
  messageId: string;
  sessionID: string;
  gatewaySessionID: string | null;
  organizationID: string;
  threadID: string;
  senderSessionID: string;
  senderCanonicalAddress: string;
  recipientAgentID: string;
  recipientSessionID: string | null;
  body: string;
  callbackURL: string;
  signingSecret: string;
  encryptedTarget: string | null;
  attempts: number;
};

export class WakeService {
  private static readonly logger = Logger.forModule('wake.dispatch');

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
  ) {}

  async subscribe(callbackURL: string, authMode: WakeAuthMode = 'hmac', bearerToken?: string) {
    return new WakeRegistration(this.env, this.identity).begin(callbackURL, authMode, bearerToken);
  }

  async verify(verificationId: string, challenge: string) {
    return new WakeRegistration(this.env, this.identity).verify(verificationId, challenge);
  }

  async getSubscription(): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      'SELECT callback_url AS callbackURL, auth_mode AS authMode FROM wake_subscriptions WHERE session_id = ? AND org_id = ?',
    ).bind(this.identity.sessionID, this.identity.organizationID)
      .first<{ callbackURL: string; authMode: string }>();

    const shared = await this.env.DB.prepare(
      `SELECT g.gateway_session_id AS gatewaySessionID,
              s.callback_url AS callbackURL, s.auth_mode AS authMode
         FROM gateway_teammates g
         JOIN wake_subscriptions s ON s.session_id = g.gateway_session_id AND s.org_id = g.org_id
        WHERE g.org_id = ? AND g.recipient_session_id = ? AND g.status = 'active'`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first<{
      gatewaySessionID: string; callbackURL: string; authMode: string;
    }>();

    const pending = await new WakeRegistration(this.env, this.identity).pending();
    const callback = row ?? shared;

    return {
      sessionID: this.identity.sessionID,
      enabled: Boolean(callback),
      receiverMode: shared ? 'gateway' : row ? 'direct' : 'none',
      gatewaySessionID: shared?.gatewaySessionID ?? null,
      callbackHost: callback ? new URL(callback.callbackURL).hostname : null,
      authMode: callback?.authMode ?? null,
      pending,
    };
  }

  async unsubscribe(): Promise<Record<string, unknown>> {
    await GatewayRoster.requireUnreferencedGateway(
      this.env, this.identity.organizationID, this.identity.sessionID,
    );

    await this.env.DB.prepare(
      'DELETE FROM wake_subscriptions WHERE session_id = ? AND org_id = ?',
    ).bind(this.identity.sessionID, this.identity.organizationID).run();

    await this.env.DB.prepare(
      'DELETE FROM wake_registration_attempts WHERE session_id = ? AND org_id = ?',
    ).bind(this.identity.sessionID, this.identity.organizationID).run();

    // Unsubscribe also removes retry jobs to avoid contacting the old endpoint.
    await this.env.DB.prepare(
      "DELETE FROM wake_events WHERE session_id = ? AND status = 'pending'",
    ).bind(this.identity.sessionID).run();

    return { removed: true };
  }

  async deliveries(): Promise<Record<string, unknown>[]> {
    const result = await this.env.DB.prepare(
      `SELECT message_id AS messageId, attempts, status, notified_at AS notifiedAt,
              last_error AS lastError
         FROM wake_events
        WHERE session_id = ?
        ORDER BY next_attempt_at DESC LIMIT 100`,
    ).bind(this.identity.sessionID).all();

    return result.results as Record<string, unknown>[];
  }

  static async dispatchDue(env: Env): Promise<void> {
    const now = new Date().toISOString();
    const rows = await env.DB.prepare(
      `SELECT e.message_id AS messageId, e.session_id AS sessionID,
              g.gateway_session_id AS gatewaySessionID,
              e.attempts, s.callback_url AS callbackURL, s.signing_secret AS signingSecret,
              s.encrypted_target AS encryptedTarget,
              t.org_id AS organizationID, m.thread_id AS threadID,
              m.sender_session_id AS senderSessionID,
              m.sender_canonical_address AS senderCanonicalAddress,
              m.recipient_agent_id AS recipientAgentID,
              m.recipient_session_id AS recipientSessionID, m.body
         FROM wake_events e
         JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
         LEFT JOIN gateway_teammates g
           ON g.org_id = t.org_id AND g.recipient_session_id = e.session_id
          AND g.status = 'active'
         JOIN wake_subscriptions s
           ON s.org_id = t.org_id AND s.session_id = COALESCE(g.gateway_session_id, e.session_id)
        WHERE e.status = 'pending' AND e.next_attempt_at <= ?
          AND m.received_at IS NOT NULL
          AND (e.lease_until IS NULL OR e.lease_until <= ?)
        ORDER BY e.next_attempt_at LIMIT 25`,
    ).bind(now, now).all<WakeRow>();

    for (const event of rows.results) {
      // Webhook waitUntil and Cron may both run: atomically lease each event.
      const leaseOwner = crypto.randomUUID();
      const leaseUntil = new Date(Date.now() + 30_000).toISOString();
      const claimed = await env.DB.prepare(
        `UPDATE wake_events SET lease_owner = ?, lease_until = ?
          WHERE message_id = ? AND status = 'pending' AND next_attempt_at <= ?
            AND (lease_until IS NULL OR lease_until <= ?)`,
      ).bind(leaseOwner, leaseUntil, event.messageId, now, now).run();

      if (claimed.meta.changes !== 1) {
        continue;
      }

      let success = false;
      let reason = 'network_error';

      try {
        const body = await GatewayBindings.dispatch(env, {
          id: event.messageId,
          threadID: event.threadID,
          senderSessionID: event.senderSessionID,
          senderCanonicalAddress: event.senderCanonicalAddress,
          recipientAgentID: event.recipientAgentID,
          recipientSessionID: event.recipientSessionID,
          recipientWakeSessionID: event.gatewaySessionID ?? event.sessionID,
          organizationID: event.organizationID,
          body: event.body,
        });

        const config = event.encryptedTarget
          ? await WakeTarget.decrypt(env, event.encryptedTarget)
          : {
            callbackURL: event.callbackURL,
            authMode: 'hmac' as const,
            signingSecret: event.signingSecret,
          };

        success = await WakeTarget.send(config, body);
        reason = success ? '' : 'http_rejected';
        if (!success) {
          WakeService.logger.warning('callback_http_rejected', {
            messageId: event.messageId,
            attempt: event.attempts + 1,
          });
        }
      } catch (error) {
        reason = error instanceof APIError ? error.code : 'network_error';
        WakeService.logger.exception('callback_delivery_failed', error, {
          messageId: event.messageId,
          attempt: event.attempts + 1,
        });
      }

      if (reason === 'gateway_first_contact_pending') {
        // First contact is waiting for a recipient-authorized native Thread
        // confirmation. This is not an external delivery failure and must not
        // exhaust the normal six-attempt Wake retry budget.
        await env.DB.prepare(
          `UPDATE wake_events
              SET next_attempt_at = ?, last_error = ?,
                  lease_owner = NULL, lease_until = NULL
            WHERE message_id = ? AND status = 'pending' AND lease_owner = ?`,
        ).bind(new Date(Date.now() + 30_000).toISOString(), reason,
          event.messageId, leaseOwner).run();

        continue;
      }

      const attempts = event.attempts + 1;
      const state = success ? 'delivered' : attempts >= 6 ? 'failed' : 'pending';
      const backoff = Math.min(60, 2 ** attempts);
      const due = new Date(Date.now() + backoff * 60_000).toISOString();

      await env.DB.prepare(
        `UPDATE wake_events
            SET attempts = ?, status = ?, next_attempt_at = ?,
                notified_at = ?, last_error = ?,
                lease_owner = NULL, lease_until = NULL
          WHERE message_id = ? AND status = 'pending' AND lease_owner = ?`,
      ).bind(
        attempts,
        state,
        due,
        success ? new Date().toISOString() : null,
        success ? null : reason,
        event.messageId,
        leaseOwner,
      ).run();
    }
  }
}
