import { AgentMailboxService } from './AgentMailboxService';
import { CoworkerPassphrases } from './CoworkerPassphrases';
import type { Env } from './Env';
import { GatewayFirstContactMode, GatewayModeCodec, GatewayThreadMode } from './GatewayModeCodec';
import { APIError } from './HTTP';
import { Logger } from './Logger';
import { PlatformBotIdentity } from './PlatformBotIdentity';
import { SessionIdentityClient, type ResolvedSession, type SessionIdentity } from './SessionIdentityClient';

export type OfficeCoworker = {
  displayName: string;
  recipientBotID: string;
  passphrase?: string;
  threadMode: GatewayThreadMode;
  firstContactMode: GatewayFirstContactMode;
};

type Reservation = {
  agentHandle: string;
  displayName: string;
  recipientAgentID: string | null;
  recipientSessionID: string | null;
  recipientCanonicalAddress: string | null;
  activatedAt: string | null;
};

/** Registers office-owned addresses and routes under one authorized Gateway. */
export class OfficeGatewayEnrollment {
  private static readonly logger = Logger.forModule('office.enrollment');
  private static readonly MAX_CONCURRENT_ENROLLMENTS = 4;
  private readonly passphrases: CoworkerPassphrases;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
    private readonly mailboxes = new AgentMailboxService(env),
  ) {
    this.passphrases = new CoworkerPassphrases(env, identity);
  }

  private async requireVerifiedWake(): Promise<void> {
    const wake = await this.env.DB.prepare(
      'SELECT session_id FROM wake_subscriptions WHERE org_id = ? AND session_id = ?',
    ).bind(this.identity.organizationID, this.identity.sessionID).first();

    if (!wake) {
      throw new APIError(409, 'gateway_wake_required',
        'The office Gateway must verify its shared Wake before enrollment.');
    }
  }

  private async handleFor(recipientBotID: string): Promise<string> {
    const source = this.identity.organizationID + ':' +
      this.identity.sessionID + ':' + recipientBotID;
    const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));

    return 'office-' + Array.from(new Uint8Array(hashed).slice(0, 16),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private async reservation(coworker: OfficeCoworker): Promise<Reservation> {
    const agentHandle = await this.handleFor(coworker.recipientBotID);
    const createdAt = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO gateway_office_coworkers
        (org_id, gateway_session_id, recipient_bot_id, agent_handle, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(this.identity.organizationID, this.identity.sessionID,
      coworker.recipientBotID, agentHandle, coworker.displayName, createdAt).run();

    const saved = await this.env.DB.prepare(
      `SELECT agent_handle AS agentHandle, display_name AS displayName,
              recipient_agent_id AS recipientAgentID, recipient_session_id AS recipientSessionID,
              recipient_canonical_address AS recipientCanonicalAddress,
              activated_at AS activatedAt
         FROM gateway_office_coworkers
        WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID,
      coworker.recipientBotID).first<Reservation>();

    if (!saved || saved.agentHandle !== agentHandle ||
        saved.displayName !== coworker.displayName) {
      throw new APIError(409, 'office_registration_conflict',
        'The platform Bot ID has a different registered identity.');
    }

    return saved;
  }

  private async resolveRegistered(
    coworker: OfficeCoworker, reservation: Reservation,
  ): Promise<ResolvedSession> {
    if (reservation.recipientSessionID) {
      const restored = await this.address.session(reservation.recipientSessionID);

      if (restored.agentId !== reservation.recipientAgentID ||
          restored.canonical !== reservation.recipientCanonicalAddress) {
        throw new APIError(409, 'office_registration_conflict',
          'The office Session identity no longer matches its reservation.');
      }

      return restored;
    }

    const agents = await this.address.listAgents();
    const matches = agents.filter((entry) =>
      entry.displayName?.normalize('NFKC').toLowerCase() ===
      coworker.displayName.normalize('NFKC').toLowerCase() &&
      entry.handle !== reservation.agentHandle);

    if (matches.length > 0) {
      throw new APIError(409, 'office_coworker_name_conflict',
        'The display name already identifies another Agent in this Organization.');
    }

    const recipient = await this.address.registerOfficeAgent(
      reservation.agentHandle, coworker.displayName);


    if (recipient.canonical !== this.identity.organizationSlug +
        '/' + reservation.agentHandle + '/main') {
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

    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO gateway_teammates
           (org_id, gateway_session_id, recipient_agent_id, recipient_session_id,
            recipient_canonical_address, recipient_bot_id, thread_mode,
            first_contact_mode, status, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(this.identity.organizationID, this.identity.sessionID,
        recipient.agentId, recipient.id, recipient.canonical, coworker.recipientBotID,
        GatewayModeCodec.writeThreadMode(coworker.threadMode),
        GatewayModeCodec.writeFirstContactMode(coworker.firstContactMode), now, now),
      this.env.DB.prepare(
        `INSERT INTO gateway_routes
          (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
           recipient_bot_id, thread_mode, first_contact_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(this.identity.organizationID, recipient.agentId, recipient.id,
        recipient.canonical, coworker.recipientBotID,
        GatewayModeCodec.writeThreadMode(coworker.threadMode),
        GatewayModeCodec.writeFirstContactMode(coworker.firstContactMode), now),
      this.env.DB.prepare(
        `UPDATE gateway_office_coworkers
            SET activated_at = ?
          WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
            AND recipient_session_id = ? AND activated_at IS NULL`,
      ).bind(now, this.identity.organizationID, this.identity.sessionID,
        coworker.recipientBotID, recipient.id),
    ]);
  }

  private async enroll(coworker: OfficeCoworker): Promise<Record<string, unknown>> {
    const reservation = await this.reservation(coworker);

    if (coworker.passphrase !== undefined) {
      await this.passphrases.setDuringEnrollment(coworker.recipientBotID, coworker.passphrase);
    }

    const recipient = await this.resolveRegistered(coworker, reservation);

    await this.mailboxes.provision(this.identity.organizationID, recipient.agentId);
    await this.activate(coworker, reservation, recipient);

    return {
      displayName: coworker.displayName, recipientBotID: coworker.recipientBotID,
      recipientCanonicalAddress: recipient.canonical,
      recipientSessionID: recipient.id,
      route: 'gateway',
    };
  }

  async listOffice() {
    const records = await this.env.DB.prepare(
      `SELECT display_name AS displayName, recipient_bot_id AS recipientBotID,
              recipient_session_id AS recipientSessionID,
              recipient_canonical_address AS recipientCanonicalAddress,
              activated_at AS activatedAt, passphrase_hash AS passphraseHash
         FROM gateway_office_coworkers
        WHERE org_id = ? AND gateway_session_id = ?
        ORDER BY display_name, recipient_bot_id`,
    ).bind(this.identity.organizationID, this.identity.sessionID).all<{
      displayName: string; recipientBotID: string; recipientSessionID: string | null;
      recipientCanonicalAddress: string | null; activatedAt: string | null;
      passphraseHash: string | null;
    }>();

    return records.results.map(({ activatedAt, passphraseHash, ...record }) => ({
      ...record, enabled: activatedAt !== null, hasPassphrase: passphraseHash !== null,
    }));
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

      if (coworker.passphrase !== undefined) {
        CoworkerPassphrases.validate(coworker.passphrase);
      }

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
