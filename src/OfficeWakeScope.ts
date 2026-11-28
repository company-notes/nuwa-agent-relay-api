import type { Env } from './Env';
import { APIError } from './HTTP';
import { PlatformBotIdentity } from './PlatformBotIdentity';

export type OfficeWakeAuthority = {
  gatewaySessionID: string;
  approvedAt: string;
};

export type WakeScope = {
  organizationID: string;
  sessionID: string;
  office?: OfficeWakeAuthority;
};

type OfficeRecipient = {
  sessionID: string;
  canonicalAddress: string;
  approvedAt: string;
};

/** A verified office membership is the authority for targeted Wake management. */
export class OfficeWakeScope {
  private static readonly membership = `
    FROM gateway_teammates t
    JOIN gateway_office_coworkers c ON c.org_id = t.org_id
      AND c.gateway_session_id = t.gateway_session_id
      AND c.recipient_session_id = t.recipient_session_id
      AND c.recipient_bot_id = t.recipient_bot_id
    JOIN gateway_routes r ON r.org_id = t.org_id
      AND r.recipient_session_id = t.recipient_session_id
      AND r.recipient_bot_id = t.recipient_bot_id
    WHERE t.status = 'active' AND t.approved_at IS NOT NULL
      AND c.activated_at IS NOT NULL AND c.removed_at IS NULL
      AND c.identity_available = 1 AND r.thread_mode = 'platform'`;

  static async resolve(env: Env, gateway: WakeScope, botID: string): Promise<WakeScope> {
    PlatformBotIdentity.requireID(botID, 'recipientBotID');
    const rows = await env.DB.prepare(
      `SELECT t.recipient_session_id AS sessionID, t.approved_at AS approvedAt,
              t.recipient_canonical_address AS canonicalAddress ${this.membership}
        AND t.org_id = ? AND t.gateway_session_id = ? AND t.recipient_bot_id = ? LIMIT 2`,
    ).bind(gateway.organizationID, gateway.sessionID, botID).all<OfficeRecipient>();

    if (rows.results.length !== 1) {
      throw new APIError(404, 'office_wake_recipient_missing',
        'Select one active platform-mode coworker of this Gateway.');
    }

    const recipient = rows.results[0];

    return {
      organizationID: gateway.organizationID, sessionID: recipient.sessionID,
      office: { gatewaySessionID: gateway.sessionID, approvedAt: recipient.approvedAt },
    };
  }

  static async requireCurrent(env: Env, scope: WakeScope): Promise<OfficeRecipient> {
    if (!scope.office) {
      throw new APIError(403, 'office_wake_authority_required', 'Targeted Wake requires office authority.');
    }

    const recipient = await env.DB.prepare(
      `SELECT t.recipient_session_id AS sessionID, t.approved_at AS approvedAt,
              t.recipient_canonical_address AS canonicalAddress ${this.membership}
        AND t.org_id = ? AND t.gateway_session_id = ? AND t.recipient_session_id = ?
        AND t.approved_at = ?`,
    ).bind(scope.organizationID, scope.office.gatewaySessionID, scope.sessionID,
      scope.office.approvedAt).first<OfficeRecipient>();

    if (!recipient) {
      throw new APIError(409, 'office_wake_membership_changed',
        'The authorized coworker membership changed. Start a new pairing.');
    }

    return recipient;
  }

  static readonly currentAttempt = `
    EXISTS (SELECT 1 ${OfficeWakeScope.membership}
      AND t.org_id = wake_registration_attempts.org_id
      AND t.recipient_session_id = wake_registration_attempts.session_id
      AND t.gateway_session_id = wake_registration_attempts.office_gateway_session_id
      AND t.approved_at = wake_registration_attempts.office_approved_at)`;
}
