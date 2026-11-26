import type { Env } from './Env';
import { APIError } from './HTTP';
import { MailTriggerClient } from './MailTriggerClient';
import { RelayManagementPage } from './RelayManagementPage';
import {
  SessionIdentityClient,
} from './SessionIdentityClient';

type Organization = { id: string; slug: string };

type ResetMember = {
  agentID: string;
  agentHandle: string;
  displayName: string | null;
  sessionIDs: string[];
};

type Mailbox = {
  agentID: string;
  mailboxID: string;
};

type ResetPlan = {
  organizationID: string;
  targetAgentID: string;
  targetCanonical: string;
  confirmation: string;
  members: ResetMember[];
  sessionIDs: string[];
  threadIDs: string[];
  mailboxes: Mailbox[];
  protectedCoworkers: number;
};

type ResetJob = {
  planJSON: string;
  fingerprint: string;
  stage: 'prepared' | 'relay_cleared' | 'completed';
  purgedAgentIDsJSON: string;
  leaseOwner: string | null;
};

type ScopedCoworker = {
  agentID: string | null;
  independentAt: string | null;
};

type ThreadID = { id: string };

type AgentRows = { agentID: string; mailboxID: string };

export class ManagementAgentReset {
  constructor(
    private readonly env: Env,
    private readonly address: SessionIdentityClient,
    private readonly authorization: string,
  ) {}

  private async organization(): Promise<Organization> {
    const status = await this.address.status();

    if (!status.organization) {
      throw new APIError(403, 'organization_required', 'An authorized Organization is required.');
    }

    return status.organization;
  }

  async agents(): Promise<Record<string, unknown>[]> {
    const org = await this.organization();
    const agents = await this.address.listAgents();

    return agents.filter((agent) => agent.defaultSessionHandle && agent.defaultSessionID)
      .map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        canonical: org.slug + '/' + agent.handle + '/' + agent.defaultSessionHandle,
      }));
  }

  private async currentJob(orgID: string, agentID: string): Promise<ResetJob | null> {
    return this.env.DB.prepare(
      `SELECT plan_json AS planJSON, fingerprint, stage,
              purged_agent_ids_json AS purgedAgentIDsJSON, lease_owner AS leaseOwner
         FROM management_agent_resets WHERE org_id = ? AND agent_id = ?`,
    ).bind(orgID, agentID).first<ResetJob>();
  }

  private static slots(values: readonly unknown[]): string {
    return values.map(() => '?').join(', ');
  }

  private static unique(values: string[]): string[] {
    return [...new Set(values)].sort();
  }

  private static async digest(plan: ResetPlan): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(plan));
    const hash = await crypto.subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, '0')).join('');
  }

  private async prepare(org: Organization, agentID: string): Promise<ResetPlan> {
    const available = await this.address.listAgents();
    const byID = new Map(available.map((agent) => [agent.id, agent]));
    const selected = byID.get(agentID);

    if (!selected?.defaultSessionHandle || !selected.defaultSessionID) {
      throw new APIError(404, 'agent_not_owned', 'The selected Agent is not available in this Organization.');
    }

    const root = await this.address.listSessions(agentID);
    const rootIDs = root.map((session) => session.id);

    if (rootIDs.length === 0) {
      throw new APIError(409, 'reset_no_sessions', 'The selected Agent has no active Session.');
    }

    const coworkerRows = await this.env.DB.prepare(
      'SELECT DISTINCT recipient_agent_id AS agentID, independent_at AS independentAt ' +
      'FROM gateway_office_coworkers WHERE org_id = ? AND gateway_session_id IN (' +
      ManagementAgentReset.slots(rootIDs) + ')',
    ).bind(org.id, ...rootIDs).all<ScopedCoworker>();
    const managed = ManagementAgentReset.unique(coworkerRows.results
      .filter((row) => !row.independentAt && row.agentID && row.agentID !== agentID)
      .map((row) => row.agentID!));
    const protectedCoworkers = coworkerRows.results
      .filter((row) => row.independentAt !== null).length;
    const members: ResetMember[] = [];

    for (const memberID of [agentID, ...managed]) {
      const agent = byID.get(memberID);

      if (!agent) {
        throw new APIError(409, 'reset_roster_changed',
          'An enrolled coworker identity is missing from Agent Address. Repair the roster first.');
      }

      const sessions = await this.address.listSessions(memberID);

      if (sessions.length < 1 || sessions.some((session) =>
        session.agentId !== memberID || session.canonical.split('/')[0] !== org.slug)) {
        throw new APIError(409, 'reset_roster_changed',
          'The selected Agent or coworker Sessions have changed.');
      }

      members.push({
        agentID: memberID, agentHandle: agent.handle,
        displayName: agent.displayName,
        sessionIDs: ManagementAgentReset.unique(sessions.map((session) => session.id)),
      });
    }

    const agentIDs = ManagementAgentReset.unique(members.map((member) => member.agentID));
    const sessionIDs = ManagementAgentReset.unique(members.flatMap((member) => member.sessionIDs));
    const outside = await this.env.DB.prepare(
      'SELECT count(*) AS count FROM gateway_teammates WHERE org_id = ? AND ' +
      'recipient_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') AND ' +
      'gateway_session_id NOT IN (' + ManagementAgentReset.slots(rootIDs) + ')',
    ).bind(org.id, ...agentIDs, ...rootIDs).first<{ count: number }>();

    const outsideOffice = await this.env.DB.prepare(
      'SELECT count(*) AS count FROM gateway_office_coworkers WHERE org_id = ? AND ' +
      'recipient_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') AND ' +
      'gateway_session_id NOT IN (' + ManagementAgentReset.slots(rootIDs) + ')',
    ).bind(org.id, ...agentIDs, ...rootIDs).first<{ count: number }>();

    if ((outside?.count ?? 0) > 0 || (outsideOffice?.count ?? 0) > 0) {
      throw new APIError(409, 'reset_other_gateway_in_use',
        'An affected Agent is connected to another Gateway; remove that connection first.');
    }

    const mailboxRows = await this.env.DB.prepare(
      'SELECT agent_id AS agentID, mailbox_id AS mailboxID FROM agent_mailboxes ' +
      'WHERE org_id = ? AND agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') ' +
      'ORDER BY agent_id',
    ).bind(org.id, ...agentIDs).all<AgentRows>();
    const threadRows = await this.env.DB.prepare(
      'SELECT DISTINCT t.id FROM threads t LEFT JOIN messages m ON m.thread_id = t.id ' +
      'WHERE t.org_id = ? AND (' +
      't.sender_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') OR ' +
      't.recipient_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') OR ' +
      'm.sender_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') OR ' +
      'm.recipient_agent_id IN (' + ManagementAgentReset.slots(agentIDs) + ') OR ' +
      'm.actor_session_id IN (' + ManagementAgentReset.slots(sessionIDs) + ')) ' +
      'ORDER BY t.id',
    ).bind(org.id, ...agentIDs, ...agentIDs, ...agentIDs, ...agentIDs, ...sessionIDs).all<ThreadID>();

    const targetCanonical = org.slug + '/' + selected.handle + '/' + selected.defaultSessionHandle;

    return {
      organizationID: org.id, targetAgentID: agentID, targetCanonical,
      confirmation: 'RESET ' + targetCanonical,
      members, sessionIDs,
      threadIDs: threadRows.results.map((row) => row.id),
      mailboxes: mailboxRows.results,
      protectedCoworkers,
    };
  }

  private static summary(plan: ResetPlan, fingerprint: string, stage: string) {
    return {
      targetAgentID: plan.targetAgentID,
      targetCanonical: plan.targetCanonical,
      confirmation: plan.confirmation,
      fingerprint,
      stage,
      members: plan.members.map((member) => ({
        id: member.agentID,
        addressPrefix: plan.targetCanonical.split('/')[0] + '/' + member.agentHandle,
        displayName: member.displayName,
        sessions: member.sessionIDs.length,
      })),
      conversationCount: plan.threadIDs.length,
      mailboxCount: plan.mailboxes.length,
      protectedCoworkers: plan.protectedCoworkers,
    };
  }

  async preview(agentID: string): Promise<Record<string, unknown>> {
    const org = await this.organization();
    const job = await this.currentJob(org.id, agentID);

    if (job) {
      const plan = JSON.parse(job.planJSON) as ResetPlan;
      return ManagementAgentReset.summary(plan, job.fingerprint, job.stage);
    }

    const plan = await this.prepare(org, agentID);
    return ManagementAgentReset.summary(plan, await ManagementAgentReset.digest(plan), 'preview');
  }

  private async claim(org: Organization, agentID: string): Promise<string> {
    const now = new Date().toISOString();
    const lease = crypto.randomUUID();
    const expiry = new Date(Date.now() + 120_000).toISOString();
    const result = await this.env.DB.prepare(
      'UPDATE management_agent_resets SET lease_owner = ?, lease_until = ? ' +
      'WHERE org_id = ? AND agent_id = ? AND stage <> ? AND ' +
      '(lease_until IS NULL OR lease_until < ?)',
    ).bind(lease, expiry, org.id, agentID, 'completed', now).run();

    if (result.meta.changes !== 1) {
      throw new APIError(409, 'reset_in_progress',
        'This Agent reset is in progress. Reopen its preview before retrying.');
    }

    return lease;
  }

  private async mailboxCleanup(plan: ResetPlan): Promise<void> {
    const mail = new MailTriggerClient(this.env);

    for (const mailbox of plan.mailboxes) {
      const name = 'nar-' + mailbox.agentID.replace(/-/g, '').toLowerCase();
      await mail.deleteManagedMailbox(mailbox.mailboxID, name);
    }
  }

  private async bindingCleanup(plan: ResetPlan): Promise<void> {
    for (const member of plan.members) {
      const url = 'https://mcp.agent-relay.company-notes.com/v2/management/agents/' +
        encodeURIComponent(member.agentID) + '/bindings';
      const response = await this.env.MCP_WORKER.fetch(new Request(url, {
        method: 'DELETE',
        headers: {
          authorization: this.authorization,
          origin: RelayManagementPage.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          confirmAgentID: member.agentID,
          sessionIDs: member.sessionIDs,
        }),
      }));

      if (!response.ok) {
        throw new APIError(response.status >= 400 && response.status < 500
          ? response.status : 502, 'mcp_binding_cleanup_failed',
        'Nuwa MCP could not clear the selected Agent bindings.');
      }

      const payload = await response.json() as {
        ok?: boolean; data?: { agentID?: string };
      };

      if (!payload.ok || payload.data?.agentID !== member.agentID) {
        throw new APIError(502, 'mcp_binding_cleanup_invalid',
          'Nuwa MCP did not confirm the selected Agent binding cleanup.');
      }
    }
  }

  private async clearRelay(plan: ResetPlan): Promise<void> {
    const org = plan.organizationID;
    const sessions = plan.sessionIDs;
    const agents = plan.members.map((member) => member.agentID);
    const ss = ManagementAgentReset.slots(sessions);
    const aa = ManagementAgentReset.slots(agents);
    const statements: D1PreparedStatement[] = [];
    const add = (sql: string, ...values: string[]) => {
      statements.push(this.env.DB.prepare(sql).bind(...values));
    };

    add('DELETE FROM wake_pairing_oauth_attempts WHERE pairing_id IN ' +
      '(SELECT id FROM wake_pairing_requests WHERE org_id = ? AND session_id IN (' + ss + '))',
      org, ...sessions);
    add('DELETE FROM wake_pairing_requests WHERE org_id = ? AND session_id IN (' + ss + ')',
      org, ...sessions);
    add('DELETE FROM wake_registration_attempts WHERE org_id = ? AND session_id IN (' + ss + ')',
      org, ...sessions);
    add('DELETE FROM wake_subscriptions WHERE org_id = ? AND session_id IN (' + ss + ')',
      org, ...sessions);
    add('DELETE FROM gateway_first_contacts WHERE org_id = ? AND ' +
      '(sender_session_id IN (' + ss + ') OR recipient_session_id IN (' + ss + '))',
      org, ...sessions, ...sessions);
    add('DELETE FROM gateway_conversations WHERE org_id = ? AND ' +
      '(sender_session_id IN (' + ss + ') OR recipient_session_id IN (' + ss + '))',
      org, ...sessions, ...sessions);
    add('DELETE FROM gateway_teammates WHERE org_id = ? AND ' +
      '(gateway_session_id IN (' + ss + ') OR recipient_agent_id IN (' + aa + '))',
      org, ...sessions, ...agents);
    add('DELETE FROM gateway_routes WHERE org_id = ? AND recipient_agent_id IN (' + aa + ')',
      org, ...agents);
    add('DELETE FROM gateway_office_coworkers WHERE org_id = ? AND ' +
      '(gateway_session_id IN (' + ss + ') OR recipient_agent_id IN (' + aa + '))',
      org, ...sessions, ...agents);
    add('DELETE FROM gateway_office_delegation WHERE org_id = ? AND gateway_session_id IN (' + ss + ')',
      org, ...sessions);

    for (let offset = 0; offset < plan.threadIDs.length; offset += 150) {
      const threadIDs = plan.threadIDs.slice(offset, offset + 150);
      const ids = ManagementAgentReset.slots(threadIDs);

      add('DELETE FROM wake_events WHERE message_id IN ' +
        '(SELECT id FROM messages WHERE thread_id IN (' + ids + '))', ...threadIDs);
      add('DELETE FROM gateway_first_contacts WHERE org_id = ? AND initial_message_id IN ' +
        '(SELECT id FROM messages WHERE thread_id IN (' + ids + '))', org, ...threadIDs);
      add('DELETE FROM message_read_receipts WHERE message_id IN ' +
        '(SELECT id FROM messages WHERE thread_id IN (' + ids + '))', ...threadIDs);
      add('DELETE FROM messages WHERE thread_id IN (' + ids + ')', ...threadIDs);
      add('DELETE FROM threads WHERE org_id = ? AND id IN (' + ids + ')', org, ...threadIDs);
    }

    add('DELETE FROM wake_events WHERE session_id IN (' + ss + ')', ...sessions);
    add('DELETE FROM collaboration_policies WHERE org_id = ? AND agent_id IN (' + aa + ')',
      org, ...agents);
    add('DELETE FROM agent_aliases WHERE org_id = ? AND agent_id IN (' + aa + ')',
      org, ...agents);
    add('DELETE FROM agent_mailboxes WHERE org_id = ? AND agent_id IN (' + aa + ')',
      org, ...agents);

    await this.env.DB.batch(statements);
  }

  private async purgeIdentities(plan: ResetPlan, orgID: string, targetID: string): Promise<void> {
    const current = await this.address.listAgents();
    const present = new Set(current.map((agent) => agent.id));

    for (const member of plan.members) {
      if (present.has(member.agentID)) {
        const sessions = await this.address.listSessions(member.agentID);
        const actual = ManagementAgentReset.unique(sessions.map((session) => session.id));

        if (actual.join('|') !== member.sessionIDs.join('|')) {
          throw new APIError(409, 'reset_sessions_changed',
            'Agent Sessions changed during reset; refresh and resolve the conflict.');
        }


        await this.address.purgeAgent(member.agentID);
      }

      await this.env.DB.prepare(
        'UPDATE management_agent_resets SET purged_agent_ids_json = ' +
        "json_insert(purged_agent_ids_json, '$[#]', ?) WHERE org_id = ? AND agent_id = ? AND " +
        'NOT EXISTS (SELECT 1 FROM json_each(purged_agent_ids_json) WHERE value = ?)',
      ).bind(member.agentID, orgID, targetID, member.agentID).run();
    }
  }

  async execute(
    agentID: string, confirmation: string, fingerprint: string,
  ): Promise<Record<string, unknown>> {
    const org = await this.organization();
    let job = await this.currentJob(org.id, agentID);

    if (!job) {
      const plan = await this.prepare(org, agentID);
      const actualFingerprint = await ManagementAgentReset.digest(plan);

      if (fingerprint !== actualFingerprint || confirmation !== plan.confirmation) {
        throw new APIError(409, 'reset_confirmation_changed',
          'The preview or exact confirmation has changed. Review the current Agent data again.');
      }

      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO management_agent_resets ' +
        '(org_id, agent_id, plan_json, fingerprint, stage, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(org.id, agentID, JSON.stringify(plan), actualFingerprint, 'prepared',
        new Date().toISOString()).run();
      job = await this.currentJob(org.id, agentID);
    }

    if (!job || confirmation !== (JSON.parse(job.planJSON) as ResetPlan).confirmation ||
        fingerprint !== job.fingerprint) {
      throw new APIError(409, 'reset_confirmation_changed',
        'The saved reset plan no longer matches this confirmation.');
    }

    if (job.stage === 'completed') {
      return { completed: true, ...ManagementAgentReset.summary(
        JSON.parse(job.planJSON) as ResetPlan, job.fingerprint, job.stage,
      ) };
    }

    const lease = await this.claim(org, agentID);

    try {
      const plan = JSON.parse(job.planJSON) as ResetPlan;

      if (job.stage === 'prepared') {
        await this.mailboxCleanup(plan);
        await this.bindingCleanup(plan);
        await this.clearRelay(plan);

        await this.env.DB.prepare(
          'UPDATE management_agent_resets SET stage = ? WHERE org_id = ? AND agent_id = ?',
        ).bind('relay_cleared', org.id, agentID).run();
      }

      await this.purgeIdentities(plan, org.id, agentID);
      await this.env.DB.prepare(
        'UPDATE management_agent_resets SET stage = ?, completed_at = ?, ' +
        'lease_owner = NULL, lease_until = NULL WHERE org_id = ? AND agent_id = ?',
      ).bind('completed', new Date().toISOString(), org.id, agentID).run();

      return { completed: true, ...ManagementAgentReset.summary(
        plan, job.fingerprint, 'completed',
      ) };
    } finally {
      await this.env.DB.prepare(
        'UPDATE management_agent_resets SET lease_owner = NULL, lease_until = NULL ' +
        'WHERE org_id = ? AND agent_id = ? AND lease_owner = ?',
      ).bind(org.id, agentID, lease).run();
    }
  }
}
