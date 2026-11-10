import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';
import type { IdentityContext } from './IdentityContext';
import { WakeRegistration } from './WakeRegistration';
import { WakeTarget, type WakeAuthMode } from './WakeTarget';

type WakeRow = {
  messageId: string;
  workAddressId: string;
  callbackUrl: string;
  signingSecret: string;
  encryptedTarget: string | null;
  attempts: number;
};

export class WakeService {

  constructor(
    private readonly env: Env,
    private readonly identity: IdentityContext,
  ) {}

  async subscribe(callbackURL: string, authMode: WakeAuthMode = 'hmac', bearerToken?: string) {
    return new WakeRegistration(this.env, this.identity).begin(callbackURL, authMode, bearerToken);
  }

  async verify(verificationId: string, challenge: string) {
    return new WakeRegistration(this.env, this.identity).verify(verificationId, challenge);
  }

  async getSubscription(): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      'SELECT callback_url AS callbackURL, auth_mode AS authMode FROM wake_subscriptions WHERE work_address_id = ? AND org_id = ?',
    ).bind(this.identity.work.id, this.identity.organization.id)
      .first<{ callbackURL: string; authMode: string }>();

    const pending = await new WakeRegistration(this.env, this.identity).pending();

    return {
      workAddressId: this.identity.work.id,
      enabled: Boolean(row),
      callbackHost: row ? new URL(row.callbackURL).hostname : null,
      authMode: row?.authMode ?? null,
      pending,
    };
  }

  async unsubscribe(): Promise<Record<string, unknown>> {
    await this.env.DB.prepare(
      'DELETE FROM wake_subscriptions WHERE work_address_id = ? AND org_id = ?',
    ).bind(this.identity.work.id, this.identity.organization.id).run();

    await this.env.DB.prepare(
      'DELETE FROM wake_registration_attempts WHERE work_address_id = ? AND org_id = ?',
    ).bind(this.identity.work.id, this.identity.organization.id).run();

    // Unsubscribe also removes retry jobs to avoid contacting the old endpoint.
    await this.env.DB.prepare(
      "DELETE FROM wake_events WHERE work_address_id = ? AND status = 'pending'",
    ).bind(this.identity.work.id).run();

    return { removed: true };
  }

  async deliveries(): Promise<Record<string, unknown>[]> {
    const result = await this.env.DB.prepare(
      `SELECT message_id AS messageId, attempts, status, notified_at AS notifiedAt,
              last_error AS lastError
         FROM wake_events
        WHERE work_address_id = ?
        ORDER BY next_attempt_at DESC LIMIT 100`,
    ).bind(this.identity.work.id).all();

    return result.results as Record<string, unknown>[];
  }

  static async dispatchDue(env: Env): Promise<void> {
    const now = new Date().toISOString();
    const rows = await env.DB.prepare(
      `SELECT e.message_id AS messageId, e.work_address_id AS workAddressId,
              e.attempts, s.callback_url AS callbackUrl, s.signing_secret AS signingSecret, s.encrypted_target AS encryptedTarget
         FROM wake_events e
         JOIN wake_subscriptions s ON s.work_address_id = e.work_address_id
         JOIN messages m ON m.id = e.message_id
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

      const body = {
        event: 'nuwa.message.available',
        messageId: event.messageId,
        workAddressId: event.workAddressId,
      };

      let success = false;
      let reason = 'network_error';

      try {
        const config = event.encryptedTarget
          ? await WakeTarget.decrypt(env, event.encryptedTarget)
          : {
            callbackURL: event.callbackUrl,
            authMode: 'hmac' as const,
            signingSecret: event.signingSecret,
          };
        success = await WakeTarget.send(config, body);
        reason = success ? '' : 'http_rejected';
      } catch {
        // No target URLs or secrets in external responses or logs.
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
