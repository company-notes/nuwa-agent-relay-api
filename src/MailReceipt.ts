import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';
import { MailTriggerClient } from './MailTriggerClient';

type IncomingReceipt = {
  from: string;
  receiver: string;
  subject: string;
};

export class MailReceipt {
  private static readonly SUBJECT_PATTERN = /^\[NAR:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

  constructor(private readonly env: Env) {}

  private static parsePayload(data: Record<string, unknown>): IncomingReceipt {
    // The MailTrigger Webhook Action must be explicitly configured to send
    // {"from":"$SENDER","receiver":"$RECEIVERS","subject":"$SUBJECT"}.
    const from = HTTP.requiredString(data, 'from', 320).toLowerCase();
    const receiver = HTTP.requiredString(data, 'receiver', 320).toLowerCase();
    const subject = HTTP.requiredString(data, 'subject', 512);

    if (!/^\S+@\S+\.\S+$/.test(from) || !/^\S+@\S+\.\S+$/.test(receiver)) {
      throw new APIError(400, 'invalid_receipt', 'Receipt requires single sender and receiver email addresses.');
    }

    return { from, receiver, subject };
  }

  async receive(request: Request): Promise<Response> {
    const expectedKey = this.env.MAILTRIGGER_INBOUND_KEY;

    if (!expectedKey) {
      throw new APIError(503, 'inbound_unconfigured', 'Inbound MailTrigger receipt is not configured.');
    }

    const provided = request.headers.get('x-relay-inbound-key');

    // Non-secret response, and fixed comparison length is used to avoid
    // distinguishing valid prefixes (a MailTrigger key is high entropy).
    if (!provided || provided.length !== expectedKey.length) {
      throw new APIError(401, 'invalid_inbound_key', 'Invalid inbound webhook credential.');
    }

    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(expectedKey);
    let difference = 0;

    for (let index = 0; index < a.length; index += 1) {
      difference |= a[index] ^ b[index];
    }

    if (difference !== 0) {
      throw new APIError(401, 'invalid_inbound_key', 'Invalid inbound webhook credential.');
    }

    if (Number(request.headers.get('content-length') ?? '0') > 8192) {
      throw new APIError(413, 'receipt_too_large', 'Inbound receipt exceeds 8 KiB.');
    }

    const raw = await request.text();

    if (raw.length > 8192) {
      throw new APIError(413, 'receipt_too_large', 'Inbound receipt exceeds 8 KiB.');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new APIError(400, 'invalid_json', 'Inbound receipt must be JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new APIError(400, 'invalid_receipt', 'Inbound receipt must be a JSON object.');
    }

    const { from, receiver, subject } = MailReceipt.parsePayload(parsed as Record<string, unknown>);
    const match = subject.match(MailReceipt.SUBJECT_PATTERN);

    // Acknowledge unrelated email without admitting it into the authenticated
    // Agent-to-Agent D1 protocol. External email ingestion is a separate feature.
    if (!match) {
      return HTTP.response({ matched: false });
    }

    const messageId = match[1].toLowerCase();
    const result = await this.env.DB.prepare(
      `SELECT m.id, m.received_at AS receivedAt,
              sender.mailbox_email AS senderEmail,
              recipient.mailbox_email AS recipientEmail
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN paired_hosts sender ON sender.org_id = t.org_id
                                 AND sender.host_address_id = m.sender_host_id
         JOIN paired_hosts recipient ON recipient.org_id = t.org_id
                                    AND recipient.host_address_id = m.recipient_host_id
        WHERE m.id = ? AND m.delivery_status = 'sent'`,
    ).bind(messageId).first<{
      id: string;
      receivedAt: string | null;
      senderEmail: string;
      recipientEmail: string;
    }>();

    if (!result ||
      result.senderEmail.toLowerCase() !== from ||
      result.recipientEmail.toLowerCase() !== receiver) {
      // Do not allow external emails with a forged subject to mark delivery.
      return HTTP.response({ matched: false });
    }

    await MailReceipt.confirmArrival(this.env, messageId, 'webhook');

    return HTTP.response({ matched: true, messageId, duplicate: Boolean(result.receivedAt) });
  }


  /**
   * Confirm a MailTrigger-side arrival without treating a send-API 201 as
   * evidence. Updating the receipt and queuing a subscribed Work's wake are
   * one D1 transaction; a late subscription cannot replay old messages.
   */
  static async confirmArrival(
    env: Env, messageId: string, source: 'webhook' | 'archive',
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const outcomes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET received_at = ?, receipt_source = ?
          WHERE id = ? AND delivery_status = 'sent' AND received_at IS NULL`,
      ).bind(now, source, messageId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO wake_events (message_id, work_address_id, next_attempt_at)
         SELECT m.id, s.work_address_id, ?
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN wake_subscriptions s
             ON s.work_address_id = COALESCE(m.recipient_work_id, t.accepted_work_id)
          WHERE m.id = ? AND m.received_at IS NOT NULL
            AND s.created_at <= m.received_at`,
      ).bind(now, messageId),
    ]);

    return outcomes[0].meta.changes === 1;
  }

  /**
   * The original ReleaseBot queried recipient MailTrigger Archives on Inbox.
   * This bounded Cron reconciliation restores that independent evidence, so
   * a configured MailTrigger inbound webhook is optional (but faster).
   * Unmatched or unarchived mail never triggers a Wake.
   */
  static async reconcileArchives(env: Env): Promise<void> {
    if (!env.MAILTRIGGER_API_TOKEN) {
      return;
    }

    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const earliest = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const pending = await env.DB.prepare(
      `SELECT m.id AS messageId, recipient.mailbox_id AS mailboxId
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN paired_hosts recipient
           ON recipient.org_id = t.org_id AND recipient.host_address_id = m.recipient_host_id
        WHERE m.delivery_status = 'sent' AND m.received_at IS NULL
          AND m.created_at >= ?
          AND (m.archive_checked_at IS NULL OR m.archive_checked_at < ?)
        ORDER BY COALESCE(m.archive_checked_at, ''), m.created_at
        LIMIT 25`,
    ).bind(earliest, cutoff).all<{ messageId: string; mailboxId: string }>();

    const groups = new Map<string, string[]>();

    for (const item of pending.results) {
      groups.set(item.mailboxId, [...(groups.get(item.mailboxId) || []), item.messageId]);
    }

    const provider = new MailTriggerClient(env);

    for (const [mailboxId, ids] of groups) {
      let archived: Set<string>;

      try {
        archived = await provider.archivedProtocolMessageIds(mailboxId);
      } catch {
        // No false-positive receipt and no aborted retry cycle if a provider
        // mailbox is unavailable. The next Cron will try the same IDs again.
        console.warn('MailTrigger archive reconciliation failed for a mailbox.');
        continue;
      }

      for (const messageId of ids) {
        await env.DB.prepare(
          'UPDATE messages SET archive_checked_at = ? WHERE id = ? AND received_at IS NULL',
        ).bind(new Date().toISOString(), messageId).run();

        if (archived.has(messageId.toLowerCase())) {
          await MailReceipt.confirmArrival(env, messageId, 'archive');
        }
      }
    }
  }

  async status(messageId: string, organizationId: string, workId: string): Promise<Response> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.delivery_status AS deliveryStatus,
              m.received_at AS receivedAt, m.receipt_source AS receiptSource
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ?
          AND (t.sender_work_id = ? OR t.recipient_work_id = ? OR t.accepted_work_id = ?)`,
    ).bind(messageId, organizationId, workId, workId, workId).first<{
      id: string;
      deliveryStatus: string;
      receivedAt: string | null;
      receiptSource: 'archive' | 'webhook' | null;
    }>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Message does not belong to this work identity.');
    }

    const read = await this.env.DB.prepare(
      `SELECT work_address_id AS workAddressId, read_at AS readAt
         FROM message_read_receipts WHERE message_id = ? ORDER BY read_at`,
    ).bind(messageId).all<{ workAddressId: string; readAt: string }>();

    return HTTP.response({
      messageId: row.id,
      submissionStatus: row.deliveryStatus,
      arrivedInMailTrigger: row.receivedAt !== null,
      receivedAt: row.receivedAt,
      receiptSource: row.receiptSource,
      readBy: read.results,
    });
  }
}
