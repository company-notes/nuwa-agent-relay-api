import type { Env } from './Env';
import { APIError, type JSONRecord } from './HTTP';
import { Logger } from './Logger';
import { MessageDelivery, type DeliveryResult } from './MessageDelivery';

type SubmissionRow = {
  id: string;
  threadId: string;
  deliveryStatus: string;
  fingerprint: string | null;
  claimedAt: string | null;
  uncertainAt: string | null;
};

export class MessageOutbox {
  private static readonly logger = Logger.forModule('relay.message_outbox');
  private static readonly PROVIDER_TIMEOUT_MS = 15_000;
  private static readonly ABANDONED_AFTER_MS = 30_000;
  private readonly delivery: MessageDelivery;

  constructor(private readonly env: Env) {
    this.delivery = new MessageDelivery(env);
  }

  static submissionID(data: JSONRecord): string | undefined {
    if (data.submissionID === undefined) {
      return undefined;
    }

    if (typeof data.submissionID !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.submissionID)) {
      throw new APIError(400, 'invalid_submission_id', 'submissionID must be a version 4 UUID.');
    }

    return data.submissionID.toLowerCase();
  }

  static async fingerprint(values: unknown[]): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    const hash = await crypto.subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static status(row: { deliveryStatus: string; claimedAt: string | null; uncertainAt: string | null }): string {
    if (row.deliveryStatus === 'sent') {
      return 'accepted';
    }

    if (!row.claimedAt) {
      return 'queued';
    }

    return row.uncertainAt || Date.parse(row.claimedAt) <= Date.now() - MessageOutbox.ABANDONED_AFTER_MS
      ? 'uncertain' : 'submitting';
  }

  async existing(id: string, fingerprint: string): Promise<DeliveryResult | null> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.thread_id AS threadId, m.delivery_status AS deliveryStatus,
              q.fingerprint, q.claimed_at AS claimedAt, q.uncertain_at AS uncertainAt
         FROM messages m LEFT JOIN message_submissions q ON q.message_id = m.id
        WHERE m.id = ?`,
    ).bind(id).first<SubmissionRow>();

    if (!row) {
      return null;
    }

    if (row.fingerprint !== fingerprint) {
      throw new APIError(409, 'submission_id_conflict', 'The submission ID cannot be reused for another request.');
    }

    return {
      id: row.id, threadId: row.threadId, messageId: row.id,
      submissionStatus: row.deliveryStatus, outboxStatus: MessageOutbox.status(row),
    };
  }

  prepare(id: string, fingerprint: string): D1PreparedStatement {
    return this.env.DB.prepare(
      'INSERT INTO message_submissions (message_id, fingerprint) VALUES (?, ?)',
    ).bind(id, fingerprint);
  }

  async dispatch(id: string): Promise<void> {
    try {
      await this.dispatchQueued(id);
    } catch (error) {
      MessageOutbox.logger.exception('submission_dispatch_failed', error, { messageID: id });
    }
  }

  private async dispatchQueued(id: string): Promise<void> {
    const queued = await this.env.DB.prepare(
      `SELECT q.message_id FROM message_submissions q JOIN messages m ON m.id = q.message_id
        WHERE q.message_id = ? AND q.claimed_at IS NULL AND m.delivery_status = 'pending'`,
    ).bind(id).first();

    if (!queued) {
      return;
    }

    const record = await this.delivery.load(id);
    const claim = await this.env.DB.prepare(
      `UPDATE message_submissions SET claimed_at = ?
        WHERE message_id = ? AND claimed_at IS NULL
          AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND delivery_status = 'pending')`,
    ).bind(new Date().toISOString(), id, id).run();

    if (claim.meta.changes !== 1) {
      return;
    }

    try {
      await this.delivery.submit(record, MessageOutbox.PROVIDER_TIMEOUT_MS);
    } catch (error) {
      // The provider may still finish after the caller loses its connection.
      // Never replay a claimed submission without provider-side idempotency.
      MessageOutbox.logger.exception('provider_acknowledgement_uncertain', error, { messageID: id });
      await this.env.DB.prepare(
        'UPDATE message_submissions SET uncertain_at = ? WHERE message_id = ?',
      ).bind(new Date().toISOString(), id).run();
    }
  }

  async dispatchDue(): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT q.message_id AS id FROM message_submissions q JOIN messages m ON m.id = q.message_id
        WHERE q.claimed_at IS NULL AND m.delivery_status = 'pending'
        ORDER BY m.created_at, m.id LIMIT 20`,
    ).all<{ id: string }>();

    await Promise.all(rows.results.map((row) => this.dispatch(row.id)));
  }
}
