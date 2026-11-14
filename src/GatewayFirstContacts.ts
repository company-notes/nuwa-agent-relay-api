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
    // Queue ownership can belong to a shared Gateway. Identify pending Wakes
    // using the immutable, received Message's actual sender and recipient.
    const pending = await this.env.DB.prepare(
      `SELECT e.message_id AS messageID
         FROM wake_events e
         JOIN messages m ON m.id = e.message_id
         JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND m.sender_session_id = ?
          AND m.recipient_session_id = ? AND m.received_at IS NOT NULL
          AND e.message_id <> ? AND e.status = 'pending'`,
    ).bind(this.organizationID, senderSessionID, this.recipientSessionID, messageID)
      .all<{ messageID: string }>();

    const now = new Date().toISOString();
    const releases = pending.results.map(({ messageID: pendingID }) =>
      this.env.DB.prepare(
        `UPDATE wake_events
            SET next_attempt_at = ?, last_error = NULL,
                lease_owner = NULL, lease_until = NULL
          WHERE message_id = ? AND status = 'pending'`,
      ).bind(now, pendingID));
    const verifications = pending.results.map(({ messageID: pendingID }) =>
      this.env.DB.prepare(
        `SELECT status, next_attempt_at AS nextAttempt,
                lease_owner AS leaseOwner, lease_until AS leaseUntil
           FROM wake_events WHERE message_id = ?`,
      ).bind(pendingID));

    // D1 executes each statement in one transaction. Capture the update
    // results instead of trusting an HTTP 200 to mean leases were released.
    const outcomes = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE wake_events SET status = 'delivered', notified_at = ?,
                last_error = NULL, lease_owner = NULL, lease_until = NULL
          WHERE message_id = ? AND status IN ('pending', 'failed')`,
      ).bind(now, messageID),
      ...releases,
      ...verifications,
    ]);

    for (let index = 0; index < pending.results.length; index += 1) {
      const updated = outcomes[index + 1];
      const row = outcomes[index + 1 + pending.results.length]
        .results[0] as {
          status: string; nextAttempt: string;
          leaseOwner: string | null; leaseUntil: string | null;
        } | undefined;

      if (updated.meta.changes !== 1 || !row ||
          row.status !== 'pending' || row.nextAttempt > now ||
          row.leaseOwner !== null || row.leaseUntil !== null) {
        throw new APIError(503, 'gateway_wake_release_incomplete',
          'A matching pending Wake could not be released after native Thread confirmation.');
      }
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
