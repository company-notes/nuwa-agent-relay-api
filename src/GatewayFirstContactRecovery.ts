import type { Env } from './Env';
import { APIError } from './HTTP';

type PendingContact = {
  senderSessionID: string;
  recipientSessionID: string;
  senderCanonicalAddress: string;
  recipientCanonicalAddress: string;
  initialMessageID: string;
  createdAt: string;
  initialWakeAttempts: number;
  initialWakeError: string | null;
};

/**
 * Recover an explicit native conversation bootstrap only after the owning
 * Gateway operator confirms no native conversation was created.
 *
 * The original Relay Message and queued Wake are retained: normal delivery
 * is responsible for creating and confirming the first native Thread.
 */
export class GatewayFirstContactRecovery {
  constructor(
    private readonly env: Env,
    private readonly organizationID: string,
    private readonly gatewaySessionID: string,
  ) {}

  async pending(): Promise<PendingContact[]> {
    const result = await this.env.DB.prepare(
      `SELECT f.sender_session_id AS senderSessionID,
              f.recipient_session_id AS recipientSessionID,
              m.sender_canonical_address AS senderCanonicalAddress,
              r.recipient_canonical_address AS recipientCanonicalAddress,
              f.initial_message_id AS initialMessageID, f.created_at AS createdAt,
              e.attempts AS initialWakeAttempts,
              e.last_error AS initialWakeError
         FROM gateway_first_contacts f
         JOIN gateway_teammates t ON t.org_id = f.org_id
           AND t.recipient_session_id = f.recipient_session_id
         JOIN gateway_routes r ON r.org_id = f.org_id
           AND r.recipient_session_id = f.recipient_session_id
         JOIN messages m ON m.id = f.initial_message_id
         JOIN wake_events e ON e.message_id = f.initial_message_id
           AND e.session_id = t.gateway_session_id
         LEFT JOIN gateway_conversations c ON c.org_id = f.org_id
           AND c.sender_session_id = f.sender_session_id
           AND c.recipient_session_id = f.recipient_session_id
        WHERE f.org_id = ? AND t.gateway_session_id = ?
          AND t.status = 'active' AND f.status = 'pending'
          AND f.native_thread_id IS NULL AND c.native_thread_id IS NULL
          AND r.thread_mode = 'explicit' AND r.first_contact_mode = 'automatic'
          AND e.status = 'pending' AND e.attempts > 0 AND e.notified_at IS NULL
        ORDER BY f.created_at`,
    ).bind(this.organizationID, this.gatewaySessionID).all<PendingContact>();

    return result.results;
  }

  private async priorityTime(senderSessionID: string, recipientSessionID: string): Promise<string> {
    const row = await this.env.DB.prepare(
      `SELECT MIN(e.next_attempt_at) AS earliestDue
         FROM wake_events e
         JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND e.session_id = ?
          AND m.sender_session_id = ? AND m.recipient_session_id = ?
          AND e.status = 'pending'`,
    ).bind(this.organizationID, this.gatewaySessionID,
      senderSessionID, recipientSessionID).first<{ earliestDue: string | null }>();

    const earliest = row?.earliestDue ? Date.parse(row.earliestDue) : NaN;
    if (!Number.isFinite(earliest)) {
      throw new APIError(409, 'first_contact_queue_missing',
        'No pending Wake remains for this sender and coworker.');
    }

    return new Date(Math.min(Date.now(), earliest) - 1000).toISOString();
  }

  async recover(senderSessionID: string, recipientSessionID: string,
                initialMessageID: string): Promise<{ recovered: boolean; initialMessageID: string }> {
    const candidate = (await this.pending()).find((entry) =>
      entry.senderSessionID === senderSessionID &&
      entry.recipientSessionID === recipientSessionID &&
      entry.initialMessageID === initialMessageID);
    if (!candidate) {
      throw new APIError(409, 'first_contact_not_recoverable',
        'This contact is not a failed, undelivered native first contact.');
    }

    const retryAt = await this.priorityTime(senderSessionID, recipientSessionID);

    // CAS: exact original message, approved teammate, pending undelivered Wake
    // and no bound native conversation must all still hold at deletion time.
    const result = await this.env.DB.prepare(
      `DELETE FROM gateway_first_contacts
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?
          AND initial_message_id = ? AND status = 'pending'
          AND native_thread_id IS NULL
          AND EXISTS (
            SELECT 1 FROM gateway_teammates t
              JOIN gateway_routes r ON r.org_id = t.org_id
                AND r.recipient_session_id = t.recipient_session_id
             WHERE t.org_id = gateway_first_contacts.org_id
               AND t.recipient_session_id = gateway_first_contacts.recipient_session_id
               AND t.gateway_session_id = ? AND t.status = 'active'
               AND r.thread_mode = 'explicit' AND r.first_contact_mode = 'automatic'
          )
          AND EXISTS (
            SELECT 1 FROM wake_events e
             WHERE e.message_id = gateway_first_contacts.initial_message_id
               AND e.session_id = ? AND e.status = 'pending'
               AND e.attempts > 0 AND e.notified_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM gateway_conversations c
             WHERE c.org_id = gateway_first_contacts.org_id
               AND c.sender_session_id = gateway_first_contacts.sender_session_id
               AND c.recipient_session_id = gateway_first_contacts.recipient_session_id
          )`,
    ).bind(this.organizationID, senderSessionID, recipientSessionID,
      initialMessageID, this.gatewaySessionID, this.gatewaySessionID).run();

    if (result.meta.changes !== 1) {
      throw new APIError(409, 'first_contact_changed',
        'Another operator already changed this first contact. Refresh the page.');
    }

    // Resume exactly the original failed Wake, ahead of later queued messages.
    await this.env.DB.prepare(
      `UPDATE wake_events
          SET next_attempt_at = ?, last_error = NULL,
              lease_owner = NULL, lease_until = NULL
        WHERE message_id = ? AND session_id = ?
          AND status = 'pending' AND notified_at IS NULL`,
    ).bind(retryAt, initialMessageID, this.gatewaySessionID).run();

    return { recovered: true, initialMessageID };
  }
}
