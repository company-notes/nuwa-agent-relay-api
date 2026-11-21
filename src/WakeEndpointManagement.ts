import type { Env } from './Env';
import { GatewayRoster } from './GatewayRoster';
import { APIError } from './HTTP';
import { WakeTarget, type WakeAuthMode, type WakeTargetConfig } from './WakeTarget';

type WakeSubscription = {
  callbackURL: string;
  authMode: WakeAuthMode;
  encryptedTarget: string | null;
  signingSecret: string;
};

/**
 * Account-owned Wake endpoint relocation. The identity proof is performed by
 * Agent Address before constructing this service; Runtime capabilities are not
 * used for Portal administration.
 */
export class WakeEndpointManagement {
  constructor(
    private readonly env: Env,
    private readonly organizationID: string,
    private readonly sessionID: string,
  ) {}

  private async subscription(): Promise<WakeSubscription> {
    const row = await this.env.DB.prepare(
      `SELECT callback_url AS callbackURL, auth_mode AS authMode,
              encrypted_target AS encryptedTarget, signing_secret AS signingSecret
         FROM wake_subscriptions WHERE org_id = ? AND session_id = ?`,
    ).bind(this.organizationID, this.sessionID).first<WakeSubscription>();

    if (!row) {
      throw new APIError(404, 'wake_subscription_not_found',
        'The selected Session has no active Wake receiver.');
    }

    return row;
  }

  private view(row: Pick<WakeSubscription, 'callbackURL' | 'authMode'>) {
    return {
      sessionID: this.sessionID,
      enabled: true,
      callbackHost: WakeTarget.validateURL(row.callbackURL).hostname,
      authMode: row.authMode,
    };
  }

  async get() {
    return this.view(await this.subscription());
  }

  async changeURL(callbackURL: string) {
    // Shared-office coworkers receive through their authorized Gateway.
    await GatewayRoster.requireIndependentRoute(
      this.env, this.organizationID, this.sessionID,
    );

    const current = await this.subscription();
    const encrypted = current.encryptedTarget
      ? await WakeTarget.decrypt(this.env, current.encryptedTarget) : null;
    const target = WakeTarget.validateURL(callbackURL);

    // Tunnel host rotation normally keeps the platform's private /hooks path.
    // A full URL with its own path remains an explicit path replacement.
    const previous = encrypted?.callbackURL ?? current.callbackURL;
    if (target.pathname === '/' && previous) {
      target.pathname = WakeTarget.validateURL(previous).pathname;
    }

    const nextURL = target.toString();

    if (!encrypted && current.authMode !== 'hmac') {
      throw new APIError(409, 'wake_target_invalid',
        'This receiver needs secure credential recovery before changing its URL.');
    }

    if (encrypted && encrypted.authMode !== current.authMode) {
      throw new APIError(409, 'wake_target_invalid',
        'Stored Wake auth mode does not match its encrypted credentials.');
    }

    // Preserve the exact verified bearer token and signing secret. Do not
    // create a new challenge or change the Session's native conversation state.
    const nextTarget: WakeTargetConfig | null = encrypted
      ? { ...encrypted, callbackURL: nextURL } : null;
    const nextEncrypted = nextTarget
      ? await WakeTarget.encrypt(this.env, nextTarget) : null;

    const updated = await this.env.DB.prepare(
      `UPDATE wake_subscriptions
          SET callback_url = ?, encrypted_target = ?
        WHERE org_id = ? AND session_id = ?
          AND callback_url = ? AND encrypted_target IS ? AND auth_mode = ?`,
    ).bind(WakeTarget.publicURL(nextURL), nextEncrypted,
      this.organizationID, this.sessionID, current.callbackURL,
      current.encryptedTarget, current.authMode).run();

    if (updated.meta.changes !== 1) {
      throw new APIError(409, 'wake_endpoint_changed',
        'Wake receiver changed during editing. Refresh the Session before retrying.');
    }

    return this.view({ callbackURL: nextURL, authMode: current.authMode });
  }
}
