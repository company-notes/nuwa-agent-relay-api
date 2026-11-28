import { AgentMailboxService } from './AgentMailboxService';
import type { Env } from './Env';
import { GatewayFirstContactMode, GatewayModeCodec, GatewayThreadMode } from './GatewayModeCodec';
import { APIError } from './HTTP';
import { Logger } from './Logger';
import { OfficeCoworkerRegistry, type OfficeReceivingState } from './OfficeCoworkerRegistry';
import { OfficeAddressProjection, type OfficeIdentitySnapshot } from './OfficeAddressProjection';
import { PlatformBotIdentity } from './PlatformBotIdentity';
import { SessionIdentityClient, type ResolvedSession, type SessionIdentity } from './SessionIdentityClient';

export type OfficeCoworker = {
  displayName: string;
  recipientBotID: string;
  threadMode: GatewayThreadMode;
  firstContactMode: GatewayFirstContactMode;
  rejoinRemoved?: boolean;
};

type Reservation = OfficeReceivingState & {
  registrationID: string;
  displayName: string;
  recipientAgentID: string | null;
  recipientSessionID: string | null;
  recipientCanonicalAddress: string | null;
  activatedAt: string | null;
  removedAt: string | null;
};

/** Registers office-owned addresses and routes under one authorized Gateway. */
export class OfficeGatewayEnrollment {
  private static readonly logger = Logger.forModule('office.enrollment');
  private static readonly MAX_CONCURRENT_ENROLLMENTS = 4;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
    private readonly mailboxes = new AgentMailboxService(env),
  ) {}

  private async requireVerifiedWake(): Promise<void> {
    const wake = await this.env.DB.prepare(
      'SELECT session_id FROM wake_subscriptions WHERE org_id = ? AND session_id = ?',
    ).bind(this.identity.organizationID, this.identity.sessionID).first();

    if (!wake) {
      throw new APIError(409, 'gateway_wake_required',
        'The office Gateway must verify its shared Wake before enrollment.');
    }
  }

  private async reservation(coworker: OfficeCoworker): Promise<Reservation> {
    const registrationID = await OfficeCoworkerRegistry.handleFor(
      this.identity.organizationID, this.identity.sessionID, coworker.recipientBotID,
    );
    const createdAt = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO gateway_office_coworkers
        (org_id, gateway_session_id, recipient_bot_id, agent_handle, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(this.identity.organizationID, this.identity.sessionID,
      coworker.recipientBotID, registrationID, coworker.displayName, createdAt).run();

    const saved = await this.env.DB.prepare(
      `SELECT c.agent_handle AS registrationID, c.display_name AS displayName,
              c.recipient_agent_id AS recipientAgentID, c.recipient_session_id AS recipientSessionID,
              c.recipient_canonical_address AS recipientCanonicalAddress,
              c.activated_at AS activatedAt, c.removed_at AS removedAt,
              ${OfficeCoworkerRegistry.receivingColumns}
         FROM gateway_office_coworkers c ${OfficeCoworkerRegistry.receivingJoins}
        WHERE c.org_id = ? AND c.gateway_session_id = ? AND c.recipient_bot_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID,
      coworker.recipientBotID).first<Reservation>();

    if (!saved || saved.registrationID !== registrationID ||
        (!saved.recipientSessionID && saved.displayName !== coworker.displayName)) {
      throw new APIError(409, 'office_registration_conflict',
        'The platform Bot ID has a different registered identity.');
    }

    return saved;
  }

  private async requireAvailableName(displayName: string, allowedRegistrationID: string, allowedAgentID?: string) {
    const normalized = displayName.normalize('NFKC').toLowerCase();
    const agents = await this.address.listAgents();
    const conflict = agents.some((entry) =>
      entry.displayName?.normalize('NFKC').toLowerCase() === normalized &&
      entry.id !== allowedAgentID && entry.registrationID !== allowedRegistrationID);

    if (conflict) {
      throw new APIError(409, 'office_coworker_name_conflict',
        'The display name already identifies another Agent in this Organization.');
    }
  }

  private async synchronizeDisplayName(
    coworker: OfficeCoworker, reservation: Reservation, recipient: ResolvedSession,
  ): Promise<void> {
    if (reservation.displayName === coworker.displayName &&
        (recipient.agentDisplayName == null || recipient.agentDisplayName === coworker.displayName)) {
      return;
    }

    await this.requireAvailableName(coworker.displayName, reservation.registrationID, recipient.agentId);
    await this.address.renameAgent(recipient.agentId, coworker.displayName);

    const updated = await this.env.DB.prepare(
      `UPDATE gateway_office_coworkers SET display_name = ?
        WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
          AND recipient_session_id = ? AND identity_revision <= ?`,
    ).bind(coworker.displayName, this.identity.organizationID, this.identity.sessionID,
      coworker.recipientBotID, recipient.id, this.identity.organizationIdentityRevision).run();

    if (updated.meta.changes !== 1) {
      throw new APIError(409, 'office_registration_conflict', 'Coworker registration changed during rename.');
    }
  }

  private async resolveRegistered(
    coworker: OfficeCoworker, reservation: Reservation,
  ): Promise<ResolvedSession> {
    if (reservation.recipientSessionID) {
      if (!reservation.recipientAgentID) {
        throw new APIError(409, 'office_registration_conflict', 'The office reservation has no Agent.');
      }

      const projection = new OfficeAddressProjection(this.env, this.identity, this.address);
      const restored = await projection.resolve(reservation.recipientSessionID, reservation.recipientAgentID);
      await projection.refresh(restored, reservation.recipientCanonicalAddress);
      await this.synchronizeDisplayName(coworker, reservation, restored);

      return restored;
    }

    await this.requireAvailableName(coworker.displayName, reservation.registrationID);

    const recipient = await this.address.registerOfficeAgent(
      reservation.registrationID, coworker.displayName);

    if (recipient.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(502, 'office_registration_invalid',
        'Agent Address registered an unexpected office Session.');
    }

    const saved = await this.env.DB.prepare(
      `UPDATE gateway_office_coworkers
          SET recipient_agent_id = ?, recipient_session_id = ?, recipient_canonical_address = ?
        WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
          AND recipient_session_id IS NULL`,
    ).bind(recipient.agentId, recipient.id, recipient.canonical,
      this.identity.organizationID, this.identity.sessionID, coworker.recipientBotID).run();

    if (saved.meta.changes !== 1) {
      throw new APIError(409, 'office_registration_conflict',
        'A concurrent registration has changed the office Session.');
    }

    return recipient;
  }

  private async activate(
    coworker: OfficeCoworker, reservation: Reservation, recipient: ResolvedSession,
  ): Promise<void> {
    if (reservation.activatedAt) {
      const existing = await this.env.DB.prepare(
        `SELECT t.recipient_bot_id AS recipientBotID, r.thread_mode AS threadMode,
                r.first_contact_mode AS firstContactMode
           FROM gateway_teammates t JOIN gateway_routes r
             ON r.org_id = t.org_id AND r.recipient_session_id = t.recipient_session_id
          WHERE t.org_id = ? AND t.gateway_session_id = ?
            AND t.recipient_session_id = ? AND t.status = 'active'`,
      ).bind(this.identity.organizationID, this.identity.sessionID,
        recipient.id).first<{ recipientBotID: string; threadMode: string; firstContactMode: string }>();

      if (!existing || existing.recipientBotID !== coworker.recipientBotID ||
          existing.threadMode !== GatewayModeCodec.writeThreadMode(coworker.threadMode) ||
          existing.firstContactMode !== GatewayModeCodec.writeFirstContactMode(coworker.firstContactMode)) {
        throw new APIError(409, 'office_registration_conflict',
          'The active office route differs from its authorized registration.');
      }

      return;
    }

    const now = new Date().toISOString();
    const organizationID = this.identity.organizationID;
    const gatewaySessionID = this.identity.sessionID;
    const threadMode = GatewayModeCodec.writeThreadMode(coworker.threadMode);
    const firstContactMode = GatewayModeCodec.writeFirstContactMode(coworker.firstContactMode);
    const scope = [organizationID, gatewaySessionID, coworker.recipientBotID, recipient.id];

    const [membership, route, activation] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO gateway_teammates
           (org_id, gateway_session_id, recipient_agent_id, recipient_session_id,
            recipient_canonical_address, recipient_bot_id, thread_mode,
            first_contact_mode, status, created_at, approved_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM gateway_office_coworkers c
             WHERE c.org_id = ? AND c.gateway_session_id = ? AND c.recipient_bot_id = ?
               AND c.recipient_session_id = ? AND c.activated_at IS NULL AND c.independent_at IS NULL
               AND c.removed_at IS ?
               AND NOT EXISTS (SELECT 1 FROM wake_subscriptions w
                 WHERE w.org_id = c.org_id AND w.session_id = c.recipient_session_id)
               AND NOT EXISTS (SELECT 1 FROM gateway_routes r
                 WHERE r.org_id = c.org_id AND r.recipient_session_id = c.recipient_session_id)
               AND EXISTS (SELECT 1 FROM wake_subscriptions w
                 WHERE w.org_id = c.org_id AND w.session_id = c.gateway_session_id)
          )`,
      ).bind(organizationID, gatewaySessionID, recipient.agentId, recipient.id,
        recipient.canonical, coworker.recipientBotID, threadMode, firstContactMode, now, now,
        ...scope, reservation.removedAt),
      this.env.DB.prepare(
        `INSERT INTO gateway_routes
           (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
            recipient_bot_id, thread_mode, first_contact_mode, created_at)
         SELECT org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
                recipient_bot_id, thread_mode, first_contact_mode, ?
           FROM gateway_teammates
          WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
            AND recipient_session_id = ? AND status = 'active' AND approved_at = ?`,
      ).bind(now, ...scope, now),
      this.env.DB.prepare(
        `UPDATE gateway_office_coworkers SET activated_at = ?, removed_at = NULL
          WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
            AND recipient_session_id = ? AND activated_at IS NULL AND independent_at IS NULL
            AND removed_at IS ?
            AND EXISTS (SELECT 1 FROM gateway_teammates t
              WHERE t.org_id = gateway_office_coworkers.org_id
                AND t.gateway_session_id = gateway_office_coworkers.gateway_session_id
                AND t.recipient_session_id = gateway_office_coworkers.recipient_session_id
                AND t.status = 'active' AND t.approved_at = ?)`,
      ).bind(now, ...scope, reservation.removedAt, now),
    ]);

    if (membership.meta.changes !== 1 || route.meta.changes !== 1 || activation.meta.changes !== 1) {
      throw new APIError(409, 'office_connection_changed',
        'Coworker connection changed during enrollment; refresh the office.');
    }
  }

  private async enroll(coworker: OfficeCoworker): Promise<Record<string, unknown>> {
    const reservation = await this.reservation(coworker);

    if (reservation.removedAt && !coworker.rejoinRemoved) {
      return {
        displayName: reservation.displayName, recipientBotID: coworker.recipientBotID,
        recipientCanonicalAddress: reservation.recipientCanonicalAddress,
        recipientSessionID: reservation.recipientSessionID,
        route: OfficeCoworkerRegistry.route(reservation), removed: true,
      };
    }

    const recipient = await this.resolveRegistered(coworker, reservation);
    const independentlyConnected = !reservation.activatedAt &&
      OfficeCoworkerRegistry.hasConnection(reservation);

    if (!independentlyConnected) {
      await this.mailboxes.provision(this.identity.organizationID, recipient.agentId);
      await this.activate(coworker, reservation, recipient);
    }

    return {
      displayName: coworker.displayName, recipientBotID: coworker.recipientBotID,
      recipientCanonicalAddress: recipient.canonical, recipientSessionID: recipient.id,
      route: independentlyConnected || reservation.activatedAt
        ? OfficeCoworkerRegistry.route(reservation) : 'gateway',
      ...(independentlyConnected && reservation.removedAt ? { removed: true } : {}),
    };
  }

  async listOffice() {
    const records = await this.env.DB.prepare(
      `SELECT c.display_name AS displayName, c.recipient_bot_id AS recipientBotID,
              c.recipient_session_id AS recipientSessionID,
              c.recipient_agent_id AS recipientAgentID,
              c.recipient_canonical_address AS recipientCanonicalAddress,
              c.activated_at AS activatedAt, c.removed_at AS removedAt,
              c.identity_revision AS identityRevision,
              c.identity_available AS identityAvailable, ${OfficeCoworkerRegistry.receivingColumns}
         FROM gateway_office_coworkers c ${OfficeCoworkerRegistry.receivingJoins}
        WHERE c.org_id = ? AND c.gateway_session_id = ?
        ORDER BY c.display_name, c.recipient_bot_id`,
    ).bind(this.identity.organizationID, this.identity.sessionID).all<OfficeReceivingState & {
      displayName: string; recipientBotID: string; recipientSessionID: string | null;
      recipientAgentID: string | null; recipientCanonicalAddress: string | null; activatedAt: string | null;
      removedAt: string | null; identityRevision: number; identityAvailable: number;
    }>();

    const snapshots = records.results.flatMap((record): OfficeIdentitySnapshot[] =>
      record.recipientSessionID && record.recipientAgentID && record.recipientCanonicalAddress ? [{
        agentID: record.recipientAgentID, sessionID: record.recipientSessionID,
        botID: record.recipientBotID, canonicalAddress: record.recipientCanonicalAddress,
        displayName: record.displayName, identityRevision: record.identityRevision,
        identityAvailable: record.identityAvailable,
      }] : []);
    const projection = new OfficeAddressProjection(this.env, this.identity, this.address);
    const refreshed = new Map((await projection.refreshStale(snapshots)).map((row) => [row.botID, row]));

    return records.results.map((record) => {
      const session = refreshed.get(record.recipientBotID);

      return {
        displayName: session?.displayName ?? record.displayName,
        recipientBotID: record.recipientBotID,
        recipientSessionID: record.recipientSessionID,
        recipientCanonicalAddress: session?.canonicalAddress ?? record.recipientCanonicalAddress,
        enabled: session?.identityAvailable === 1 && record.activatedAt !== null &&
          record.activeGatewaySessionID === this.identity.sessionID,
        route: OfficeCoworkerRegistry.route(record),
        ...(record.removedAt ? { removed: true } : {}),
      };
    });
  }

  async enrollOffice(coworkers: OfficeCoworker[]): Promise<Record<string, unknown>[]> {
    if (coworkers.length < 1 || coworkers.length > 25) {
      throw new APIError(400, 'invalid_office_roster',
        'An office registration contains 1 to 25 native Bots.');
    }

    const seenBots = new Set<string>();
    const seenNames = new Set<string>();

    for (const coworker of coworkers) {
      PlatformBotIdentity.requireID(coworker.recipientBotID, 'recipientBotID');

      if (!coworker.displayName.trim() || coworker.displayName.length > 120 ||
          /[\u0000-\u001f\u007f]/.test(coworker.displayName)) {
        throw new APIError(400, 'invalid_office_name', 'Each office Bot needs a real display name.');
      }

      if (!Object.values(GatewayThreadMode).includes(coworker.threadMode) ||
          !Object.values(GatewayFirstContactMode).includes(coworker.firstContactMode) ||
          (coworker.threadMode === GatewayThreadMode.Platform &&
            coworker.firstContactMode !== GatewayFirstContactMode.Manual)) {
        throw new APIError(400, 'invalid_gateway_mode', 'Unsupported platform conversation mode.');
      }

      const name = coworker.displayName.normalize('NFKC').toLowerCase();

      if (seenBots.has(coworker.recipientBotID) || seenNames.has(name)) {
        throw new APIError(409, 'office_roster_duplicate',
          'The office roster has a duplicate Bot ID or display name.');
      }

      seenBots.add(coworker.recipientBotID);
      seenNames.add(name);
    }

    await this.requireVerifiedWake();

    const results: Record<string, unknown>[] = new Array(coworkers.length);
    let nextIndex = 0;
    const concurrency = Math.min(coworkers.length,
      OfficeGatewayEnrollment.MAX_CONCURRENT_ENROLLMENTS);

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < coworkers.length) {
        const index = nextIndex++;
        results[index] = await this.enroll(coworkers[index]);
      }
    });

    const completed = await Promise.allSettled(workers);
    const failures = completed.filter((result) => result.status === 'rejected');

    for (const failure of failures) {
      OfficeGatewayEnrollment.logger.exception('coworker_enrollment_failed', failure.reason);
    }

    if (failures.length > 0) {
      // A retry resumes successful coworkers from their stable addresses and routes.
      throw failures[0].reason;
    }

    return results;
  }
}
