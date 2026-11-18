import type { Env } from './Env';
import { APIError } from './HTTP';
import type { ResolvedSession, SessionIdentity, SessionIdentityClient } from './SessionIdentityClient';

export type OfficeIdentitySnapshot = {
  agentID: string;
  sessionID: string;
  botID: string;
  canonicalAddress: string;
  displayName: string;
  identityRevision: number;
  identityAvailable: number;
};

/** Address strings are projections; authorization belongs to immutable identity IDs. */
export class OfficeAddressProjection {
  private static readonly MAX_SELECTION = 25;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  private requireIdentity(session: ResolvedSession, sessionID: string, agentID: string): void {
    if (session.id !== sessionID || session.agentId !== agentID ||
        session.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(409, 'office_identity_changed', 'The authorized office identity no longer matches.');
    }
  }

  async resolve(sessionID: string, agentID: string): Promise<ResolvedSession> {
    const session = await this.address.session(sessionID);
    this.requireIdentity(session, sessionID, agentID);

    return session;
  }

  private addressStatements(session: ResolvedSession): D1PreparedStatement[] {
    const { organizationID, organizationIdentityRevision } = this.identity;

    // Do not let an older request overwrite a newer projection.
    return ['gateway_teammates', 'gateway_routes'].map((table) =>
      this.env.DB.prepare(
        `UPDATE ${table} SET recipient_canonical_address = ?
          WHERE org_id = ? AND recipient_agent_id = ? AND recipient_session_id = ?
            AND NOT EXISTS (SELECT 1 FROM gateway_office_coworkers c
              WHERE c.org_id = ? AND c.recipient_session_id = ? AND c.identity_revision > ?)`,
      ).bind(session.canonical, organizationID, session.agentId, session.id,
        organizationID, session.id, organizationIdentityRevision));
  }

  async refresh(session: ResolvedSession, previous: string | null): Promise<void> {
    if (session.canonical === previous) {
      return;
    }

    const { organizationID, organizationIdentityRevision } = this.identity;

    // Management and explicitly resolved addresses can reuse their existing Session lookup.
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE gateway_office_coworkers SET recipient_canonical_address = ?
          WHERE org_id = ? AND recipient_agent_id = ? AND recipient_session_id = ?
            AND identity_revision <= ?`,
      ).bind(session.canonical, organizationID, session.agentId, session.id, organizationIdentityRevision),
      ...this.addressStatements(session),
    ]);
  }

  private async refreshSelection<T extends OfficeIdentitySnapshot>(rows: T[]): Promise<T[]> {
    const { organizationID, organizationSlug, organizationIdentityRevision, sessionID } = this.identity;
    const selection = await this.address.selectSessions([...new Set(rows.map((row) => row.sessionID))]);

    if (selection.organization.id !== organizationID ||
        selection.organization.slug !== organizationSlug ||
        selection.organization.identityRevision !== organizationIdentityRevision) {
      throw new APIError(409, 'office_identity_changed',
        'Identity data changed during the request. Retry with the current Organization.');
    }

    const sessions = new Map(selection.sessions.map((session) => [session.id, session]));
    const writes: D1PreparedStatement[] = [];
    const updates: D1PreparedStatement[] = [];

    const refreshed = rows.map((row) => {
      const session = sessions.get(row.sessionID);
      if (session) {
        this.requireIdentity(session, row.sessionID, row.agentID);
      }

      const current = {
        ...row,
        canonicalAddress: session?.canonical ?? row.canonicalAddress,
        displayName: session?.agentDisplayName ?? row.displayName,
        identityRevision: organizationIdentityRevision,
        identityAvailable: session ? 1 : 0,
      };

      // Persist availability as well as names; archived Sessions must not keep an office voice.
      writes.push(this.env.DB.prepare(
        `UPDATE gateway_office_coworkers
            SET recipient_canonical_address = ?, display_name = ?,
                identity_revision = ?, identity_available = ?
          WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ?
            AND recipient_agent_id = ? AND recipient_session_id = ? AND identity_revision <= ?`,
      ).bind(current.canonicalAddress, current.displayName, current.identityRevision,
        current.identityAvailable, organizationID, sessionID, row.botID, row.agentID,
        row.sessionID, organizationIdentityRevision));

      if (session && session.canonical !== row.canonicalAddress) {
        updates.push(...this.addressStatements(session));
      }

      return current;
    });

    const results = await this.env.DB.batch([...writes, ...updates]);
    if (results.slice(0, writes.length).some((result) => result.meta.changes !== 1)) {
      throw new APIError(409, 'office_identity_changed', 'Office identity changed during refresh.');
    }

    return refreshed;
  }

  async refreshStale<T extends OfficeIdentitySnapshot>(rows: T[]): Promise<T[]> {
    const revision = this.identity.organizationIdentityRevision;
    const stale = rows.filter((row) => row.identityRevision !== revision);

    if (!stale.length) {
      return rows;
    }

    if (stale.some((row) => row.identityRevision > revision)) {
      throw new APIError(409, 'office_identity_changed', 'A newer office identity has already been saved.');
    }

    const current = new Map<string, T>();

    for (let index = 0; index < stale.length; index += OfficeAddressProjection.MAX_SELECTION) {
      const refreshed = await this.refreshSelection(
        stale.slice(index, index + OfficeAddressProjection.MAX_SELECTION),
      );

      for (const row of refreshed) {
        current.set(row.botID, row);
      }
    }

    return rows.map((row) => current.get(row.botID) ?? row);
  }
}
