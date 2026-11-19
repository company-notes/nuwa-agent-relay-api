import type { Env } from './Env';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { RecipientDirectory } from './RecipientDirectory';
import { PlatformBotIdentity } from './PlatformBotIdentity';
import {
  SessionIdentityClient, type ResolvedSession, type SessionIdentity,
} from './SessionIdentityClient';

type AliasRow = {
  id: string;
  agentID: string;
  sessionID: string;
  provider: string;
  externalID: string;
  verifiedAt: string | null;
  createdAt: string;
};

export type ExternalAlias = { provider: string; externalId: string };
export type Recipient = string | ExternalAlias;

export class AliasService {
  private static readonly ALIAS_COLUMNS =
    'id, agent_id AS agentID, session_id AS sessionID, provider, ' +
    'external_id AS externalID, verified_at AS verifiedAt, created_at AS createdAt';

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  private static normalizeProvider(value: string): string {
    const name = value.trim().toLowerCase();

    if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
      throw new APIError(400, 'invalid_provider', 'Provider must be a lowercase platform name.');
    }

    return name;
  }

  private static normalizeExternalID(provider: string, value: string): string {
    const normalized = provider === 'email' ? value.trim().toLowerCase() : value.trim();

    if (!normalized || normalized.length > 255 ||
        (provider === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))) {
      throw new APIError(400, 'invalid_external_id', 'External identity is invalid.');
    }

    return normalized;
  }

  static readRecipient(value: unknown): Recipient {
    if (typeof value === 'string' && value.trim()) {
      const address = value.trim();

      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
        ? { provider: 'email', externalId: address }
        : address;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const data = value as JSONRecord;

      return {
        provider: HTTP.requiredString(data, 'provider', 32),
        externalId: HTTP.requiredString(data, 'externalId', 255),
      };
    }

    throw new APIError(400, 'invalid_recipient', 'Recipient must be an Agent address or external alias.');
  }

  private static view(row: AliasRow): JSONRecord {
    return {
      id: row.id,
      agentID: row.agentID,
      sessionID: row.sessionID,
      provider: row.provider,
      externalId: row.externalID,
      verified: row.verifiedAt !== null,
      createdAt: row.createdAt,
    };
  }

  async create(providerInput: string, externalInput: string): Promise<JSONRecord> {
    const provider = AliasService.normalizeProvider(providerInput);
    const externalID = AliasService.normalizeExternalID(provider, externalInput);
    const existing = await this.env.DB.prepare(
      `SELECT ${AliasService.ALIAS_COLUMNS}
         FROM agent_aliases
        WHERE org_id = ? AND provider = ? AND external_id = ? AND revoked_at IS NULL`,
    ).bind(this.identity.organizationID, provider, externalID).first<AliasRow>();

    if (existing) {
      if (existing.sessionID !== this.identity.sessionID) {
        throw new APIError(409, 'alias_exists', 'Alias belongs to another Session.');
      }

      return AliasService.view(existing);
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO agent_aliases
         (id, org_id, agent_id, session_id, provider, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, this.identity.organizationID, this.identity.agentID, this.identity.sessionID,
      provider, externalID, createdAt).run();

    return { id, agentID: this.identity.agentID, sessionID: this.identity.sessionID,
      provider, externalId: externalID, verified: false, createdAt };
  }

  async list(): Promise<JSONRecord[]> {
    const rows = await this.env.DB.prepare(
      `SELECT ${AliasService.ALIAS_COLUMNS}
         FROM agent_aliases
        WHERE org_id = ? AND session_id = ? AND revoked_at IS NULL
        ORDER BY created_at`,
    ).bind(this.identity.organizationID, this.identity.sessionID).all<AliasRow>();

    return rows.results.map(AliasService.view);
  }

  async verify(id: string, verificationKey: string | null): Promise<JSONRecord> {
    if (!this.env.ALIAS_VERIFICATION_KEY || verificationKey !== this.env.ALIAS_VERIFICATION_KEY) {
      throw new APIError(403, 'verification_required', 'Operator verification is required.');
    }

    const result = await this.env.DB.prepare(
      `UPDATE agent_aliases SET verified_at = COALESCE(verified_at, ?)
        WHERE id = ? AND org_id = ? AND session_id = ? AND revoked_at IS NULL`,
    ).bind(new Date().toISOString(), id, this.identity.organizationID,
      this.identity.sessionID).run();

    if (result.meta.changes !== 1) {
      throw new APIError(404, 'alias_not_found', 'Alias is unavailable to this Session.');
    }

    return { id, verified: true };
  }

  async revoke(id: string): Promise<JSONRecord> {
    const result = await this.env.DB.prepare(
      `UPDATE agent_aliases SET revoked_at = ?
        WHERE id = ? AND org_id = ? AND session_id = ? AND revoked_at IS NULL`,
    ).bind(new Date().toISOString(), id, this.identity.organizationID,
      this.identity.sessionID).run();

    if (result.meta.changes !== 1) {
      throw new APIError(404, 'alias_not_found', 'Alias is unavailable to this Session.');
    }

    return { id, revoked: true };
  }

  private async resolveNativeBot(botID: string): Promise<ResolvedSession> {
    const { results } = await this.env.DB.prepare(
      `SELECT recipient_agent_id AS agentID, recipient_session_id AS sessionID
         FROM gateway_routes WHERE org_id = ? AND recipient_bot_id = ? LIMIT 2`,
    ).bind(this.identity.organizationID, botID).all<{
      agentID: string; sessionID: string;
    }>();

    if (results.length === 0) {
      throw new APIError(404, 'recipient_bot_not_found',
        'No registered Bot matches this native ID in the Organization.');
    }

    if (results.length > 1) {
      throw new APIError(409, 'recipient_bot_ambiguous',
        'Several registered Bots share this native ID. Use a Nuwa address.');
    }

    const [route] = results;
    const session = await this.address.session(route.sessionID);

    if (session.id !== route.sessionID || session.agentId !== route.agentID) {
      throw new APIError(409, 'recipient_bot_identity_mismatch',
        'The registered Bot route no longer matches its authorized Session.');
    }

    return session;
  }

  private async resolveAddressOrName(target: string): Promise<ResolvedSession> {
    const botID = PlatformBotIdentity.readSelector(target);

    if (botID !== null) {
      return this.resolveNativeBot(botID);
    }

    if (target.includes('/')) {
      return this.address.resolve(target);
    }

    return new RecipientDirectory(this.identity, this.address).resolve(target, { allowShortNames: true });
  }

  async resolve(target: Recipient): Promise<ResolvedSession> {
    const session = typeof target === 'string'
      ? await this.resolveAddressOrName(target)
      : await this.resolveExternal(target);

    if (session.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(403, 'cross_organization_unsupported', 'Recipient is outside the Organization.');
    }

    return session;
  }

  private async resolveExternal(target: ExternalAlias): Promise<ResolvedSession> {
    const provider = AliasService.normalizeProvider(target.provider);
    const externalID = AliasService.normalizeExternalID(provider, target.externalId);
    const alias = await this.env.DB.prepare(
      `SELECT agent_id AS agentID, session_id AS sessionID FROM agent_aliases
        WHERE org_id = ? AND provider = ? AND external_id = ?
          AND verified_at IS NOT NULL AND revoked_at IS NULL`,
    ).bind(this.identity.organizationID, provider, externalID)
      .first<{ agentID: string; sessionID: string }>();

    if (!alias) {
      throw new APIError(404, 'alias_not_verified', 'Recipient has no verified external alias.');
    }

    const session = await this.address.session(alias.sessionID);

    if (session.agentId !== alias.agentID) {
      throw new APIError(409, 'alias_identity_mismatch',
        'Verified alias no longer identifies its registered Agent.');
    }

    return session;
  }
}
