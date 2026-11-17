import { AgentMailboxService } from './AgentMailboxService';
import { AliasService, type Recipient } from './AliasService';
import type { Env } from './Env';
import { GatewaySpeaker, SenderAuthMode, type SpeakerRequest } from './GatewaySpeaker';
import { HandoffAcceptance } from './HandoffAcceptance';
import { APIError, type JSONRecord } from './HTTP';
import { MailTriggerClient } from './MailTriggerClient';
import { Logger } from './Logger';
import { SessionIdentityClient, type SessionIdentity, type ResolvedSession } from './SessionIdentityClient';

type ThreadKind = 'message' | 'handoff';
type MessageKind = ThreadKind | 'reply' | 'acceptance';

type ThreadRow = {
  id: string;
  organizationID: string;
  kind: ThreadKind;
  senderAgentID: string;
  senderSessionID: string;
  recipientAgentID: string;
  recipientSessionID: string | null;
  acceptedSessionID: string | null;
  notificationSessionID: string | null;
};

type MessageRow = {
  id: string;
  threadID: string;
  kind: MessageKind;
  senderAgentID: string;
  senderSessionID: string;
  senderCanonicalAddress: string;
  recipientAgentID: string;
  recipientSessionID: string | null;
  subject: string;
  body: string;
  artifactsJSON: string;
  deliveryStatus: string;
  createdAt: string;
};

export type RelayMessageInput = SpeakerRequest & {
  to: Recipient;
  subject: string;
  body: string;
  artifactLinks: string[];
};

export class RelayV2Service {
  private static readonly logger = Logger.forModule('relay.v2');

  private static readonly THREAD_COLUMNS =
    't.id, t.org_id AS organizationID, t.kind, ' +
    't.sender_agent_id AS senderAgentID, t.sender_session_id AS senderSessionID, ' +
    't.recipient_agent_id AS recipientAgentID, t.recipient_session_id AS recipientSessionID, ' +
    't.accepted_session_id AS acceptedSessionID, ' +
    't.notification_session_id AS notificationSessionID';
  private readonly mail: MailTriggerClient;
  private readonly mailboxes: AgentMailboxService;
  private readonly aliases: AliasService;

  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
    private readonly actorSessionID?: string,
    private readonly senderAuthMode: SenderAuthMode = SenderAuthMode.Session,
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
          sender_canonical_address, sender_display_name, recipient_agent_id,
          recipient_session_id, subject, body, artifacts_json, delivery_status, created_at,
          actor_session_id, sender_auth_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(id, thread.id, kind, this.identity.agentID, this.identity.sessionID,
      this.identity.canonicalAddress, this.identity.agentDisplayName ?? null,
      recipientAgentID, recipientSessionID, subject, body,
      JSON.stringify(artifactLinks), createdAt,
      this.actorSessionID ?? this.identity.sessionID, this.senderAuthMode).run();

    return this.submitStoredMessage(id, thread, recipientAgentID, recipientSessionID,
      kind, subject, body, artifactLinks, sender.mailboxId, recipient.mailboxEmail);
  }

  private async submitStoredMessage(
    id: string,
    thread: ThreadRow,
    recipientAgentID: string,
    recipientSessionID: string | null,
    kind: MessageKind,
    subject: string,
    body: string,
    artifactLinks: string[],
    senderMailboxID: string,
    recipientMailboxEmail: string,
  ): Promise<{ id: string; threadId: string; messageId: string }> {
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
        senderMailboxID, recipientMailboxEmail, subject, body, metadata,
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

  private async requireSpeakingAgent(): Promise<void> {
    const office = await this.env.DB.prepare(
      `SELECT 1 FROM gateway_office_coworkers
        WHERE org_id = ? AND gateway_session_id = ?
          AND activated_at IS NOT NULL LIMIT 1`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first();

    if (office) {
      throw new APIError(403, 'gateway_voice_forbidden',
        'The office Gateway forwards messages; individual coworkers speak through their own Sessions.');
    }
  }

  async send(kind: ThreadKind, request: RelayMessageInput) {
    if (kind !== 'message' && request.from !== undefined) {
      throw new APIError(403, 'gateway_handoff_delegation_forbidden',
        'Office speaking delegation applies only to messages and Thread replies.');
    }

    const selected = await new GatewaySpeaker(
      this.env, this.identity, this.address,
    ).resolve(request.from);

    if (selected) {
      return new RelayV2Service(
        this.env, selected.identity, this.address,
        this.identity.sessionID, selected.authMode,
      ).sendAuthorized(kind, request);
    }

    await this.requireSpeakingAgent();

    return this.sendAuthorized(kind, request);
  }

  private async sendAuthorized(kind: ThreadKind, request: RelayMessageInput) {
    const recipient = await this.recipient(request.to);
    const agentHandoff = kind === 'handoff' &&
      typeof request.to === 'string' && request.to.split('/').length === 2;
    const recipientSessionID = agentHandoff ? null : recipient.id;

    await this.provisionMailbox();
    await this.mailboxes.require(this.identity.organizationID, recipient.agentId);

    const thread: ThreadRow = {
      id: crypto.randomUUID(),
      organizationID: this.identity.organizationID,
      kind,
      senderAgentID: this.identity.agentID,
      senderSessionID: this.identity.sessionID,
      recipientAgentID: recipient.agentId,
      recipientSessionID,
      acceptedSessionID: null,
      notificationSessionID: agentHandoff ? recipient.id : null,
    };

    await this.env.DB.prepare(
      `INSERT INTO threads
         (id, org_id, kind, sender_agent_id, sender_session_id,
          recipient_agent_id, recipient_session_id, accepted_session_id,
          notification_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(thread.id, thread.organizationID, kind, thread.senderAgentID,
      thread.senderSessionID, thread.recipientAgentID,
      thread.recipientSessionID, thread.notificationSessionID,
      new Date().toISOString()).run();

    return this.deliver(
      thread, recipient.agentId, recipientSessionID, kind,
      request.subject, request.body, request.artifactLinks,
    );
  }

  private async thread(threadID: string): Promise<ThreadRow> {
    const row = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.THREAD_COLUMNS}
         FROM threads t
        WHERE t.id = ? AND t.org_id = ?`,
    ).bind(threadID, this.identity.organizationID).first<ThreadRow>();

    const recipientSessionID = row?.acceptedSessionID ?? row?.recipientSessionID;

    if (!row || (row.senderSessionID !== this.identity.sessionID &&
        recipientSessionID !== this.identity.sessionID)) {
      throw new APIError(404, 'thread_not_found', 'Thread is unavailable to this Session.');
    }

    return row;
  }

  async reply(
    threadID: string, body: string, subject: string | null, artifactLinks: string[],
    speaker: SpeakerRequest = {},
  ) {
    const selected = await new GatewaySpeaker(
      this.env, this.identity, this.address,
    ).resolve(speaker.from);

    if (selected) {
      return new RelayV2Service(
        this.env, selected.identity, this.address,
        this.identity.sessionID, selected.authMode,
      ).replyAuthorized(threadID, body, subject, artifactLinks);
    }

    await this.requireSpeakingAgent();

    return this.replyAuthorized(threadID, body, subject, artifactLinks);
  }

  private async replyAuthorized(
    threadID: string, body: string, subject: string | null, artifactLinks: string[],
  ) {
    const thread = await this.thread(threadID);
    const fromSender = thread.senderSessionID === this.identity.sessionID;
    const toSessionID = fromSender
      ? thread.acceptedSessionID ?? thread.recipientSessionID
      : thread.senderSessionID;
    const toAgentID = fromSender ? thread.recipientAgentID : thread.senderAgentID;

    if (!toSessionID) {
      throw new APIError(409, 'handoff_not_accepted', 'An Agent handoff must be accepted before replies.');
    }

    return this.deliver(thread, toAgentID, toSessionID, 'reply',
      subject ?? 'Re: Agent Relay thread', body, artifactLinks);
  }

  async acceptHandoff(messageID: string) {
    const handoff = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.THREAD_COLUMNS}
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
        WHERE m.id = ? AND m.kind = 'handoff' AND m.delivery_status = 'sent'
          AND t.org_id = ?`,
    ).bind(messageID, this.identity.organizationID).first<ThreadRow>();

    if (!handoff || handoff.recipientAgentID !== this.identity.agentID ||
        handoff.recipientSessionID !== null) {
      throw new APIError(404, 'handoff_not_found', 'Agent handoff is unavailable.');
    }

    // The acceptance and its single notification must commit together.
    // Mailbox provisioning happens first so an unavailable provider cannot
    // create an undeliverable acceptance merely by failing setup.
    const sender = handoff.acceptedSessionID ? null : await this.provisionMailbox();
    const recipient = handoff.acceptedSessionID ? null
      : await this.mailboxes.require(this.identity.organizationID, handoff.senderAgentID);
    const accepted = await new HandoffAcceptance(this.env).reserve({
      threadID: handoff.id,
      organizationID: this.identity.organizationID,
      acceptingAgentID: this.identity.agentID,
      acceptingSessionID: this.identity.sessionID,
      acceptingCanonicalAddress: this.identity.canonicalAddress,
    });

    if (!accepted.created) {
      return {
        id: accepted.messageID,
        threadId: handoff.id,
        messageId: accepted.messageID,
        acceptedBy: this.identity.canonicalAddress,
        notificationStatus: accepted.notificationStatus,
        alreadyAccepted: true,
      };
    }

    if (!sender || !recipient) {
      throw new APIError(500, 'handoff_mailbox_missing',
        'Handoff notification must have provisioned sender and recipient mailboxes.');
    }

    const delivered = await this.submitStoredMessage(
      accepted.messageID, handoff, handoff.senderAgentID, handoff.senderSessionID,
      'acceptance', HandoffAcceptance.SUBJECT,
      HandoffAcceptance.body(this.identity.canonicalAddress), [],
      sender.mailboxId, recipient.mailboxEmail,
    );

    return {
      ...delivered,
      acceptedBy: this.identity.canonicalAddress,
      notificationStatus: 'sent',
      alreadyAccepted: false,
    };
  }

  async replyHandoff(messageID: string, body: string, artifactLinks: string[]) {
    const message = await this.env.DB.prepare(
      "SELECT thread_id AS threadID FROM messages WHERE id = ? AND kind = 'handoff' AND delivery_status = 'sent'",
    ).bind(messageID).first<{ threadID: string }>();

    if (!message) {
      throw new APIError(404, 'handoff_not_found', 'Handoff does not exist.');
    }

    return this.reply(message.threadID, body, null, artifactLinks);
  }

  private static view(message: MessageRow): JSONRecord {
    return {
      id: message.id,
      threadId: message.threadID,
      kind: message.kind,
      senderAgentID: message.senderAgentID,
      senderSessionID: message.senderSessionID,
      senderCanonicalAddress: message.senderCanonicalAddress,
      recipientAgentID: message.recipientAgentID,
      recipientSessionID: message.recipientSessionID,
      subject: message.subject,
      body: message.body,
      artifactLinks: JSON.parse(message.artifactsJSON) as string[],
      createdAt: message.createdAt,
    };
  }

  private static readonly MESSAGE_COLUMNS =
    'm.id, m.thread_id AS threadID, m.kind, ' +
    'm.sender_agent_id AS senderAgentID, m.sender_session_id AS senderSessionID, ' +
    'm.sender_canonical_address AS senderCanonicalAddress, ' +
    'm.recipient_agent_id AS recipientAgentID, m.recipient_session_id AS recipientSessionID, ' +
    'm.subject, m.body, m.artifacts_json AS artifactsJSON, ' +
    'm.delivery_status AS deliveryStatus, m.created_at AS createdAt';

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
      'SELECT sender_session_id AS senderSessionID, ' +
        'recipient_session_id AS recipientSessionID, ' +
        'accepted_session_id AS acceptedSessionID FROM threads WHERE id = ?',
    ).bind(row.threadID).first<Pick<ThreadRow,
      'senderSessionID' | 'recipientSessionID' | 'acceptedSessionID'>>();

    if (!thread || (![thread.senderSessionID, thread.recipientSessionID,
      thread.acceptedSessionID].includes(this.identity.sessionID))) {
      return { ...item, recentThreadMessages: [] };
    }

    const preceding = await this.env.DB.prepare(
      `SELECT ${RelayV2Service.MESSAGE_COLUMNS}
         FROM messages m
        WHERE m.thread_id = ? AND m.delivery_status = 'sent'
          AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ).bind(row.threadID, row.createdAt, row.createdAt, row.id, contextLimit).all<MessageRow>();

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
