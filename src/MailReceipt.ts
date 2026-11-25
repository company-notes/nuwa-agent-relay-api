import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';
import { InboxEvents } from './InboxEvents';
import { MailTriggerClient } from './MailTriggerClient';
import { Logger } from './Logger';

type IncomingReceipt = {
  from: string;
  receiver: string;
  subject: string;
};

export class MailReceipt {
  private static readonly logger = Logger.forModule('mail.receipt');
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
         JOIN agent_mailboxes sender ON sender.org_id = t.org_id
                                 AND sender.agent_id = m.sender_agent_id
         JOIN agent_mailboxes recipient ON recipient.org_id = t.org_id
                                    AND recipient.agent_id = m.recipient_agent_id
        WHERE m.id = ? AND m.delivery_status IN ('pending', 'sent', 'failed')`,
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
   * evidence. Updating the receipt and queuing a subscribed Session's wake are
   * one D1 transaction; a late subscription cannot replay old messages.
   */
  static async confirmArrival(
    env: Env, messageId: string, source: 'webhook' | 'archive',
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const outcomes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET received_at = ?, receipt_source = ?, delivery_status = 'sent',
                external_delivery_id = COALESCE(external_delivery_id, id)
          WHERE id = ? AND delivery_status IN ('pending', 'sent', 'failed')
            AND received_at IS NULL`,
      ).bind(now, source, messageId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO wake_events (message_id, session_id, next_attempt_at)
         SELECT m.id, s.session_id, ?
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           LEFT JOIN gateway_teammates g
           ON g.org_id = t.org_id
          AND g.recipient_session_id = COALESCE(m.recipient_session_id,
            t.accepted_session_id, t.notification_session_id)
          AND g.status = 'active'
         JOIN wake_subscriptions s
           ON s.org_id = t.org_id
          AND s.session_id = COALESCE(g.gateway_session_id, m.recipient_session_id,
            t.accepted_session_id, t.notification_session_id)
          WHERE m.id = ? AND m.received_at IS NOT NULL
            AND s.created_at <= m.received_at
            AND (g.gateway_session_id IS NULL OR g.approved_at <= m.received_at)`,
      ).bind(now, messageId),
    ]);

    await InboxEvents.notify(env, messageId);

    return outcomes[0].meta.changes === 1;
  }

  /**
   * Explicit, bounded Archive reconciliation for diagnostics and tests.
   * Production Cron retries Wake events; it does not poll MailTrigger Archives.
   * Only independently confirmed arrivals may enqueue a Wake.
   */
  static async reconcileArchives(env: Env): Promise<void> {
    // With no configured receiving callbacks, avoid querying unrelated mailboxes.
    if (!env.MAILTRIGGER_API_TOKEN) {
      return;
    }

    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const earliest = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const pending = await env.DB.prepare(
      `SELECT m.id AS messageId, recipient.mailbox_id AS mailboxId
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN agent_mailboxes recipient
           ON recipient.org_id = t.org_id AND recipient.agent_id = m.recipient_agent_id
         LEFT JOIN gateway_teammates g
           ON g.org_id = t.org_id
          AND g.recipient_session_id = COALESCE(m.recipient_session_id,
            t.accepted_session_id, t.notification_session_id)
          AND g.status = 'active'
         JOIN wake_subscriptions subscription
           ON subscription.org_id = t.org_id
          AND subscription.session_id = COALESCE(g.gateway_session_id,
            m.recipient_session_id, t.accepted_session_id, t.notification_session_id)
        WHERE m.delivery_status = 'sent' AND m.received_at IS NULL
          AND subscription.created_at <= m.created_at
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
      } catch (error) {
        // No false-positive receipt if one provider mailbox is unavailable.
        MailReceipt.logger.exception('archive_reconciliation_failed', error);
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

  async status(
    messageId: string, organizationId: string, sessionID: string,
    refreshArchive = false,
  ): Promise<Response> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.delivery_status AS deliveryStatus,
              m.received_at AS receivedAt, m.receipt_source AS receiptSource,
              m.archive_checked_at AS archiveCheckedAt,
              recipient.mailbox_id AS archiveMailboxId
         FROM messages m JOIN threads t ON t.id = m.thread_id
         LEFT JOIN agent_mailboxes recipient
           ON recipient.org_id = t.org_id AND recipient.agent_id = m.recipient_agent_id
        WHERE m.id = ? AND t.org_id = ?
          AND (t.sender_session_id = ? OR t.recipient_session_id = ? OR t.accepted_session_id = ?)`,
    ).bind(messageId, organizationId, sessionID, sessionID, sessionID).first<{
      id: string;
      deliveryStatus: string;
      receivedAt: string | null;
      receiptSource: 'archive' | 'webhook' | null;
      archiveCheckedAt: string | null;
      archiveMailboxId: string | null;
    }>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Message does not belong to this Session.');
    }

    if (refreshArchive && row.deliveryStatus === 'sent' && !row.receivedAt &&
      row.archiveMailboxId &&
      (!row.archiveCheckedAt || row.archiveCheckedAt < new Date(Date.now() - 2 * 60_000).toISOString())) {
      await this.env.DB.prepare(
        'UPDATE messages SET archive_checked_at = ? WHERE id = ? AND received_at IS NULL',
      ).bind(new Date().toISOString(), messageId).run();

      const archived = await new MailTriggerClient(this.env)
        .archivedProtocolMessageIds(row.archiveMailboxId);
      if (archived.has(messageId.toLowerCase())) {
        await MailReceipt.confirmArrival(this.env, messageId, 'archive');

        // Re-read status through the same authorized query. No second archive call.
        return this.status(messageId, organizationId, sessionID, false);
      }
    }

    const read = await this.env.DB.prepare(
      `SELECT session_id AS sessionID, read_at AS readAt
         FROM message_read_receipts WHERE message_id = ? ORDER BY read_at`,
    ).bind(messageId).all<{ sessionID: string; readAt: string }>();

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
