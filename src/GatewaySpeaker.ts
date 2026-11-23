import { AliasService, type Recipient } from './AliasService';
import type { Env } from './Env';
import { APIError } from './HTTP';
import { PlatformBotIdentity } from './PlatformBotIdentity';
import { OfficeAddressProjection, type OfficeIdentitySnapshot } from './OfficeAddressProjection';
import {
  SessionIdentityClient, type ResolvedSession, type SessionIdentity,
} from './SessionIdentityClient';

export enum SenderAuthMode {
  Session = 'session',
  OfficeTrust = 'office-trust',
}

export type SpeakerRequest = {
  from?: Recipient;
};

type OfficeSender = OfficeIdentitySnapshot & { ready: number };

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

  private async officeSenders(botID?: string): Promise<OfficeSender[]> {
    const rows = await this.env.DB.prepare(
      `SELECT c.recipient_agent_id AS agentID, c.recipient_session_id AS sessionID,
              c.recipient_canonical_address AS canonicalAddress, c.display_name AS displayName,
              c.recipient_bot_id AS botID, c.identity_revision AS identityRevision,
              c.identity_available AS identityAvailable,
              EXISTS (
                SELECT 1 FROM gateway_teammates t JOIN gateway_routes r
                  ON r.org_id = t.org_id AND r.recipient_session_id = t.recipient_session_id
                  AND r.recipient_bot_id = t.recipient_bot_id
                WHERE t.org_id = c.org_id AND t.gateway_session_id = c.gateway_session_id
                  AND t.recipient_session_id = c.recipient_session_id
                  AND t.recipient_bot_id = c.recipient_bot_id AND t.status = 'active'
              ) AS ready
         FROM gateway_office_coworkers c
        WHERE c.org_id = ? AND c.gateway_session_id = ? AND c.activated_at IS NOT NULL
          ${botID === undefined ? '' : 'AND c.recipient_bot_id = ?'}`,
    ).bind(this.actor.organizationID, this.actor.sessionID,
      ...(botID === undefined ? [] : [botID])).all<OfficeSender>();

    return rows.results;
  }

  private async resolveSender(from: Recipient): Promise<OfficeSender> {
    const botID = typeof from === 'string' ? PlatformBotIdentity.readSelector(from) : null;
    const projection = new OfficeAddressProjection(this.env, this.actor, this.address);
    let matches: OfficeSender[];
    let resolved: ResolvedSession | undefined;

    if (botID !== null) {
      matches = await projection.refreshStale(await this.officeSenders(botID));
    } else if (typeof from !== 'string' || from.includes('/') ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      resolved = await new AliasService(this.env, this.actor, this.address).resolve(from);
      const session = resolved;
      matches = (await this.officeSenders()).filter((entry) =>
        entry.sessionID === session.id && entry.agentID === session.agentId);
    } else {
      const name = from.trim().normalize('NFKC').toLowerCase();

      if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new APIError(400, 'invalid_gateway_sender_name',
          'Coworker display names must be one short line.');
      }

      const office = await projection.refreshStale(await this.officeSenders());
      const exactIDs = office.filter((entry) => entry.botID === from.trim());

      // Platform-native IDs are opaque. Resolve a registered ID before
      // interpreting the same string as a coworker's display name.
      matches = exactIDs.length ? exactIDs : office.filter((entry) =>
        entry.identityAvailable && entry.displayName.trim().normalize('NFKC').toLowerCase() === name);
    }

    if (matches.length !== 1 || !matches[0].ready ||
        (!resolved && !matches[0].identityAvailable)) {
      throw new APIError(403, 'gateway_sender_not_enrolled',
        'This sender is not a unique active coworker of the authenticated Gateway.');
    }

    const selected = matches[0];

    if (!resolved) {
      return selected;
    }

    await projection.refresh(resolved, selected.canonicalAddress);

    return {
      ...selected, canonicalAddress: resolved.canonical,
      displayName: resolved.agentDisplayName ?? selected.displayName,
    };
  }

  async resolve(from: Recipient | undefined): Promise<AuthorizedSpeaker | null> {
    if (from === undefined) {
      return null;
    }

    const office = await this.resolveSender(from);

    return {
      identity: {
        ...this.actor,
        agentID: office.agentID,
        sessionID: office.sessionID,
        canonicalAddress: office.canonicalAddress,
        agentDisplayName: office.displayName,
      },
      authMode: SenderAuthMode.OfficeTrust,
    };
  }
}
