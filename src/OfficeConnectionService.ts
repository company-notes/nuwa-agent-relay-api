import type { Env } from './Env';
import { APIError } from './HTTP';
import { OfficeCoworkerRegistry } from './OfficeCoworkerRegistry';
import type { SessionIdentity } from './SessionIdentityClient';

type ConnectionTarget = {
  gatewaySessionID: string;
  recipientSessionID: string;
  recipientBotID: string;
  threadMode: string;
  firstContactMode: string;
  createdAt: string;
};

/** Applies explicit connection changes without changing the coworker's identity. */
export class OfficeConnectionService {
  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
  ) {}

  async joinShared(teammate: ConnectionTarget): Promise<void> {
    const { organizationID, sessionID, agentID, canonicalAddress } = this.identity;
    const { gatewaySessionID, recipientBotID, threadMode, firstContactMode, createdAt } = teammate;
    const handle = await OfficeCoworkerRegistry.handleFor(organizationID, gatewaySessionID, recipientBotID);
    const displayName = this.identity.agentDisplayName ?? canonicalAddress.split('/')[1];
    const now = new Date().toISOString();

    // All mutations require this exact pending invitation and an idle route.
    // Activate membership last, so a stale invitation cannot grant office voice.
    const eligible = `EXISTS (
      SELECT 1 FROM gateway_teammates t
       WHERE t.org_id = ? AND t.recipient_session_id = ? AND t.gateway_session_id = ?
         AND t.recipient_bot_id = ? AND t.thread_mode = ? AND t.first_contact_mode = ?
         AND t.created_at = ? AND t.status = 'pending'
         AND EXISTS (SELECT 1 FROM wake_subscriptions w
           WHERE w.org_id = t.org_id AND w.session_id = t.gateway_session_id)
         AND NOT EXISTS (SELECT 1 FROM gateway_teammates d
           WHERE d.org_id = t.org_id AND d.gateway_session_id = t.recipient_session_id AND d.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM wake_events e
           WHERE e.session_id = t.recipient_session_id AND e.status = 'pending' AND e.lease_until > ?)
         AND NOT EXISTS (SELECT 1 FROM gateway_routes r
           WHERE r.org_id = t.org_id AND r.recipient_session_id = t.recipient_session_id
             AND (r.recipient_agent_id <> t.recipient_agent_id OR
               r.recipient_bot_id <> t.recipient_bot_id OR r.thread_mode <> t.thread_mode OR
               r.first_contact_mode <> t.first_contact_mode))
         AND NOT EXISTS (SELECT 1 FROM gateway_office_coworkers c
           WHERE c.org_id = t.org_id AND c.gateway_session_id = t.gateway_session_id
             AND c.recipient_bot_id = t.recipient_bot_id
             AND (c.recipient_session_id IS NULL OR c.recipient_session_id <> t.recipient_session_id OR
               c.recipient_agent_id <> t.recipient_agent_id))
    )`;
    const args = [organizationID, sessionID, gatewaySessionID, recipientBotID,
      threadMode, firstContactMode, createdAt, now];

    const [, , , , registry, membership] = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM wake_events WHERE session_id = ? AND status = 'pending' AND ${eligible}`,
      ).bind(sessionID, ...args),
      this.env.DB.prepare(
        `DELETE FROM wake_registration_attempts WHERE org_id = ? AND session_id = ? AND ${eligible}`,
      ).bind(organizationID, sessionID, ...args),
      this.env.DB.prepare(
        `DELETE FROM wake_subscriptions WHERE org_id = ? AND session_id = ? AND ${eligible}`,
      ).bind(organizationID, sessionID, ...args),
      this.env.DB.prepare(
        `INSERT INTO gateway_routes
           (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
            recipient_bot_id, thread_mode, first_contact_mode, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${eligible}
         ON CONFLICT(org_id, recipient_session_id) DO UPDATE SET recipient_canonical_address = excluded.recipient_canonical_address`,
      ).bind(organizationID, agentID, sessionID, canonicalAddress,
        recipientBotID, threadMode, firstContactMode, now, ...args),
      this.env.DB.prepare(
        `INSERT INTO gateway_office_coworkers
           (org_id, gateway_session_id, recipient_bot_id, agent_handle, display_name,
            recipient_agent_id, recipient_session_id, recipient_canonical_address, created_at, activated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${eligible}
         ON CONFLICT(org_id, gateway_session_id, recipient_bot_id) DO UPDATE SET
           display_name = excluded.display_name, activated_at = excluded.activated_at,
           recipient_canonical_address = excluded.recipient_canonical_address,
           independent_at = NULL, removed_at = NULL`,
      ).bind(organizationID, gatewaySessionID, recipientBotID, handle, displayName,
        agentID, sessionID, canonicalAddress, now, now, ...args),
      this.env.DB.prepare(
        `UPDATE gateway_teammates SET status = 'active', approved_at = ?, recipient_canonical_address = ?
          WHERE org_id = ? AND recipient_session_id = ? AND ${eligible}`,
      ).bind(now, canonicalAddress, organizationID, sessionID, ...args),
    ]);

    if (registry.meta.changes !== 1 || membership.meta.changes !== 1) {
      throw new APIError(409, 'office_connection_conflict',
        'The invitation, existing native route or receiving activity prevents this connection change.');
    }
  }

  async leaveShared(teammate: ConnectionTarget, gatewayOwned: boolean): Promise<void> {
    const now = new Date().toISOString();
    const { recipientSessionID, gatewaySessionID, recipientBotID, createdAt } = teammate;
    const scope = [this.identity.organizationID, recipientSessionID];
    const messageIDs = `SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.org_id = ? AND COALESCE(m.recipient_session_id, t.accepted_session_id,
        t.notification_session_id) = ?`;
    const eligible = `EXISTS (
      SELECT 1 FROM gateway_teammates g
       WHERE g.org_id = ? AND g.recipient_session_id = ? AND g.gateway_session_id = ?
         AND g.recipient_bot_id = ? AND g.created_at = ? AND g.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM wake_events e
           WHERE e.session_id = g.gateway_session_id AND e.status = 'pending'
             AND e.lease_until > ? AND e.message_id IN (${messageIDs}))
    )`;
    const args = [...scope, gatewaySessionID, recipientBotID, createdAt, now, ...scope];

    // A recipient's independent choice preserves its native mapping. An office
    // removal revokes the Gateway-owned mapping. Undelivered notifications
    // remain readable as messages in the recipient's Inbox.
    const statements = [
      this.env.DB.prepare(
        `DELETE FROM wake_events WHERE session_id = ? AND status = 'pending'
          AND message_id IN (${messageIDs}) AND ${eligible}`,
      ).bind(gatewaySessionID, ...scope, ...args),
    ];

    if (gatewayOwned) {
      statements.push(this.env.DB.prepare(
        `DELETE FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?
          AND recipient_bot_id = ? AND ${eligible}`,
      ).bind(...scope, recipientBotID, ...args));
    }

    statements.push(
      this.env.DB.prepare(
        `UPDATE gateway_office_coworkers SET activated_at = NULL, independent_at = ?, removed_at = ?
          WHERE org_id = ? AND recipient_session_id = ? AND gateway_session_id = ?
            AND ${eligible}`,
      ).bind(gatewayOwned ? null : now, gatewayOwned ? now : null,
        ...scope, gatewaySessionID, ...args),
      this.env.DB.prepare(
        `DELETE FROM gateway_teammates WHERE org_id = ? AND recipient_session_id = ? AND ${eligible}`,
      ).bind(...scope, ...args),
    );

    const results = await this.env.DB.batch(statements);

    if (results.at(-1)?.meta.changes !== 1) {
      throw new APIError(409, 'office_connection_conflict',
        'The coworker route is changing or a Wake is in flight. Retry the management operation later.');
    }
  }
}
