import type { Address, AddressClient } from './AddressClient';
import type { Env } from './Env';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { IdentityContext } from './IdentityContext';

type AliasRow = {
  id: string;
  org_id: string;
  work_address_id: string;
  canonical_address: string;
  provider: string;
  external_id: string;
  verified_at: string | null;
  created_at: string;
};

export type AliasTarget = { provider: string; externalId: string };
export type Recipient = string | AliasTarget;

export class AliasService {
  constructor(
    private readonly env: Env,
    private readonly identity: IdentityContext,
  ) {}

  private static normalizeProvider(provider: string): string {
    const result = provider.trim().toLowerCase();

    if (!/^[a-z][a-z0-9-]{1,31}$/.test(result)) {
      throw new APIError(400, 'invalid_provider', 'Provider must be a lowercase platform name.');
    }

    return result;
  }

  private static normalizeExternalId(provider: string, externalId: string): string {
    const id = externalId.trim();

    if (id.length === 0 || id.length > 255) {
      throw new APIError(400, 'invalid_external_id', 'External identifier must contain 1–255 characters.');
    }

    if (provider === 'email') {
      const email = id.toLowerCase();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new APIError(400, 'invalid_email', 'Email alias must be a valid email address.');
      }

      return email;
    }

    return id;
  }

  private static publicAlias(row: AliasRow): JSONRecord {
    return {
      id: row.id,
      provider: row.provider,
      externalId: row.external_id,
      workAddressId: row.work_address_id,
      canonicalAddress: row.canonical_address,
      verified: row.verified_at !== null,
      createdAt: row.created_at,
    };
  }

  static readRecipient(value: unknown): Recipient {
    if (typeof value === 'string' && value.trim()) {
      const target = value.trim();

      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
        return { provider: 'email', externalId: target };
      }

      return target;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const data = value as JSONRecord;

      return {
        provider: HTTP.requiredString(data, 'provider', 32),
        externalId: HTTP.requiredString(data, 'externalId', 255),
      };
    }

    throw new APIError(400, 'invalid_recipient', 'to must be a canonical address, email, or provider/externalId object.');
  }

  async create(providerInput: string, externalIdInput: string): Promise<JSONRecord> {
    const provider = AliasService.normalizeProvider(providerInput);
    const externalId = AliasService.normalizeExternalId(provider, externalIdInput);

    const existing = await this.env.DB.prepare(
      `SELECT id, org_id, work_address_id, canonical_address, provider,
              external_id, verified_at, created_at
         FROM agent_aliases
        WHERE org_id = ? AND provider = ? AND external_id = ? AND revoked_at IS NULL`,
    ).bind(this.identity.organization.id, provider, externalId).first<AliasRow>();

    if (existing) {
      if (existing.work_address_id !== this.identity.work.id) {
        throw new APIError(409, 'alias_exists', 'This external identity is already assigned to another agent.');
      }

      return AliasService.publicAlias(existing);
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO agent_aliases
        (id, org_id, work_address_id, canonical_address, provider, external_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      this.identity.organization.id,
      this.identity.work.id,
      this.identity.work.canonical,
      provider,
      externalId,
      createdAt,
    ).run();

    return {
      id,
      provider,
      externalId,
      workAddressId: this.identity.work.id,
      canonicalAddress: this.identity.work.canonical,
      verified: false,
      createdAt,
    };
  }

  async list(): Promise<JSONRecord[]> {
    const rows = await this.env.DB.prepare(
      `SELECT id, org_id, work_address_id, canonical_address, provider,
              external_id, verified_at, created_at
         FROM agent_aliases
        WHERE org_id = ? AND work_address_id = ? AND revoked_at IS NULL
        ORDER BY created_at`,
    ).bind(this.identity.organization.id, this.identity.work.id).all<AliasRow>();

    return rows.results.map(AliasService.publicAlias);
  }

  async verify(aliasId: string, verificationKey: string | null): Promise<JSONRecord> {
    const configured = this.env.ALIAS_VERIFICATION_KEY;

    if (!configured || !verificationKey || verificationKey !== configured) {
      throw new APIError(403, 'verification_required', 'Alias verification requires the relay operator key.');
    }

    const result = await this.env.DB.prepare(
      `UPDATE agent_aliases
          SET verified_at = COALESCE(verified_at, ?)
        WHERE id = ? AND org_id = ? AND work_address_id = ? AND revoked_at IS NULL`,
    ).bind(new Date().toISOString(), aliasId, this.identity.organization.id, this.identity.work.id).run();

    if (!result.meta.changes) {
      throw new APIError(404, 'alias_not_found', 'Alias does not belong to the current work identity.');
    }

    return { id: aliasId, verified: true };
  }

  async revoke(aliasId: string): Promise<JSONRecord> {
    const result = await this.env.DB.prepare(
      `UPDATE agent_aliases SET revoked_at = ?
        WHERE id = ? AND org_id = ? AND work_address_id = ? AND revoked_at IS NULL`,
    ).bind(new Date().toISOString(), aliasId, this.identity.organization.id, this.identity.work.id).run();

    if (!result.meta.changes) {
      throw new APIError(404, 'alias_not_found', 'Alias does not belong to the current work identity.');
    }

    return { id: aliasId, revoked: true };
  }

  async resolve(target: Recipient, addressClient: AddressClient): Promise<Address> {
    if (typeof target === 'string') {
      return this.identity.requireSameOrganization(await addressClient.resolve(target));
    }

    const provider = AliasService.normalizeProvider(target.provider);
    const externalId = AliasService.normalizeExternalId(provider, target.externalId);

    const alias = await this.env.DB.prepare(
      `SELECT work_address_id, canonical_address
         FROM agent_aliases
        WHERE org_id = ? AND provider = ? AND external_id = ?
          AND verified_at IS NOT NULL AND revoked_at IS NULL`,
    ).bind(this.identity.organization.id, provider, externalId)
      .first<{ work_address_id: string; canonical_address: string }>();

    if (!alias) {
      throw new APIError(404, 'alias_not_verified', 'No verified agent identity is registered for this alias.');
    }

    const resolved = this.identity.requireSameOrganization(await addressClient.resolve(alias.canonical_address));

    if (resolved.id !== alias.work_address_id) {
      throw new APIError(409, 'stale_alias', 'Alias no longer identifies the registered active work address.');
    }

    return resolved;
  }
}
