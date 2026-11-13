import type { Env } from './Env';
import { APIError } from './HTTP';
import { GatewayFirstContactStatus, GatewayModeCodec } from './GatewayModeCodec';

type FirstContactRow = {
  messageID: string;
  status: GatewayFirstContactStatus;
  nativeThreadID: string | null;
};

/**
 * First-contact handshakes are scoped to a recipient's authorized Session.
 * A reserved native conversation must never be silently recreated on retry.
 */
export class GatewayFirstContacts {
  constructor(
    private readonly env: Env,
    private readonly organizationID: string,
    private readonly recipientSessionID: string,
  ) {}

  private statement() {
    return this.env.DB.prepare(
      `SELECT initial_message_id AS messageID, status,
              native_thread_id AS nativeThreadID
         FROM gateway_first_contacts
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?`,
    );
  }

  async get(senderSessionID: string): Promise<FirstContactRow | null> {
    const row = await this.statement().bind(this.organizationID, senderSessionID,
      this.recipientSessionID).first<Omit<FirstContactRow, 'status'> & { status: string }>();

    return row ? {
      ...row,
      status: GatewayModeCodec.readFirstContactStatus(row.status),
    } : null;
  }

  async pending(): Promise<{ senderSessionID: string; messageID: string; createdAt: string }[]> {
    const result = await this.env.DB.prepare(
      `SELECT sender_session_id AS senderSessionID,
              initial_message_id AS messageID, created_at AS createdAt
         FROM gateway_first_contacts
        WHERE org_id = ? AND recipient_session_id = ? AND status = 'pending'
        ORDER BY created_at, sender_session_id`,
    ).bind(this.organizationID, this.recipientSessionID)
      .all<{ senderSessionID: string; messageID: string; createdAt: string }>();

    return result.results;
  }

  /**
   * Exactly one verified Relay Message may request creation for a sender pair.
   * Even a retry of that Message is blocked until the authorized recipient
   * confirms or explicitly resets the reservation: duplicate UI chats are worse
   * than operator-visible delivery delay.
   */
  static async reserve(
    env: Env, organizationID: string, senderSessionID: string,
    recipientSessionID: string, messageID: string,
  ): Promise<void> {
    const created = await env.DB.prepare(
      `INSERT OR IGNORE INTO gateway_first_contacts
         (org_id, sender_session_id, recipient_session_id, initial_message_id,
          status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).bind(organizationID, senderSessionID, recipientSessionID, messageID,
      new Date().toISOString()).run();

    if (created.meta.changes !== 1) {
      throw new APIError(409, 'gateway_first_contact_pending',
        'A native conversation is already being initialized for this sender. Wait for confirmation.');
    }
  }

  /** Only the recipient's authenticated Runtime may supply the native Thread ID. */
  async confirm(senderSessionID: string, messageID: string, nativeThreadID: string) {
    const first = await this.get(senderSessionID);

    if (!first || first.messageID !== messageID) {
      throw new APIError(409, 'gateway_first_contact_mismatch',
        'No matching first-contact reservation exists for this Message and sender.');
    }

    if (first.status === GatewayFirstContactStatus.Completed) {
      if (first.nativeThreadID !== nativeThreadID) {
        throw new APIError(409, 'gateway_first_contact_conflict',
          'First contact was already confirmed with a different native Thread.');
      }

      await this.releaseWakes(senderSessionID, messageID);

      return { senderSessionID, recipientSessionID: this.recipientSessionID,
        nativeThreadID, alreadyConfirmed: true };
    }

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO gateway_conversations
         (org_id, sender_session_id, recipient_session_id, native_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(this.organizationID, senderSessionID, this.recipientSessionID,
      nativeThreadID, new Date().toISOString()).run();

    const stored = await this.env.DB.prepare(
      `SELECT native_thread_id AS nativeThreadID FROM gateway_conversations
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?`,
    ).bind(this.organizationID, senderSessionID, this.recipientSessionID)
      .first<{ nativeThreadID: string }>();

    if (stored?.nativeThreadID !== nativeThreadID) {
      throw new APIError(409, 'gateway_first_contact_conflict',
        'Another native Thread is already bound to this sender; it was not replaced.');
    }

    const completed = await this.env.DB.prepare(
      `UPDATE gateway_first_contacts SET status = 'completed', native_thread_id = ?
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?
          AND initial_message_id = ? AND status = 'pending'`,
    ).bind(nativeThreadID, this.organizationID, senderSessionID,
      this.recipientSessionID, messageID).run();

    if (completed.meta.changes !== 1) {
      const current = await this.get(senderSessionID);

      if (current?.status !== GatewayFirstContactStatus.Completed ||
          current.nativeThreadID !== nativeThreadID) {
        throw new APIError(409, 'gateway_first_contact_conflict',
          'The native Thread confirmation changed during submission.');
      }
    }

    await this.releaseWakes(senderSessionID, messageID);

    return { senderSessionID, recipientSessionID: this.recipientSessionID,
      nativeThreadID, alreadyConfirmed: false };
  }

  private async releaseWakes(senderSessionID: string, messageID: string): Promise<void> {
    // A shared Gateway owns the Wake, but the Message identifies its actual
    // sender and recipient. Release the pair in one scoped D1 update without
    // constructing an unverified batch from a separate candidate query.
    const now = new Date().toISOString();
    const pairMessages = `SELECT m.id FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE t.org_id = ? AND m.sender_session_id = ?
        AND m.recipient_session_id = ? AND m.received_at IS NOT NULL`;

    // D1 batch applies the initial receipt, the pair-scoped release, and
    // its verification in one transaction. Cron cannot acquire a fresh lease
    // between release and the verification query.
    const outcomes = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE wake_events SET status = 'delivered', notified_at = ?,
                last_error = NULL, lease_owner = NULL, lease_until = NULL
          WHERE message_id = ? AND status IN ('pending', 'failed')`,
      ).bind(now, messageID),
      this.env.DB.prepare(
        `UPDATE wake_events SET next_attempt_at = ?, last_error = NULL,
                lease_owner = NULL, lease_until = NULL
          WHERE status = 'pending' AND message_id <> ?
            AND message_id IN (${pairMessages})`,
      ).bind(now, messageID, this.organizationID,
        senderSessionID, this.recipientSessionID),
      this.env.DB.prepare(
        `SELECT e.message_id FROM wake_events e
          WHERE e.status = 'pending' AND e.message_id <> ?
            AND e.message_id IN (${pairMessages})
            AND (e.next_attempt_at > ? OR e.lease_owner IS NOT NULL
              OR e.lease_until IS NOT NULL)
          LIMIT 1`,
      ).bind(messageID, this.organizationID, senderSessionID,
        this.recipientSessionID, now),
    ]);
    const blocked = outcomes[2].results.length > 0;
    if (blocked) {
      throw new APIError(503, 'gateway_wake_release_incomplete',
        'The native conversation was confirmed, but a waiting Wake is still leased.');
    }
  }

  /** Explicit operator recovery if a bootstrap event may have been lost. */
  async cancel(senderSessionID: string) {
    const removed = await this.env.DB.prepare(
      `DELETE FROM gateway_first_contacts
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?
          AND status = 'pending'`,
    ).bind(this.organizationID, senderSessionID, this.recipientSessionID).run();

    return { removed: removed.meta.changes === 1 };
  }

  async clear(senderSessionID: string): Promise<void> {
    await this.env.DB.prepare(
      `DELETE FROM gateway_first_contacts
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?`,
    ).bind(this.organizationID, senderSessionID, this.recipientSessionID).run();
  }
}
