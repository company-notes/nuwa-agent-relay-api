import type { Env } from './Env';
import { APIError } from './HTTP';
import type { ResolvedSession, SessionIdentity, SessionIdentityClient } from './SessionIdentityClient';

/** Address strings are projections; authorization belongs to immutable identity IDs. */
export class OfficeAddressProjection {
  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  async resolve(sessionID: string, agentID: string): Promise<ResolvedSession> {
    const session = await this.address.session(sessionID);

    if (session.id !== sessionID || session.agentId !== agentID ||
        session.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(409, 'office_identity_changed', 'The authorized office identity no longer matches.');
    }

    return session;
  }

  async refresh(session: ResolvedSession, previous: string | null): Promise<void> {
    if (session.canonical === previous) {
      return;
    }

    // Historical messages keep the addresses recorded when sent. Live route
    // snapshots are updated together, scoped by the verified identity.
    await this.env.DB.batch(
      ['gateway_office_coworkers', 'gateway_teammates', 'gateway_routes'].map((table) =>
        this.env.DB.prepare(
          `UPDATE ${table} SET recipient_canonical_address = ?
            WHERE org_id = ? AND recipient_agent_id = ? AND recipient_session_id = ?`,
        ).bind(session.canonical, this.identity.organizationID, session.agentId, session.id)),
    );
  }
}
