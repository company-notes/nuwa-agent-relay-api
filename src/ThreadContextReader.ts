import { APIError, type JSONRecord } from './HTTP';
import { MessageView, type ContextMessageRow, type MessageRow } from './MessageView';

export class ThreadContextReader {
  private static readonly maximumMessages = 12;
  private static readonly maximumBodyLength = 3000;

  constructor(
    private readonly db: D1Database,
    private readonly workID: string,
  ) {}

  static parseLimit(value: string | null): number {
    if (value === null) {
      return 0;
    }

    if (!/^(?:0|[1-9]|1[0-2])$/.test(value)) {
      throw new APIError(400, 'invalid_context_limit',
        'context_limit must be an integer between 0 and 12.');
    }

    return Number(value);
  }

  async preceding(message: MessageRow, limit: number): Promise<JSONRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > ThreadContextReader.maximumMessages) {
      throw new APIError(400, 'invalid_context_limit',
        'context_limit must be an integer between 1 and 12.');
    }

    // Authorize the exact participating Work again at the persistence boundary.
    // This method never performs a cross-thread or organization-wide history read.
    const result = await this.db.prepare(
      `SELECT m.id, m.thread_id, m.kind, m.sender_host_id, m.sender_work_id,
              m.recipient_host_id, m.recipient_work_id, m.subject,
              substr(m.body, 1, ?) AS body,
              (length(m.body) > ?) AS bodyTruncated,
              m.artifacts_json, m.created_at
         FROM messages AS m
         JOIN threads AS t ON t.id = m.thread_id
        WHERE m.thread_id = ? AND m.delivery_status = 'sent'
          AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
          AND (t.sender_work_id = ? OR t.recipient_work_id = ? OR t.accepted_work_id = ?)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    ).bind(
      ThreadContextReader.maximumBodyLength,
      ThreadContextReader.maximumBodyLength,
      message.thread_id,
      message.created_at,
      message.created_at,
      message.id,
      this.workID,
      this.workID,
      this.workID,
      limit,
    ).all<ContextMessageRow>();

    return result.results.reverse().map((row) => MessageView.fromContextRow(row));
  }
}
