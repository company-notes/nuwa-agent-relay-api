import type { Env } from './Env';
import { APIError } from './HTTP';
import type { SessionIdentity, SessionIdentityClient } from './SessionIdentityClient';

type PolicyRow = {
  id: string;
  agentID: string;
  mode: number | null;
  revision: number;
};

export class CollaborationPolicy {
  constructor(private readonly env: Env) {}

  private static readonly columns = 'id, agent_id AS agentID, mode, revision';

  private static present(row: PolicyRow) {
    return {
      id: row.id, mode: row.mode === 1 ? 'autonomous' : row.mode === 0 ? 'manual' : 'unconfigured',
      revision: row.revision,
      settingsURL: 'https://agent-relay.company-notes.com/manage?collaboration=' + row.id,
    };
  }

  async work(identity: SessionIdentity, address: SessionIdentityClient, initialize: boolean) {
    const grant = await address.grant(identity.organizationID);
    const scope = [identity.organizationID, identity.agentID, grant];

    if (initialize) {
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO collaboration_policies (id, org_id, agent_id, grant_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), ...scope, new Date().toISOString()).run();
    }

    const row = await this.env.DB.prepare(
      'SELECT ' + CollaborationPolicy.columns +
      ' FROM collaboration_policies WHERE org_id = ? AND agent_id = ? AND grant_fingerprint = ?',
    ).bind(...scope).first<PolicyRow>();

    return row ? CollaborationPolicy.present(row) : { mode: 'unconfigured' };
  }

  async requireAutonomous(identity: SessionIdentity, address: SessionIdentityClient): Promise<void> {
    const policy = await this.work(identity, address, false);

    if (policy.mode !== 'autonomous') {
      throw new APIError(403, 'collaboration_approval_required',
        'Owner authorization is not active. Do not retry without autonomous; ask the owner to review the collaboration settings.');
    }
  }

  async list(organization: { id: string; slug: string }, address: SessionIdentityClient) {
    const agents = new Map((await address.listAgents()).map((agent) => [agent.id, agent]));
    const rows = await this.env.DB.prepare(
      'SELECT ' + CollaborationPolicy.columns + ' FROM collaboration_policies WHERE org_id = ? ORDER BY updated_at DESC, id',
    ).bind(organization.id).all<PolicyRow>();

    return rows.results.flatMap((row) => {
      const agent = agents.get(row.agentID);

      return agent ? [{
        ...CollaborationPolicy.present(row), agentID: row.agentID,
        canonical: organization.slug + '/' + agent.handle, displayName: agent.displayName,
      }] : [];
    });
  }

  async update(orgID: string, id: string, mode: unknown, revision: unknown, address: SessionIdentityClient) {
    if ((mode !== 'manual' && mode !== 'autonomous') ||
        typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new APIError(400, 'invalid_collaboration_policy', 'Choose manual or autonomous and provide the current revision.');
    }

    const query = 'SELECT ' + CollaborationPolicy.columns + ' FROM collaboration_policies WHERE org_id = ? AND id = ?';
    const row = await this.env.DB.prepare(query).bind(orgID, id).first<PolicyRow>();

    if (!row || !(await address.listAgents()).some((agent) => agent.id === row.agentID)) {
      throw new APIError(404, 'collaboration_policy_not_found', 'Collaboration policy not found.');
    }

    const result = await this.env.DB.prepare(
      'UPDATE collaboration_policies SET mode = ?, revision = revision + 1, updated_at = ? WHERE org_id = ? AND id = ? AND revision = ?',
    ).bind(mode === 'autonomous' ? 1 : 0, new Date().toISOString(), orgID, id, revision).run();

    if (result.meta.changes !== 1) {
      throw new APIError(409, 'collaboration_policy_changed', 'The policy changed. Reload and review the current choice.');
    }

    return CollaborationPolicy.present({ ...row, mode: mode === 'autonomous' ? 1 : 0, revision: revision + 1 });
  }
}
