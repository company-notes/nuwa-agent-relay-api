import type { Env } from './Env';
import { APIError } from './HTTP';

export type HandoffAcceptanceInput = {
  threadID: string;
  organizationID: string;
  acceptingAgentID: string;
  acceptingSessionID: string;
  acceptingCanonicalAddress: string;
  senderAgentID: string;
  senderSessionID: string;
};

export type HandoffAcceptanceResult = {
  messageID: string;
  notificationStatus: 'pending' | 'sent' | 'failed';
  created: boolean;
};

/**
 * Commits a Session's exclusive Handoff ownership and its notification outbox
 * in one real D1 transaction. An uncertain SMTP acknowledgement never
 * authorizes a second Session to accept or a duplicate notification send.
 */
export class HandoffAcceptance {
  static readonly SUBJECT = 'Agent Relay handoff accepted';

  constructor(private readonly env: Env) {}

  static body(canonicalAddress: string): string {
    return 'Accepted by ' + canonicalAddress + '.';
  }

  async reserve(input: HandoffAcceptanceInput): Promise<HandoffAcceptanceResult> {
    const messageID = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const [claim, notification] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE threads SET accepted_session_id = ?
           WHERE id = ? AND org_id = ? AND accepted_session_id IS NULL`,
      ).bind(input.acceptingSessionID, input.threadID, input.organizationID),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO messages
           (id, thread_id, kind, sender_agent_id, sender_session_id,
            recipient_agent_id, recipient_session_id, subject, body,
            artifacts_json, delivery_status, created_at)
         SELECT ?, t.id, 'acceptance', ?, ?, t.sender_agent_id, t.sender_session_id,
                ?, ?, '[]', 'pending', ?
           FROM threads t
          WHERE t.id = ? AND t.org_id = ? AND t.accepted_session_id = ?`,
      ).bind(messageID, input.acceptingAgentID, input.acceptingSessionID,
        HandoffAcceptance.SUBJECT, HandoffAcceptance.body(input.acceptingCanonicalAddress),
        createdAt, input.threadID, input.organizationID, input.acceptingSessionID),
    ]);

    const current = await this.env.DB.prepare(
      `SELECT t.accepted_session_id AS acceptedSessionID,
              m.id AS messageID, m.delivery_status AS notificationStatus
         FROM threads t
         LEFT JOIN messages m ON m.thread_id = t.id AND m.kind = 'acceptance'
        WHERE t.id = ? AND t.org_id = ?`,
    ).bind(input.threadID, input.organizationID)
      .first<{
        acceptedSessionID: string | null;
        messageID: string | null;
        notificationStatus: 'pending' | 'sent' | 'failed' | null;
      }>();

    if (!current || current.acceptedSessionID !== input.acceptingSessionID) {
      throw new APIError(409, 'handoff_already_accepted',
        'Another Session accepted the handoff.');
    }

    if (!current.messageID || !current.notificationStatus ||
        (claim.meta.changes === 1 && notification.meta.changes !== 1)) {
      throw new APIError(500, 'handoff_notification_missing',
        'Handoff ownership must have one durable acceptance notification.');
    }

    return {
      messageID: current.messageID,
      notificationStatus: current.notificationStatus,
      created: notification.meta.changes === 1,
    };
  }
}
