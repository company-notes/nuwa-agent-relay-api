import type { JSONRecord } from './HTTP';

export type MessageRow = {
  id: string;
  thread_id: string;
  kind: string;
  sender_host_id: string;
  sender_work_id: string;
  recipient_host_id: string;
  recipient_work_id: string | null;
  subject: string;
  body: string;
  artifacts_json: string;
  created_at: string;
};

export type ContextMessageRow = MessageRow & {
  bodyTruncated: number;
};

export class MessageView {
  static fromRow(row: MessageRow): JSONRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      kind: row.kind,
      senderWorkId: row.sender_work_id,
      recipientWorkId: row.recipient_work_id,
      subject: row.subject,
      body: row.body,
      artifactLinks: JSON.parse(row.artifacts_json) as string[],
      createdAt: row.created_at,
    };
  }

  static fromContextRow(row: ContextMessageRow): JSONRecord {
    return {
      ...this.fromRow(row),
      bodyTruncated: Boolean(row.bodyTruncated),
    };
  }
}
