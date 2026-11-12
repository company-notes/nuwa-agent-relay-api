import { AgentMailboxService } from './AgentMailboxService';
import { AliasService, type Recipient } from './AliasService';
import type { Env } from './Env';
import { APIError, type JSONRecord } from './HTTP';
import { MailTriggerClient } from './MailTriggerClient';
import { Logger } from './Logger';
import { SessionIdentityClient, type SessionIdentity, type ResolvedSession } from './SessionIdentityClient';

type ThreadKind = 'message' | 'handoff';
type MessageKind = ThreadKind | 'reply' | 'acceptance';

type ThreadRow = {
  id: string;
  org_id: string;
  kind: ThreadKind;
  sender_agent_id: string;
  sender_session_id: string;
  recipient_agent_id: string;
  recipient_session_id: string | null;
  accepted_session_id: string | null;
  notification_session_id: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  kind: MessageKind;
  sender_agent_id: string;
  sender_session_id: string;
  sender_canonical_address: string;
  recipient_agent_id: string;
  recipient_session_id: string | null;
  subject: string;
  body: string;
  artifacts_json: string;
  delivery_status: string;
  created_at: string;
};

export type RelayMessageInput = {
  to: Recipient;
  subject: string;
  body: string;
  artifactLinks: string[];
};

export class RelayV2Service {
  private static readonly logger = Logger.forModule('relay.v2');
  private readonly mail: MailTriggerClient;
  private readonly mailboxes: AgentMailboxService;
  private readonly aliases: AliasService;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {
    this.mail = new MailTriggerClient(env);
    this.mailboxes = new AgentMailboxService(env);
    this.aliases = new AliasService(env, identity, address);
  }

  private async recipient(address: Recipient): Promise<ResolvedSession> {
    const recipient = await this.aliases.resolve(address);

    if (recipient.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(403, 'cross_organization_unsupported',
        'Relay only connects Sessions in the same Organization.');
    }

    return recipient;
  }

  async provisionMailbox() {
    return this.mailboxes.provision(this.identity.organizationID, this.identity.agentID);
  }

  private async deliver(
    thread: ThreadRow,
    recipientAgentID: string,
    recipientSessionID: string | null,
    kind: MessageKind,
    subject: string,
    body: string,
    artifactLinks: string[],
  ): Promise<{ id: string; threadId: string; messageId: string }> {
    const sender = await this.provisionMailbox();
    const recipient = await this.mailboxes.require(this.identity.organizationID, recipientAgentID);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO messages
         (id, thread_id, kind, sender_agent_id, sender_session_id,
          sender_canonical_address, recipient_agent_id, recipient_session_id, subject, body,
          artifacts_json, delivery_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, thread.id, kind, this.identity.agentID, this.identity.sessionID,
      this.identity.canonicalAddress, recipientAgentID, recipientSessionID, subject, body,
      JSON.stringify(artifactLinks), createdAt).run();

    const metadata = {
      protocol: 'nuwa-agent-relay',
      version: 2,
      messageId: id,
      threadId: thread.id,
      kind,
      sender: {
        organizationID: this.identity.organizationID,
        agentID: this.identity.agentID,
        sessionID: this.identity.sessionID,
      },
      recipient: { agentID: recipientAgentID, sessionID: recipientSessionID },
      artifactLinks,
    };

    let deliveryID: string;

    try {
      deliveryID = await this.mail.send(
        sender.mailboxId, recipient.mailbox_email, subject, body, metadata,
      );
    } catch (error) {
      const receipt = await this.env.DB.prepare(
        'SELECT received_at AS receivedAt FROM messages WHERE id = ?',
      ).bind(id).first<{ receivedAt: string | null }>();

      if (!receipt?.receivedAt) {
        await this.env.DB.prepare(
          "UPDATE messages SET delivery_status = 'failed' WHERE id = ? AND delivery_status = 'pending'",
        ).bind(id).run();

        throw error;
      }

      RelayV2Service.logger.exception('send_failed_after_verified_arrival', error, { messageID: id });
      deliveryID = id;
    }

    await this.env.DB.prepare(
      "UPDATE messages SET delivery_status = 'sent', external_delivery_id = ? WHERE id = ?",
    ).bind(deliveryID, id).run();

    return { id, threadId: thread.id, messageId: deliveryID };
  }

  async send(kind: ThreadKind, request: RelayMessageInput) {
    const recipient = await this.recipient(request.to);
    const agentHandoff = kind === 'handoff' &&
      typeof request.to === 'string' && request.to.split('/').length === 2;
    const recipientSessionID = agentHandoff ? null : recipient.id;

    await this.provisionMailbox();
    await this.mailboxes.require(this.identity.organizationID, recipient.agentId);

    const thread: ThreadRow = {
      id: crypto.randomUUID(),
      org_id: this.identity.organizationID,
      kind,
      sender_agent_id: this.identity.agentID,
      sender_session_id: this.identity.sessionID,
      recipient_agent_id: recipient.agentId,
      recipient_session_id: recipientSessionID,
      accepted_session_id: null,
      notification_session_id: agentHandoff ? recipient.id : null,
    };

    await this.env.DB.prepare(
      `INSERT INTO threads
         (id, org_id, kind, sender_agent_id, sender_session_id,
          recipient_agent_id, recipient_session_id, accepted_session_id,
          notification_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(thread.id, thread.org_id, kind, thread.sender_agent_id,
      thread.sender_session_id, thread.recipient_agent_id,
      thread.recipient_session_id, thread.notification_session_id,
      new Date().toISOString()).run();

    return this.deliver(
      thread, recipient.agentId, recipientSessionID, kind,
      request.subject, request.body, request.artifactLinks,
    );
  }

  private async thread(threadID: string): Promise<ThreadRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, org_id, kind, sender_agent_id, sender_session_id,
              recipient_agent_id, recipient_session_id, accepted_session_id,
              notification_session_id
         FROM threads
        WHERE id = ? AND org_id = ?`,
    ).bind(threadID, this.identity.organizationID).first<ThreadRow>();

    const recipientSessionID = row?.accepted_session_id ?? row?.recipient_session_id;

    if (!row || (row.sender_session_id !== this.identity.sessionID &&
        recipientSessionID !== this.identity.sessionID)) {
      throw new APIError(404, 'thread_not_found', 'Thread is unavailable to this Session.');
    }

    return row;
  }

  async reply(threadID: string, body: string, subject: string | null, artifactLinks: string[]) {
    const thread = await this.thread(threadID);
    const fromSender = thread.sender_session_id === this.identity.sessionID;
    const toSessionID = fromSender
      ? thread.accepted_session_id ?? thread.recipient_session_id
      : thread.sender_session_id;
    const toAgentID = fromSender ? thread.recipient_agent_id : thread.sender_agent_id;

    if (!toSessionID) {
      throw new APIError(409, 'handoff_not_accepted', 'An Agent handoff must be accepted before replies.');
    }

    return this.deliver(thread, toAgentID, toSessionID, 'reply',
      subject ?? 'Re: Agent Relay thread', body, artifactLinks);
  }

  async acceptHandoff(messageID: string) {
    const handoff = await this.env.DB.prepare(
      `SELECT t.id, t.org_id, t.kind, t.sender_agent_id, t.sender_session_id,
              t.recipient_agent_id, t.recipient_session_id, t.accepted_session_id,
              t.notification_session_id
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
        WHERE m.id = ? AND m.kind = 'handoff' AND m.delivery_status = 'sent'
          AND t.org_id = ?`,
    ).bind(messageID, this.identity.organizationID).first<ThreadRow>();

    if (!handoff || handoff.recipient_agent_id !== this.identity.agentID ||
        handoff.recipient_session_id !== null) {
      throw new APIError(404, 'handoff_not_found', 'Agent handoff is unavailable.');
    }

    const changed = await this.env.DB.prepare(
      'UPDATE threads SET accepted_session_id = ? WHERE id = ? AND accepted_session_id IS NULL',
    ).bind(this.identity.sessionID, handoff.id).run();

    if (changed.meta.changes !== 1) {
      throw new APIError(409, 'handoff_already_accepted', 'Another Session accepted the handoff.');
    }

    try {
      const delivered = await this.deliver(
        handoff, handoff.sender_agent_id, handoff.sender_session_id,
        'acceptance', 'Agent Relay handoff accepted',
        'Accepted by ' + this.identity.canonicalAddress + '.', [],
      );

      return { ...delivered, acceptedBy: this.identity.canonicalAddress };
    } catch (error) {
      await this.env.DB.prepare(
        'UPDATE threads SET accepted_session_id = NULL WHERE id = ? AND accepted_session_id = ?',
      ).bind(handoff.id, this.identity.sessionID).run();

      throw error;
    }
  }

  async replyHandoff(messageID: string, body: string, artifactLinks: string[]) {
    const message = await this.env.DB.prepare(
      "SELECT thread_id FROM messages WHERE id = ? AND kind = 'handoff' AND delivery_status = 'sent'",
    ).bind(messageID).first<{ thread_id: string }>();

    if (!message) {
      throw new APIError(404, 'handoff_not_found', 'Handoff does not exist.');
    }

    return this.reply(message.thread_id, body, null, artifactLinks);
  }

  private static view(message: MessageRow): JSONRecord {
    return {
      id: message.id,
      threadId: message.thread_id,
      kind: message.kind,
      senderAgentID: message.sender_agent_id,
      senderSessionID: message.sender_session_id,
      senderCanonicalAddress: message.sender_canonical_address,
      recipientAgentID: message.recipient_agent_id,
      recipientSessionID: message.recipient_session_id,
      subject: message.subject,
      body: message.body,
      artifactLinks: JSON.parse(message.artifacts_json) as string[],
      createdAt: message.created_at,
    };
  }

  private static readonly MESSAGE_COLUMNS =
    'm.id, m.thread_id, m.kind, m.sender_agent_id, m.sender_session_id, ' +
    'm.sender_canonical_address, m.recipient_agent_id, m.recipient_session_id, m.subject, m.body, ' +
    'm.artifacts_json, m.delivery_status, m.created_at';

  async message(messageID: string, contextLimit = 0): Promise<JSONRecord> {
    const row = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ? AND m.delivery_status = 'sent'
          AND (t.sender_session_id = ? OR t.recipient_session_id = ? OR
               t.accepted_session_id = ? OR
               (t.recipient_agent_id = ? AND t.recipient_session_id IS NULL
                 AND t.accepted_session_id IS NULL))`,
    ).bind(messageID, this.identity.organizationID, this.identity.sessionID,
      this.identity.sessionID, this.identity.sessionID, this.identity.agentID)
      .first<MessageRow>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Message is unavailable to this Session.');
    }

    const item = RelayV2Service.view(row);

    if (contextLimit === 0) {
      return item;
    }

    if (!Number.isInteger(contextLimit) || contextLimit < 1 || contextLimit > 12) {
      throw new APIError(400, 'invalid_context_limit', 'Context limit must be 1–12.');
    }

    const thread = await this.env.DB.prepare(
      'SELECT sender_session_id, recipient_session_id, accepted_session_id FROM threads WHERE id = ?',
    ).bind(row.thread_id).first<Pick<ThreadRow,
      'sender_session_id' | 'recipient_session_id' | 'accepted_session_id'>>();

    if (!thread || (![thread.sender_session_id, thread.recipient_session_id,
      thread.accepted_session_id].includes(this.identity.sessionID))) {
      return { ...item, recentThreadMessages: [] };
    }

    const preceding = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m
        WHERE m.thread_id = ? AND m.delivery_status = 'sent'
          AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ).bind(row.thread_id, row.created_at, row.created_at, row.id, contextLimit).all<MessageRow>();

    return {
      ...item,
      recentThreadMessages: preceding.results.reverse().map((item) => ({
        ...RelayV2Service.view(item),
        body: item.body.slice(0, 3000),
        bodyTruncated: item.body.length > 3000,
      })),
    };
  }

  async history(threadID: string): Promise<JSONRecord[]> {
    await this.thread(threadID);

    const result = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m
        WHERE m.thread_id = ? AND m.delivery_status = 'sent'
        ORDER BY m.created_at, m.id`,
    ).bind(threadID).all<MessageRow>();

    return result.results.map(RelayV2Service.view);
  }

  async inbox(): Promise<JSONRecord[]> {
    const result = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND m.delivery_status = 'sent'
          AND (m.recipient_session_id = ? OR
            (m.recipient_session_id IS NULL AND t.accepted_session_id = ?))
        ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
    ).bind(this.identity.organizationID, this.identity.sessionID,
      this.identity.sessionID).all<MessageRow>();

    return result.results.map(RelayV2Service.view);
  }

  async agentInbox(): Promise<JSONRecord[]> {
    const result = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND t.recipient_agent_id = ?
          AND t.recipient_session_id IS NULL AND t.accepted_session_id IS NULL
          AND m.kind = 'handoff' AND m.delivery_status = 'sent'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
    ).bind(this.identity.organizationID, this.identity.agentID).all<MessageRow>();

    return result.results.map(RelayV2Service.view);
  }

  async acknowledgeRead(messageID: string) {
    const row = await this.env.DB.prepare(
      `SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ? AND m.delivery_status = 'sent'
          AND (m.recipient_session_id = ? OR
               (m.recipient_session_id IS NULL AND t.accepted_session_id = ?))`,
    ).bind(messageID, this.identity.organizationID, this.identity.sessionID,
      this.identity.sessionID).first<{ id: string }>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Only the receiving Session may acknowledge a message.');
    }

    const now = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO message_read_receipts
         (message_id, session_id, read_at) VALUES (?, ?, ?)`,
    ).bind(messageID, this.identity.sessionID, now).run();

    const receipt = await this.env.DB.prepare(
      'SELECT read_at AS readAt FROM message_read_receipts WHERE message_id = ? AND session_id = ?',
    ).bind(messageID, this.identity.sessionID).first<{ readAt: string }>();

    return { messageId: messageID, sessionID: this.identity.sessionID, readAt: receipt?.readAt };
  }
}
