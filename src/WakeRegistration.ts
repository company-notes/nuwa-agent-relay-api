import type { Env } from './Env';
import { APIError } from './HTTP';
export type WakeWorkScope = { work: { id: string }; organization: { id: string } };
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
};

export class WakeRegistration {
  private static readonly logger = Logger.forModule('wake.registration');
  constructor(
    private readonly env: Env,
    private readonly identity: WakeWorkScope,
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
        (work_address_id, org_id, verification_id, callback_url, auth_mode,
         encrypted_target, verification_digest, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_address_id) DO UPDATE SET
         org_id = excluded.org_id,
         verification_id = excluded.verification_id,
         callback_url = excluded.callback_url,
         auth_mode = excluded.auth_mode,
         encrypted_target = excluded.encrypted_target,
         verification_digest = excluded.verification_digest,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         failures = 0
       WHERE wake_registration_attempts.created_at < ?`,
    ).bind(this.identity.work.id, this.identity.organization.id, verificationId,
      publicURL, authMode, encryptedTarget, digest, expiresAt, createdAt, cooldown).run();

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
        workAddressId: this.identity.work.id,
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
      workAddressId: this.identity.work.id,
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
         WHERE work_address_id = ? AND org_id = ?`,
    ).bind(this.identity.work.id, this.identity.organization.id).first<{
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
    const row = await this.env.DB.prepare(
      `SELECT verification_id AS verificationId,
              verification_digest AS verificationDigest,
              encrypted_target AS encryptedTarget,
              callback_url AS publicURL, auth_mode AS authMode,
              expires_at AS expiresAt, created_at AS createdAt,
              failures
         FROM wake_registration_attempts
        WHERE work_address_id = ? AND org_id = ?`,
    ).bind(this.identity.work.id, this.identity.organization.id).first<PendingRegistration>();

    if (!row || row.verificationId !== verificationId ||
      row.expiresAt <= new Date().toISOString()) {
      throw new APIError(409, 'wake_verification_not_pending',
        'No matching unexpired Wake verification is pending for this Work.');
    }

    if (row.failures >= 5) {
      throw new APIError(429, 'wake_verification_locked',
        'Too many failed Wake verification attempts. Register again after cooldown.');
    }

    const actual = await WakeRegistration.digest(verificationId + ':' + challenge);

    if (!WakeRegistration.matches(actual, row.verificationDigest)) {
      await this.env.DB.prepare(
        `UPDATE wake_registration_attempts SET failures = failures + 1
          WHERE work_address_id = ? AND org_id = ? AND verification_id = ?`,
      ).bind(this.identity.work.id, this.identity.organization.id, verificationId).run();

      throw new APIError(403, 'wake_verification_invalid', 'Invalid Wake verification response.');
    }

    // Atomic D1 batch: activate the exact current attempt and remove it.
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO wake_subscriptions
           (work_address_id, org_id, callback_url, signing_secret, created_at,
            encrypted_target, auth_mode)
         SELECT work_address_id, org_id, callback_url, '', ?, encrypted_target, auth_mode
           FROM wake_registration_attempts
          WHERE work_address_id = ? AND org_id = ? AND verification_id = ?
            AND expires_at > ? AND failures < 5
         ON CONFLICT(work_address_id) DO UPDATE SET
           org_id = excluded.org_id,
           callback_url = excluded.callback_url,
           signing_secret = excluded.signing_secret,
           created_at = excluded.created_at,
           encrypted_target = excluded.encrypted_target,
           auth_mode = excluded.auth_mode`,
      ).bind(new Date().toISOString(), this.identity.work.id, this.identity.organization.id,
        verificationId, new Date().toISOString()),
      this.env.DB.prepare(
        `DELETE FROM wake_registration_attempts
          WHERE work_address_id = ? AND org_id = ? AND verification_id = ?`,
      ).bind(this.identity.work.id, this.identity.organization.id, verificationId),
    ]);

    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new APIError(409, 'wake_verification_stale',
        'Wake verification was replaced or expired.');
    }

    return {
      status: 'active',
      enabled: true,
      workAddressId: this.identity.work.id,
      callbackHost: new URL(row.publicURL).hostname,
      authMode: row.authMode,
    };
  }
}
