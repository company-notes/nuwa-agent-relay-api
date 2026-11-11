import type { AddressClient } from './AddressClient';
import { AliasService, type Recipient } from './AliasService';
import type { Env } from './Env';
import { APIError, type JSONRecord } from './HTTP';
import { IdentityContext } from './IdentityContext';
import { MailTriggerClient, type ManagedMailbox } from './MailTriggerClient';
import { Logger } from './Logger';
import { MessageView, type MessageRow } from './MessageView';
import { ThreadContextReader } from './ThreadContextReader';

type HostRow = { mailbox_id: string; mailbox_email: string };

type ThreadRow = {
  id: string;
  org_id: string;
  kind: 'message' | 'handoff';
  sender_host_id: string;
  sender_work_id: string;
  recipient_host_id: string;
  recipient_work_id: string | null;
  accepted_work_id: string | null;
};


export type NewMessage = {
  to: Recipient;
  subject: string;
  body: string;
  artifactLinks: string[];
};

export class RelayService {
  private static readonly logger = Logger.forModule('relay.service');
  private readonly mail: MailTriggerClient;
  private readonly aliases: AliasService;

  private static mailboxUsername(hostId: string): string {
    const stableId = hostId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    if (!stableId) {
      throw new APIError(409, 'invalid_host_id', 'Host identity cannot be used to provision a mailbox.');
    }

    return `nar-${stableId}`;
  }

  constructor(
    private readonly env: Env,
    private readonly identity: IdentityContext,
    private readonly addressClient: AddressClient,
  ) {
    this.mail = new MailTriggerClient(env);
    this.aliases = new AliasService(env, identity);
  }

  private async pairedHost(hostId: string): Promise<HostRow> {
    const row = await this.env.DB.prepare(
      `SELECT mailbox_id, mailbox_email
         FROM paired_hosts
        WHERE org_id = ? AND host_address_id = ?`,
    ).bind(this.identity.organization.id, hostId).first<HostRow>();

    if (!row) {
      throw new APIError(
        409,
        'host_not_ready',
        'Recipient host has not provisioned a Nuwa Agent Relay mailbox.',
      );
    }

    return row;
  }

  async provisionHost(): Promise<ManagedMailbox> {
    const hostId = this.identity.host.id;

    const existing = await this.env.DB.prepare(
      `SELECT mailbox_id, mailbox_email
         FROM paired_hosts
        WHERE org_id = ? AND host_address_id = ?`,
    ).bind(this.identity.organization.id, hostId).first<HostRow>();

    const created = await this.mail.ensureManagedMailbox(RelayService.mailboxUsername(hostId));

    if (existing && (existing.mailbox_id !== created.mailboxId ||
      existing.mailbox_email !== created.mailboxEmail)) {
      throw new APIError(409, 'mailbox_mismatch',
        'The stored Host mailbox does not match the remote managed mailbox.');
    }

    // Re-provision existing Hosts too: their managed delivery route may be missing.
    await this.mail.ensureManagedSMTPRoute(created);

    if (existing) {
      return {
        mailboxId: existing.mailbox_id,
        mailboxEmail: existing.mailbox_email,
        created: false,
      };
    }

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO paired_hosts
        (org_id, host_address_id, mailbox_id, mailbox_email, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      this.identity.organization.id,
      hostId,
      created.mailboxId,
      created.mailboxEmail,
      new Date().toISOString(),
    ).run();

    const stored = await this.pairedHost(hostId);

    return {
      mailboxId: stored.mailbox_id,
      mailboxEmail: stored.mailbox_email,
      created: created.created && created.mailboxId === stored.mailbox_id,
    };
  }

  async cleanupSmokeHost(runId: string): Promise<JSONRecord> {
    const hostName = this.identity.host.path;
    const expected = 'relay-smoke-' + runId + '-';
    const safeRun = /^[a-f0-9]{10}$/.test(runId);
    const safeHost = hostName === expected + 'a' || hostName === expected + 'b';
    const safeWork = this.identity.work.path === hostName + '/' + hostName;

    if (!safeRun || !safeHost || !safeWork ||
      this.identity.work.parentAddressId !== this.identity.host.id) {
      throw new APIError(403, 'smoke_cleanup_forbidden',
        'Only the exact run-scoped Work may clean its test Host.');
    }

    const org = this.identity.organization.id;
    const host = this.identity.host.id;
    const work = this.identity.work.id;
    const existing = await this.env.DB.prepare(
      `SELECT mailbox_id AS mailboxId FROM paired_hosts
        WHERE org_id = ? AND host_address_id = ?`,
    ).bind(org, host).first<{ mailboxId: string }>();

    if (existing) {
      await this.mail.deleteManagedMailbox(
        existing.mailboxId, RelayService.mailboxUsername(host),
      );
    }

    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM wake_events WHERE work_address_id = ? OR message_id IN (
          SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id
          WHERE t.org_id = ? AND (t.sender_host_id = ? OR t.recipient_host_id = ?)
        )`,
      ).bind(work, org, host, host),
      this.env.DB.prepare(
        `DELETE FROM messages WHERE thread_id IN (
          SELECT id FROM threads WHERE org_id = ?
            AND (sender_host_id = ? OR recipient_host_id = ?)
        )`,
      ).bind(org, host, host),
      this.env.DB.prepare(
        'DELETE FROM threads WHERE org_id = ? AND (sender_host_id = ? OR recipient_host_id = ?)',
      ).bind(org, host, host),
      this.env.DB.prepare(
        'DELETE FROM wake_subscriptions WHERE work_address_id = ? AND org_id = ?',
      ).bind(work, org),
      this.env.DB.prepare(
        'DELETE FROM paired_hosts WHERE org_id = ? AND host_address_id = ?',
      ).bind(org, host),
    ]);

    return {
      cleaned: true,
      hostId: host,
      mailboxRemoved: Boolean(existing),
      managedRoutingChecked: Boolean(existing),
      providerUserCleanup: 'not_verified',
      scope: 'This smoke Host managed routing, mailbox, and Relay D1 records only',
    };
  }

  private async deliver(
    thread: ThreadRow,
    recipientHostId: string,
    recipientWorkId: string | null,
    kind: MessageRow['kind'],
    subject: string,
    body: string,
    artifactLinks: string[],
  ): Promise<{ id: string; threadId: string; messageId: string }> {
    const senderMailbox = await this.provisionHost();
    const recipientMailbox = await this.pairedHost(recipientHostId);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Store the pending record before external delivery to preserve recovery evidence.
    await this.env.DB.prepare(
      `INSERT INTO messages
        (id, thread_id, kind, sender_host_id, sender_work_id, recipient_host_id,
         recipient_work_id, subject, body, artifacts_json, delivery_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      id,
      thread.id,
      kind,
      this.identity.host.id,
      this.identity.work.id,
      recipientHostId,
      recipientWorkId,
      subject,
      body,
      JSON.stringify(artifactLinks),
      createdAt,
    ).run();

    const metadata = {
      protocol: 'nuwa-agent-relay',
      version: 1,
      messageId: id,
      threadId: thread.id,
      kind,
      sender: {
        orgId: this.identity.organization.id,
        hostId: this.identity.host.id,
        workAddressId: this.identity.work.id,
      },
      recipient: { hostId: recipientHostId, workAddressId: recipientWorkId },
      artifacts: artifactLinks,
    };

    let deliveryId: string;

    try {
      deliveryId = await this.mail.send(
        senderMailbox.mailboxId,
        recipientMailbox.mailbox_email,
        subject,
        body,
        metadata,
      );
    } catch (error) {
      // The independent recipient receipt may arrive before the send API
      // response, or prove arrival even if that response is lost.
      const verified = await this.env.DB.prepare(
        "SELECT received_at AS receivedAt FROM messages WHERE id = ? AND delivery_status = 'sent'",
      ).bind(id).first<{ receivedAt: string | null }>();

      if (!verified?.receivedAt) {
        await this.env.DB.prepare(
          "UPDATE messages SET delivery_status = 'failed' WHERE id = ? AND delivery_status = 'pending'",
        ).bind(id).run();
        throw error;
      }

      RelayService.logger.exception('send_failed_after_verified_arrival', error, { messageId: id });
      deliveryId = id;
    }

    await this.env.DB.prepare(
      "UPDATE messages SET delivery_status = 'sent', external_delivery_id = ? WHERE id = ?",
    ).bind(deliveryId, id).run();

    return { id, threadId: thread.id, messageId: deliveryId };
  }

  async send(kind: 'message' | 'handoff', request: NewMessage): Promise<JSONRecord> {
    const recipient = await this.aliases.resolve(request.to, this.addressClient);

    if (kind === 'message' && !recipient.parentAddressId) {
      throw new APIError(400, 'work_recipient_required', 'Ordinary messages must target a work address.');
    }

    const recipientHostId = recipient.parentAddressId ?? recipient.id;
    const recipientWorkId = recipient.parentAddressId ? recipient.id : null;

    // Avoid orphan threads when either mailbox has never been provisioned.
    await this.provisionHost();
    await this.pairedHost(recipientHostId);

    const thread: ThreadRow = {
      id: crypto.randomUUID(),
      org_id: this.identity.organization.id,
      kind,
      sender_host_id: this.identity.host.id,
      sender_work_id: this.identity.work.id,
      recipient_host_id: recipientHostId,
      recipient_work_id: recipientWorkId,
      accepted_work_id: null,
    };

    await this.env.DB.prepare(
      `INSERT INTO threads
        (id, org_id, kind, sender_host_id, sender_work_id, recipient_host_id,
         recipient_work_id, accepted_work_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      thread.id,
      thread.org_id,
      kind,
      thread.sender_host_id,
      thread.sender_work_id,
      thread.recipient_host_id,
      thread.recipient_work_id,
      new Date().toISOString(),
    ).run();

    return this.deliver(
      thread,
      recipientHostId,
      recipientWorkId,
      kind,
      request.subject,
      request.body,
      request.artifactLinks,
    );
  }

  private async requireThread(threadId: string): Promise<ThreadRow> {
    const thread = await this.env.DB.prepare(
      `SELECT id, org_id, kind, sender_host_id, sender_work_id,
              recipient_host_id, recipient_work_id, accepted_work_id
         FROM threads
        WHERE id = ? AND org_id = ?`,
    ).bind(threadId, this.identity.organization.id).first<ThreadRow>();

    if (!thread) {
      throw new APIError(404, 'thread_not_found', 'Thread does not exist in your organization.');
    }

    const recipientWorkId = thread.accepted_work_id ?? thread.recipient_work_id;

    if (thread.sender_work_id !== this.identity.work.id && recipientWorkId !== this.identity.work.id) {
      throw new APIError(404, 'thread_not_found', 'Thread is not available to this work identity.');
    }

    return thread;
  }

  async reply(threadId: string, body: string, subject: string | null, artifactLinks: string[]): Promise<JSONRecord> {
    const thread = await this.requireThread(threadId);
    const isSender = thread.sender_work_id === this.identity.work.id;

    const recipientWorkId = isSender
      ? thread.accepted_work_id ?? thread.recipient_work_id
      : thread.sender_work_id;
    const recipientHostId = isSender ? thread.recipient_host_id : thread.sender_host_id;

    if (!recipientWorkId) {
      throw new APIError(409, 'handoff_not_accepted', 'A host-targeted handoff must be accepted before replies.');
    }

    return this.deliver(
      thread,
      recipientHostId,
      recipientWorkId,
      'reply',
      subject ?? 'Re: Agent Relay thread',
      body,
      artifactLinks,
    );
  }

  async replyToHandoff(handoffId: string, body: string, artifactLinks: string[]): Promise<JSONRecord> {
    const original = await this.env.DB.prepare(
      `SELECT id, thread_id
         FROM messages
        WHERE id = ? AND kind = 'handoff' AND delivery_status = 'sent'`,
    ).bind(handoffId).first<{ id: string; thread_id: string }>();

    if (!original) {
      throw new APIError(404, 'handoff_not_found', 'Handoff was not found.');
    }

    return this.reply(original.thread_id, body, null, artifactLinks);
  }

  async acceptHandoff(handoffId: string): Promise<JSONRecord> {
    const handoff = await this.env.DB.prepare(
      `SELECT t.id, t.org_id, t.kind, t.sender_host_id, t.sender_work_id,
              t.recipient_host_id, t.recipient_work_id, t.accepted_work_id
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
        WHERE m.id = ? AND m.kind = 'handoff' AND m.delivery_status = 'sent'
          AND t.org_id = ?`,
    ).bind(handoffId, this.identity.organization.id).first<ThreadRow>();

    if (!handoff || handoff.recipient_host_id !== this.identity.host.id || handoff.recipient_work_id) {
      throw new APIError(404, 'host_handoff_not_found', 'Pending handoff is not addressed to this host.');
    }

    const updated = await this.env.DB.prepare(
      'UPDATE threads SET accepted_work_id = ? WHERE id = ? AND accepted_work_id IS NULL',
    ).bind(this.identity.work.id, handoff.id).run();

    if (!updated.meta.changes) {
      throw new APIError(409, 'handoff_already_accepted', 'This handoff was accepted by another work identity.');
    }

    let delivered: { id: string; threadId: string; messageId: string };

    try {
      delivered = await this.deliver(
        handoff,
        handoff.sender_host_id,
        handoff.sender_work_id,
        'acceptance',
        'Agent Relay handoff accepted',
        `Accepted by ${this.identity.work.canonical}.`,
        [],
      );
    } catch (error) {
      // The acknowledgement failed; release this host handoff for a safe retry.
      await this.env.DB.prepare(
        'UPDATE threads SET accepted_work_id = NULL WHERE id = ? AND accepted_work_id = ?',
      ).bind(handoff.id, this.identity.work.id).run();

      throw error;
    }

    return { ...delivered, acceptedBy: this.identity.work.canonical };
  }

  /**
   * Unlike SMTP submission or MailTrigger mailbox arrival, this is an
   * explicit acknowledgement by the receiving active Work identity.
   * Reading an inbox listing alone never generates a read receipt.
   */
  async acknowledgeRead(messageId: string): Promise<JSONRecord> {
    const row = await this.env.DB.prepare(
      `SELECT m.id FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ? AND m.delivery_status = 'sent'
          AND (
            m.recipient_work_id = ? OR
            (m.recipient_work_id IS NULL AND t.accepted_work_id = ?)
          )`,
    ).bind(
      messageId, this.identity.organization.id,
      this.identity.work.id, this.identity.work.id,
    ).first<{ id: string }>();

    if (!row) {
      throw new APIError(404, 'message_not_found',
        'Only the intended receiving Work may acknowledge this message.');
    }

    const recorded = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO message_read_receipts
        (message_id, work_address_id, read_at) VALUES (?, ?, ?)`,
    ).bind(messageId, this.identity.work.id, recorded).run();

    const receipt = await this.env.DB.prepare(
      `SELECT read_at AS readAt FROM message_read_receipts
        WHERE message_id = ? AND work_address_id = ?`,
    ).bind(messageId, this.identity.work.id).first<{ readAt: string }>();

    return {
      messageId,
      workAddressId: this.identity.work.id,
      readAt: receipt?.readAt,
    };
  }

  async messageById(messageId: string, contextLimit = 0): Promise<JSONRecord> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.thread_id, m.kind, m.sender_host_id, m.sender_work_id,
              m.recipient_host_id, m.recipient_work_id, m.subject, m.body,
              m.artifacts_json, m.created_at
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.org_id = ? AND m.delivery_status = 'sent'
          AND (t.sender_work_id = ? OR t.recipient_work_id = ? OR t.accepted_work_id = ?)`,
    ).bind(
      messageId,
      this.identity.organization.id,
      this.identity.work.id,
      this.identity.work.id,
      this.identity.work.id,
    ).first<MessageRow>();

    if (!row) {
      throw new APIError(404, 'message_not_found', 'Message is unavailable to this work identity.');
    }

    const message = MessageView.fromRow(row);
    if (contextLimit === 0) {
      return message;
    }

    const context = new ThreadContextReader(this.env.DB, this.identity.work.id);
    return {
      ...message,
      recentThreadMessages: await context.preceding(row, contextLimit),
    };
  }

  async history(threadId: string): Promise<JSONRecord[]> {
    await this.requireThread(threadId);

    const rows = await this.env.DB.prepare(
      `SELECT id, thread_id, kind, sender_host_id, sender_work_id, recipient_host_id,
              recipient_work_id, subject, body, artifacts_json, created_at
         FROM messages
        WHERE thread_id = ? AND delivery_status = 'sent'
        ORDER BY created_at, id`,
    ).bind(threadId).all<MessageRow>();

    return rows.results.map(MessageView.fromRow);
  }

  async inbox(): Promise<JSONRecord[]> {
    const rows = await this.env.DB.prepare(
      `SELECT m.id, m.thread_id, m.kind, m.sender_host_id, m.sender_work_id,
              m.recipient_host_id, m.recipient_work_id, m.subject, m.body,
              m.artifacts_json, m.created_at
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE t.org_id = ? AND m.delivery_status = 'sent'
          AND (m.recipient_work_id = ? OR
               (m.recipient_work_id IS NULL AND t.accepted_work_id = ?))
        ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
    ).bind(
      this.identity.organization.id,
      this.identity.work.id,
      this.identity.work.id,
    ).all<MessageRow>();

    return rows.results.map(MessageView.fromRow);
  }

  async hostInbox(): Promise<JSONRecord[]> {
    const rows = await this.env.DB.prepare(
      `SELECT m.id, m.thread_id, m.kind, m.sender_host_id, m.sender_work_id,
              m.recipient_host_id, m.recipient_work_id, m.subject, m.body,
              m.artifacts_json, m.created_at
         FROM threads t
         JOIN messages m ON m.thread_id = t.id AND m.kind = 'handoff'
        WHERE t.org_id = ? AND t.recipient_host_id = ?
          AND t.recipient_work_id IS NULL AND t.accepted_work_id IS NULL
          AND m.delivery_status = 'sent'
        ORDER BY m.created_at DESC LIMIT 100`,
    ).bind(this.identity.organization.id, this.identity.host.id).all<MessageRow>();

    return rows.results.map(MessageView.fromRow);
  }
}
