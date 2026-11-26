import type { Env } from './Env';
import { APIError } from './HTTP';
import { InboxEvents } from './InboxEvents';
import { Logger } from './Logger';
import { MailTriggerClient } from './MailTriggerClient';

type StoredDelivery = {
  id: string;
  organizationID: string;
  threadID: string;
  kind: string;
  senderAgentID: string;
  senderSessionID: string;
  recipientAgentID: string;
  recipientSessionID: string | null;
  senderMailboxID: string;
  recipientMailboxEmail: string;
  subject: string;
  body: string;
  artifactsJSON: string;
};

export type DeliveryResult = {
  id: string;
  threadId: string;
  messageId: string;
  submissionStatus?: string;
  outboxStatus?: string;
};

export class MessageDelivery {
  private static readonly logger = Logger.forModule('relay.message_delivery');

  constructor(private readonly env: Env) {}

  async load(id: string): Promise<StoredDelivery> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, t.org_id AS organizationID, m.thread_id AS threadID, m.kind,
              m.sender_agent_id AS senderAgentID, m.sender_session_id AS senderSessionID,
              m.recipient_agent_id AS recipientAgentID, m.recipient_session_id AS recipientSessionID,
              sender.mailbox_id AS senderMailboxID, recipient.mailbox_email AS recipientMailboxEmail,
              m.subject, m.body, m.artifacts_json AS artifactsJSON
         FROM messages m JOIN threads t ON t.id = m.thread_id
         JOIN agent_mailboxes sender ON sender.org_id = t.org_id AND sender.agent_id = m.sender_agent_id
         JOIN agent_mailboxes recipient ON recipient.org_id = t.org_id AND recipient.agent_id = m.recipient_agent_id
        WHERE m.id = ?`,
    ).bind(id).first<StoredDelivery>();

    if (!row) {
      throw new APIError(409, 'message_delivery_not_ready', 'The stored Message or its mailbox is unavailable.');
    }

    return row;
  }

  async submit(row: StoredDelivery, timeoutMs?: number): Promise<DeliveryResult> {
    const metadata = {
      protocol: 'nuwa-agent-relay',
      version: 2,
      messageId: row.id,
      threadId: row.threadID,
      kind: row.kind,
      sender: {
        organizationID: row.organizationID,
        agentID: row.senderAgentID,
        sessionID: row.senderSessionID,
      },
      recipient: { agentID: row.recipientAgentID, sessionID: row.recipientSessionID },
      artifactLinks: JSON.parse(row.artifactsJSON) as string[],
    };
    let deliveryID: string;

    try {
      deliveryID = await new MailTriggerClient(this.env).send(
        row.senderMailboxID, row.recipientMailboxEmail, row.subject, row.body, metadata, timeoutMs,
      );
    } catch (error) {
      const receipt = await this.env.DB.prepare(
        'SELECT received_at AS receivedAt FROM messages WHERE id = ?',
      ).bind(row.id).first<{ receivedAt: string | null }>();

      if (!receipt?.receivedAt) {
        if (timeoutMs === undefined) {
          await this.env.DB.prepare(
            "UPDATE messages SET delivery_status = 'failed' WHERE id = ? AND delivery_status = 'pending'",
          ).bind(row.id).run();
        }

        throw error;
      }

      MessageDelivery.logger.exception('send_failed_after_verified_arrival', error, { messageID: row.id });
      deliveryID = row.id;
    }

    await this.env.DB.prepare(
      "UPDATE messages SET delivery_status = 'sent', external_delivery_id = ? WHERE id = ?",
    ).bind(deliveryID, row.id).run();
    await InboxEvents.notify(this.env, row.id);

    return { id: row.id, threadId: row.threadID, messageId: deliveryID };
  }
}
