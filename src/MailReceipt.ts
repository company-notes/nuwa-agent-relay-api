import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';

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

    await this.env.DB.prepare(
      'UPDATE messages SET received_at = COALESCE(received_at, ?) WHERE id = ?',
    ).bind(new Date().toISOString(), messageId).run();

    return HTTP.response({ matched: true, messageId, duplicate: Boolean(result.receivedAt) });
  }

  async status(messageId: string, organizationId: string, workId: string): Promise<Response> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.delivery_status AS deliveryStatus, m.received_at AS receivedAt
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ?
          AND (t.sender_work_id = ? OR t.recipient_work_id = ? OR t.accepted_work_id = ?)`,
    ).bind(messageId, organizationId, workId, workId, workId).first<{
      id: string;
      deliveryStatus: string;
      receivedAt: string | null;
    }>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Message does not belong to this work identity.');
    }

    return HTTP.response({
      messageId: row.id,
      submissionStatus: row.deliveryStatus,
      arrivedInMailTrigger: row.receivedAt !== null,
      receivedAt: row.receivedAt,
    });
  }
}
