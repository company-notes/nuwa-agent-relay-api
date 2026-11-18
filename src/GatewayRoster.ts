import type { Env } from './Env';
import { GatewayFirstContactMode, GatewayModeCodec, GatewayThreadMode } from './GatewayModeCodec';
import { APIError } from './HTTP';
import { PlatformBotIdentity } from './PlatformBotIdentity';
import { OfficeConnectionService } from './OfficeConnectionService';
import { RecipientDirectory } from './RecipientDirectory';
import { SessionIdentityClient, type SessionIdentity } from './SessionIdentityClient';

enum GatewayTeammateStatus {
  Pending = 1,
  Active = 2,
}

type TeammateRow = {
  gatewaySessionID: string;
  recipientSessionID: string;
  recipientAgentID: string;
  recipientCanonicalAddress: string;
  recipientBotID: string;
  threadMode: string;
  firstContactMode: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
};

/**
 * An office Gateway proposes recipients, but only the recipient Runtime can
 * approve routing its own messages through that Gateway's verified callback.
 * The proposal never grants the Gateway a recipient Runtime/Resume capability.
 */
export class GatewayRoster {
  private static readonly columns = `gateway_session_id AS gatewaySessionID,
    recipient_session_id AS recipientSessionID, recipient_agent_id AS recipientAgentID,
    recipient_canonical_address AS recipientCanonicalAddress,
    recipient_bot_id AS recipientBotID, thread_mode AS threadMode,
    first_contact_mode AS firstContactMode, status, created_at AS createdAt,
    approved_at AS approvedAt`;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  private static status(row: TeammateRow): GatewayTeammateStatus {
    if (row.status === 'pending') {
      return GatewayTeammateStatus.Pending;
    }

    if (row.status === 'active') {
      return GatewayTeammateStatus.Active;
    }

    throw new APIError(500, 'gateway_roster_invalid', 'Stored Gateway teammate state is invalid.');
  }

  private static validateModes(threadMode: GatewayThreadMode, firstContactMode: GatewayFirstContactMode) {
    if (!Object.values(GatewayThreadMode).includes(threadMode) ||
        !Object.values(GatewayFirstContactMode).includes(firstContactMode) ||
        (threadMode === GatewayThreadMode.Platform &&
          firstContactMode !== GatewayFirstContactMode.Manual)) {
      throw new APIError(400, 'invalid_gateway_mode', 'Unsupported Gateway thread or first-contact mode.');
    }
  }

  private async teammate(recipientSessionID: string): Promise<TeammateRow | null> {
    return this.env.DB.prepare(
      `SELECT ${GatewayRoster.columns} FROM gateway_teammates
        WHERE org_id = ? AND recipient_session_id = ?`,
    ).bind(this.identity.organizationID, recipientSessionID).first<TeammateRow>();
  }

  private async verifiedGateway(sessionID: string): Promise<void> {
    const verified = await this.env.DB.prepare(
      'SELECT session_id FROM wake_subscriptions WHERE session_id = ? AND org_id = ?',
    ).bind(sessionID, this.identity.organizationID).first<{ session_id: string }>();

    if (!verified) {
      throw new APIError(409, 'gateway_wake_required',
        'The office Gateway must first verify its own Wake receiver.');
    }
  }

  async list(): Promise<TeammateRow[]> {
    const results = await this.env.DB.prepare(
      `SELECT ${GatewayRoster.columns} FROM gateway_teammates
        WHERE org_id = ? AND gateway_session_id = ?
        ORDER BY recipient_canonical_address`,
    ).bind(this.identity.organizationID, this.identity.sessionID).all<TeammateRow>();

    return results.results;
  }

  async invite(
    recipientTarget: { address?: string; name?: string }, recipientBotID: string,
    threadMode: GatewayThreadMode,
    firstContactMode: GatewayFirstContactMode = GatewayFirstContactMode.Manual,
  ) {
    PlatformBotIdentity.requireID(recipientBotID, 'recipientBotID');
    GatewayRoster.validateModes(threadMode, firstContactMode);
    await this.verifiedGateway(this.identity.sessionID);

    const recipient = recipientTarget.name
      ? await new RecipientDirectory(this.identity, this.address).resolve(recipientTarget.name)
      : await this.address.resolve(recipientTarget.address!);

    if (recipient.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(403, 'gateway_teammate_forbidden',
        'A Gateway can only propose recipients within its Organization.');
    }

    if (recipient.id === this.identity.sessionID) {
      throw new APIError(400, 'gateway_self_registration_forbidden',
        'The office Gateway must not register itself as its own coworker.');
    }

    if (await this.teammate(recipient.id)) {
      throw new APIError(409, 'gateway_teammate_exists',
        'This recipient already has a Gateway invitation or approved route.');
    }

    await this.env.DB.prepare(
      `INSERT INTO gateway_teammates
         (org_id, gateway_session_id, recipient_session_id, recipient_agent_id,
          recipient_canonical_address, recipient_bot_id, thread_mode,
          first_contact_mode, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      this.identity.organizationID, this.identity.sessionID, recipient.id,
      recipient.agentId, recipient.canonical, recipientBotID,
      GatewayModeCodec.writeThreadMode(threadMode),
      GatewayModeCodec.writeFirstContactMode(firstContactMode),
      new Date().toISOString(),
    ).run();

    return {
      gatewaySessionID: this.identity.sessionID,
      recipientSessionID: recipient.id,
      recipientCanonicalAddress: recipient.canonical,
      recipientBotID,
      status: 'pending',
    };
  }

  async invitation() {
    return this.teammate(this.identity.sessionID);
  }

  private async approveReceivingRoute(): Promise<void> {
    const existing = await this.env.DB.prepare(
      'SELECT recipient_session_id FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?',
    ).bind(this.identity.organizationID, this.identity.sessionID)
      .first<{ recipient_session_id: string }>();

    const direct = await this.env.DB.prepare(
      'SELECT session_id FROM wake_subscriptions WHERE org_id = ? AND session_id = ?',
    ).bind(this.identity.organizationID, this.identity.sessionID)
      .first<{ session_id: string }>();

    if (existing || direct) {
      throw new APIError(409, 'gateway_recipient_already_configured',
        'Remove the recipient direct route or Wake before approving shared routing.');
    }

    const now = new Date().toISOString();
    const [activation, route] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE gateway_teammates SET status = 'active', approved_at = ?
         WHERE org_id = ? AND recipient_session_id = ? AND status = 'pending'`,
      ).bind(now, this.identity.organizationID, this.identity.sessionID),
      this.env.DB.prepare(
        `INSERT INTO gateway_routes
           (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
            recipient_bot_id, thread_mode, first_contact_mode, created_at)
         SELECT org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
                recipient_bot_id, thread_mode, first_contact_mode, ?
           FROM gateway_teammates
           WHERE org_id = ? AND recipient_session_id = ? AND status = 'active'`,
      ).bind(now, this.identity.organizationID, this.identity.sessionID),
    ]);

    if (activation.meta.changes !== 1 || route.meta.changes !== 1) {
      throw new APIError(409, 'gateway_invitation_conflict',
        'Gateway teammate approval did not activate exactly one recipient route.');
    }
  }

  async approve(shareConnection = false) {
    const teammate = await this.teammate(this.identity.sessionID);

    if (!teammate || GatewayRoster.status(teammate) !== GatewayTeammateStatus.Pending) {
      throw new APIError(404, 'gateway_invitation_missing',
        'This recipient has no pending Gateway invitation.');
    }

    if (teammate.recipientAgentID !== this.identity.agentID ||
        teammate.recipientCanonicalAddress !== this.identity.canonicalAddress) {
      throw new APIError(409, 'gateway_recipient_changed',
        'Recipient identity changed since the invitation was created.');
    }

    await this.verifiedGateway(teammate.gatewaySessionID);

    if (shareConnection) {
      await new OfficeConnectionService(this.env, this.identity).joinShared(teammate);
    } else {
      await this.approveReceivingRoute();
    }

    return {
      recipientSessionID: this.identity.sessionID,
      gatewaySessionID: teammate.gatewaySessionID,
      recipientBotID: teammate.recipientBotID,
      status: 'active',
    };
  }

  private async revoke(recipientSessionID: string, gatewayOwned: boolean) {
    const row = await this.teammate(recipientSessionID);

    if (!row || (gatewayOwned && row.gatewaySessionID !== this.identity.sessionID)) {
      throw new APIError(404, 'gateway_teammate_missing',
        'Gateway teammate is not registered for this Session.');
    }

    if (GatewayRoster.status(row) === GatewayTeammateStatus.Pending) {
      const deleted = await this.env.DB.prepare(
        `DELETE FROM gateway_teammates WHERE org_id = ? AND recipient_session_id = ?
           AND gateway_session_id = ? AND status = 'pending'`,
      ).bind(this.identity.organizationID, recipientSessionID, row.gatewaySessionID).run();

      if (deleted.meta.changes !== 1) {
        throw new APIError(409, 'gateway_invitation_conflict',
          'The pending invitation changed before it could be withdrawn.');
      }

      return { removed: true, recipientSessionID };
    }

    await new OfficeConnectionService(this.env, this.identity).leaveShared(row, gatewayOwned);

    return { removed: true, recipientSessionID };
  }

  async removeTeammate(recipientTarget: { address?: string; name?: string; botID?: string }) {
    if (recipientTarget.botID !== undefined) {
      PlatformBotIdentity.requireID(recipientTarget.botID, 'recipientBotID');
      const { results } = await this.env.DB.prepare(
        `SELECT recipient_session_id AS sessionID FROM gateway_teammates
          WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ? LIMIT 2`,
      ).bind(this.identity.organizationID, this.identity.sessionID, recipientTarget.botID)
        .all<{ sessionID: string }>();

      if (results.length !== 1) {
        throw new APIError(results.length ? 409 : 404, 'gateway_teammate_missing',
          'The Bot ID must identify one coworker of this Gateway.');
      }

      return this.revoke(results[0].sessionID, true);
    }

    // Destructive operations must consult current authoritative names, not a
    // short-lived snapshot that may still contain a previous display name.
    const recipient = recipientTarget.name
      ? await new RecipientDirectory(this.identity, this.address).resolve(
        recipientTarget.name, { requireFresh: true })
      : await this.address.resolve(recipientTarget.address!);

    if (recipient.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(403, 'gateway_teammate_forbidden',
        'A Gateway can only remove recipients within its Organization.');
    }

    return this.revoke(recipient.id, true);
  }

  async leave() {
    return this.revoke(this.identity.sessionID, false);
  }

  /** Prevents silent replacement of an approved recipient route by a direct one. */
  static async requireIndependentRoute(env: Env, organizationID: string, sessionID: string) {
    const result = await env.DB.prepare(
      `SELECT recipient_session_id FROM gateway_teammates
       WHERE org_id = ? AND recipient_session_id = ? AND status = 'active'`,
    ).bind(organizationID, sessionID).first();

    if (result) {
      throw new APIError(409, 'gateway_shared_route_active',
        'Revoke the shared Gateway teammate binding before changing its route.');
    }
  }

  /** Do not let an office Gateway disable the callback while coworkers rely on it. */
  static async requireUnreferencedGateway(env: Env, organizationID: string, sessionID: string) {
    const reference = await env.DB.prepare(
      `SELECT recipient_session_id FROM gateway_teammates
       WHERE org_id = ? AND gateway_session_id = ? AND status = 'active' LIMIT 1`,
    ).bind(organizationID, sessionID).first();

    if (reference) {
      throw new APIError(409, 'gateway_in_use',
        'Remove approved coworkers before disabling their shared Gateway callback.');
    }
  }
}
