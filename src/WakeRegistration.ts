import type { Env } from './Env';
import { GatewayRoster } from './GatewayRoster';
import { APIError } from './HTTP';
import { OfficeWakeScope, type WakeScope } from './OfficeWakeScope';
import { WakeTarget, type WakeAuthMode } from './WakeTarget';
import { Logger } from './Logger';

type PendingRegistration = {
  verificationId: string;
  verificationDigest: string;
  encryptedTarget: string;
  publicURL: string;
  authMode: WakeAuthMode;
  expiresAt: string;
  createdAt: string;
  failures: number;
  officeGatewaySessionID: string | null;
  officeApprovedAt: string | null;
};

export class WakeRegistration {
  private static readonly logger = Logger.forModule('wake.registration');
  constructor(
    private readonly env: Env,
    private readonly identity: WakeScope,
  ) {}

  private static hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private static async digest(text: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return this.hex(new Uint8Array(bytes));
  }

  private static matches(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }

    let difference = 0;

    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }

    return difference === 0;
  }

  /** A pending challenge never disables the previously verified subscription. */
  async begin(callbackURL: string, authMode: WakeAuthMode, bearerToken?: string) {
    if (this.identity.office) {
      await OfficeWakeScope.requireCurrent(this.env, this.identity);
    } else {
      await GatewayRoster.requireIndependentRoute(
        this.env, this.identity.organizationID, this.identity.sessionID,
      );
    }

    const config = WakeTarget.validateConfig(callbackURL, authMode, bearerToken);
    const encryptedTarget = await WakeTarget.encrypt(this.env, config);
    const publicURL = WakeTarget.publicURL(callbackURL);
    const now = new Date();
    const createdAt = now.toISOString();
    const cooldown = new Date(now.getTime() - 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const verificationId = crypto.randomUUID();
    const challenge = WakeRegistration.hex(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await WakeRegistration.digest(verificationId + ':' + challenge);

    const updated = await this.env.DB.prepare(
      `INSERT INTO wake_registration_attempts
        (session_id, org_id, verification_id, callback_url, auth_mode,
         encrypted_target, verification_digest, expires_at, created_at,
         office_gateway_session_id, office_approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         org_id = excluded.org_id,
         verification_id = excluded.verification_id,
         callback_url = excluded.callback_url,
         auth_mode = excluded.auth_mode,
         encrypted_target = excluded.encrypted_target,
         verification_digest = excluded.verification_digest,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         failures = 0,
         office_gateway_session_id = excluded.office_gateway_session_id,
         office_approved_at = excluded.office_approved_at
       WHERE wake_registration_attempts.created_at < ?`,
    ).bind(this.identity.sessionID, this.identity.organizationID, verificationId,
      publicURL, authMode, encryptedTarget, digest, expiresAt, createdAt,
      this.identity.office?.gatewaySessionID ?? null, this.identity.office?.approvedAt ?? null, cooldown).run();

    if (updated.meta.changes !== 1) {
      throw new APIError(429, 'wake_registration_cooldown',
        'Wait 60 seconds before sending another Wake verification challenge.');
    }

    let challengeDelivered = false;

    try {
      challengeDelivered = await WakeTarget.send(config, {
        event: 'nuwa.wake.verification',
        verificationId,
        challenge,
        sessionID: this.identity.sessionID,
      });
      if (!challengeDelivered) {
        WakeRegistration.logger.warning('challenge_http_rejected', { verificationId });
      }
    } catch (error) {
      // Keep the registration pending, but never suppress its delivery failure.
      WakeRegistration.logger.exception('challenge_delivery_failed', error, { verificationId });
    }

    return {
      status: 'pending_verification',
      sessionID: this.identity.sessionID,
      callbackHost: new URL(publicURL).hostname,
      authMode,
      verificationId,
      expiresAt,
      challengeDelivered,
      ...(authMode === 'hmac' ? { signingSecret: config.signingSecret } : {}),
    };
  }

  async pending() {
    const result = await this.env.DB.prepare(
      `SELECT verification_id AS verificationId, callback_url AS callbackURL,
              auth_mode AS authMode, expires_at AS expiresAt,
              failures FROM wake_registration_attempts
         WHERE session_id = ? AND org_id = ?`,
    ).bind(this.identity.sessionID, this.identity.organizationID).first<{
      verificationId: string; callbackURL: string; authMode: WakeAuthMode;
      expiresAt: string; failures: number;
    }>();

    if (!result) {
      return null;
    }

    return {
      verificationId: result.verificationId,
      callbackHost: new URL(result.callbackURL).hostname,
      authMode: result.authMode,
      expiresAt: result.expiresAt,
      expired: result.expiresAt <= new Date().toISOString(),
    };
  }

  async verify(verificationId: string, challenge: string) {
    if (this.identity.office) {
      await OfficeWakeScope.requireCurrent(this.env, this.identity);
    } else {
      await GatewayRoster.requireIndependentRoute(
        this.env, this.identity.organizationID, this.identity.sessionID,
      );
    }

    const row = await this.env.DB.prepare(
      `SELECT verification_id AS verificationId,
              verification_digest AS verificationDigest,
              encrypted_target AS encryptedTarget,
              callback_url AS publicURL, auth_mode AS authMode,
              expires_at AS expiresAt, created_at AS createdAt,
              failures, office_gateway_session_id AS officeGatewaySessionID,
              office_approved_at AS officeApprovedAt
         FROM wake_registration_attempts
        WHERE session_id = ? AND org_id = ?`,
    ).bind(this.identity.sessionID, this.identity.organizationID).first<PendingRegistration>();

    if (!row || row.verificationId !== verificationId ||
      row.expiresAt <= new Date().toISOString()) {
      throw new APIError(409, 'wake_verification_not_pending',
        'No matching unexpired Wake verification is pending for this Session.');
    }

    if (row.officeGatewaySessionID !== (this.identity.office?.gatewaySessionID ?? null) ||
        row.officeApprovedAt !== (this.identity.office?.approvedAt ?? null)) {
      throw new APIError(409, 'wake_verification_not_pending',
        'No matching Wake verification is pending for this authority.');
    }

    if (row.failures >= 5) {
      throw new APIError(429, 'wake_verification_locked',
        'Too many failed Wake verification attempts. Register again after cooldown.');
    }

    const actual = await WakeRegistration.digest(verificationId + ':' + challenge);

    if (!WakeRegistration.matches(actual, row.verificationDigest)) {
      await this.env.DB.prepare(
        `UPDATE wake_registration_attempts SET failures = failures + 1
          WHERE session_id = ? AND org_id = ? AND verification_id = ?`,
      ).bind(this.identity.sessionID, this.identity.organizationID, verificationId).run();

      throw new APIError(403, 'wake_verification_invalid', 'Invalid Wake verification response.');
    }

    // Atomic D1 batch: activate the exact current attempt and remove it.
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO wake_subscriptions
           (session_id, org_id, callback_url, signing_secret, created_at,
            encrypted_target, auth_mode)
         SELECT session_id, org_id, callback_url, '', ?, encrypted_target, auth_mode
           FROM wake_registration_attempts
          WHERE session_id = ? AND org_id = ? AND verification_id = ?
            AND expires_at > ? AND failures < 5
            AND office_gateway_session_id IS ? AND office_approved_at IS ?
            AND ((office_gateway_session_id IS NOT NULL AND ${OfficeWakeScope.currentAttempt})
              OR (office_gateway_session_id IS NULL AND NOT EXISTS (SELECT 1 FROM gateway_teammates t
                WHERE t.org_id = wake_registration_attempts.org_id
                  AND t.recipient_session_id = wake_registration_attempts.session_id
                  AND t.status = 'active')))
         ON CONFLICT(session_id) DO UPDATE SET
           org_id = excluded.org_id,
           callback_url = excluded.callback_url,
           signing_secret = excluded.signing_secret,
           created_at = excluded.created_at,
           encrypted_target = excluded.encrypted_target,
           auth_mode = excluded.auth_mode`,
      ).bind(new Date().toISOString(), this.identity.sessionID, this.identity.organizationID,
        verificationId, new Date().toISOString(),
        this.identity.office?.gatewaySessionID ?? null, this.identity.office?.approvedAt ?? null),
      this.env.DB.prepare(
        `DELETE FROM wake_registration_attempts
          WHERE session_id = ? AND org_id = ? AND verification_id = ?`,
      ).bind(this.identity.sessionID, this.identity.organizationID, verificationId),
    ]);

    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new APIError(409, 'wake_verification_stale',
        'Wake verification was replaced or expired.');
    }

    return {
      status: 'active',
      enabled: true,
      sessionID: this.identity.sessionID,
      callbackHost: new URL(row.publicURL).hostname,
      authMode: row.authMode,
    };
  }
}
