import { AliasService, type Recipient } from './AliasService';
import { CoworkerPassphrases, type StoredCoworkerPassphrase } from './CoworkerPassphrases';
import type { Env } from './Env';
import { APIError } from './HTTP';
import {
  SessionIdentityClient, type SessionIdentity, type ResolvedSession,
} from './SessionIdentityClient';

export enum SenderAuthMode {
  Session = 'session',
  OfficeTrust = 'office-trust',
  Passphrase = 'passphrase',
}

export type SpeakerRequest = {
  from?: Recipient;
  passphrase?: string;
};

type OfficeSender = StoredCoworkerPassphrase & {
  agentID: string;
  sessionID: string;
  canonicalAddress: string;
  displayName: string;
};

export type AuthorizedSpeaker = {
  identity: SessionIdentity;
  authMode: SenderAuthMode;
};

// Separates the OAuth-authorized office actor from a coworker's declared voice.
export class GatewaySpeaker {
  constructor(
    private readonly env: Env,
    private readonly actor: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  async status(): Promise<{ enabled: boolean }> {
    const row = await this.env.DB.prepare(
      'SELECT enabled FROM gateway_office_delegation WHERE org_id = ? AND gateway_session_id = ?',
    ).bind(this.actor.organizationID, this.actor.sessionID).first<{ enabled: number }>();

    return { enabled: row?.enabled === 1 };
  }

  async configure(enabled: boolean): Promise<{ enabled: boolean }> {
    const office = await this.env.DB.prepare(
      'SELECT 1 FROM gateway_office_coworkers ' +
      'WHERE org_id = ? AND gateway_session_id = ? AND activated_at IS NOT NULL LIMIT 1',
    ).bind(this.actor.organizationID, this.actor.sessionID).first();

    if (!office) {
      throw new APIError(403, 'gateway_delegation_not_office',
        'Only the authenticated owner of an enrolled office Gateway may set delegation.');
    }

    await this.env.DB.prepare(
      'INSERT INTO gateway_office_delegation (org_id, gateway_session_id, enabled, updated_at) ' +
      'VALUES (?, ?, ?, ?) ON CONFLICT(org_id, gateway_session_id) DO UPDATE SET ' +
      'enabled = excluded.enabled, updated_at = excluded.updated_at',
    ).bind(this.actor.organizationID, this.actor.sessionID,
      enabled ? 1 : 0, new Date().toISOString()).run();

    return { enabled };
  }


  private async resolveSender(from: Recipient): Promise<ResolvedSession> {
    if (typeof from !== 'string' || from.includes('/') ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      return new AliasService(this.env, this.actor, this.address).resolve(from);
    }

    const name = from.trim().normalize('NFKC').toLowerCase();

    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new APIError(400, 'invalid_gateway_sender_name',
        'Coworker display names must be one short line.');
    }

    // Resolve within this office, not a cached Organization directory: two
    // offices may have namesakes and previous test/roster snapshots may expire.
    const list = await this.env.DB.prepare(
      'SELECT recipient_agent_id AS agentID, recipient_session_id AS sessionID, ' +
      'recipient_canonical_address AS canonicalAddress, display_name AS displayName ' +
      'FROM gateway_office_coworkers WHERE org_id = ? AND gateway_session_id = ? ' +
      'AND activated_at IS NOT NULL',
    ).bind(this.actor.organizationID, this.actor.sessionID).all<{
      agentID: string; sessionID: string; canonicalAddress: string; displayName: string;
    }>();
    const matches = list.results.filter((entry) =>
      entry.displayName.trim().normalize('NFKC').toLowerCase() === name);

    if (matches.length !== 1) {
      throw new APIError(403, 'gateway_sender_not_enrolled',
        'This display name is not a unique active coworker of this Gateway.');
    }

    return {
      id: matches[0].sessionID,
      agentId: matches[0].agentID,
      canonical: matches[0].canonicalAddress,
    };
  }

  async resolve(
    from: Recipient | undefined, passphrase: string | undefined,
  ): Promise<AuthorizedSpeaker | null> {
    if (from === undefined) {
      if (passphrase !== undefined) {
        throw new APIError(400, 'coworker_sender_required',
          'A passphrase may only accompany an explicitly selected coworker.');
      }

      return null;
    }

    if (!(await this.status()).enabled) {
      throw new APIError(403, 'gateway_delegation_disabled',
        'Office speaking delegation requires the Gateway owner to opt in first.');
    }

    const session = await this.resolveSender(from);
    const office = await this.env.DB.prepare(
      'SELECT c.recipient_agent_id AS agentID, c.recipient_session_id AS sessionID, ' +
      'c.recipient_canonical_address AS canonicalAddress, c.display_name AS displayName, ' +
      'c.passphrase_salt AS passphraseSalt, c.passphrase_hash AS passphraseHash ' +
      'FROM gateway_office_coworkers c JOIN gateway_teammates t ' +
      'ON t.org_id = c.org_id AND t.gateway_session_id = c.gateway_session_id ' +
      'AND t.recipient_session_id = c.recipient_session_id ' +
      'AND t.recipient_bot_id = c.recipient_bot_id AND t.status = \'active\' ' +
      'JOIN gateway_routes r ON r.org_id = c.org_id ' +
      'AND r.recipient_session_id = c.recipient_session_id ' +
      'AND r.recipient_bot_id = c.recipient_bot_id ' +
      'WHERE c.org_id = ? AND c.gateway_session_id = ? ' +
      'AND c.recipient_session_id = ? AND c.recipient_agent_id = ? ' +
      'AND c.recipient_canonical_address = ? AND c.activated_at IS NOT NULL',
    ).bind(this.actor.organizationID, this.actor.sessionID, session.id,
      session.agentId, session.canonical).first<OfficeSender>();

    if (!office) {
      throw new APIError(403, 'gateway_sender_not_enrolled',
        'This sender is not an active coworker of the authenticated Gateway.');
    }

    const verified = await CoworkerPassphrases.verify(office, passphrase);

    return {
      identity: {
        ...this.actor,
        agentID: office.agentID,
        sessionID: office.sessionID,
        canonicalAddress: office.canonicalAddress,
        agentDisplayName: office.displayName,
      },
      authMode: verified ? SenderAuthMode.Passphrase : SenderAuthMode.OfficeTrust,
    };
  }
}
