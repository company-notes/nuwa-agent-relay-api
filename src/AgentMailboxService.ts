import type { Env } from './Env';
import { APIError } from './HTTP';
import { MailTriggerClient, type ManagedMailbox } from './MailTriggerClient';

type MailboxRow = {
  mailboxID: string;
  mailboxEmail: string;
};

export class AgentMailboxService {
  private readonly mail: MailTriggerClient;

  constructor(private readonly env: Env) {
    this.mail = new MailTriggerClient(env);
  }

  private static username(agentID: string): string {
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(agentID)) {
      throw new APIError(400, 'invalid_agent_id', 'Agent ID is not valid for a managed mailbox.');
    }

    return 'nar-' + agentID.replace(/-/g, '').toLowerCase();
  }

  async require(organizationID: string, agentID: string): Promise<MailboxRow> {
    const row = await this.env.DB.prepare(
      'SELECT mailbox_id AS mailboxID, mailbox_email AS mailboxEmail ' +
        'FROM agent_mailboxes WHERE org_id = ? AND agent_id = ?',
    ).bind(organizationID, agentID).first<MailboxRow>();

    if (!row) {
      throw new APIError(409, 'agent_mailbox_not_ready', 'Recipient Agent has no managed mailbox.');
    }

    return row;
  }

  async provision(organizationID: string, agentID: string): Promise<ManagedMailbox> {
    const username = AgentMailboxService.username(agentID);
    const existing = await this.env.DB.prepare(
      'SELECT mailbox_id AS mailboxID, mailbox_email AS mailboxEmail ' +
        'FROM agent_mailboxes WHERE org_id = ? AND agent_id = ?',
    ).bind(organizationID, agentID).first<MailboxRow>();

    const mailbox = await this.mail.ensureManagedMailbox(username);

    if (existing && (existing.mailboxID !== mailbox.mailboxId ||
        existing.mailboxEmail !== mailbox.mailboxEmail)) {
      throw new APIError(409, 'agent_mailbox_mismatch', 'Managed mailbox identity has changed.');
    }

    await this.mail.ensureManagedSMTPRoute(mailbox);

    await this.env.DB.prepare(
      `INSERT INTO agent_mailboxes
         (org_id, agent_id, mailbox_id, mailbox_email, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, agent_id) DO NOTHING`,
    ).bind(organizationID, agentID, mailbox.mailboxId, mailbox.mailboxEmail,
      new Date().toISOString()).run();

    const saved = await this.require(organizationID, agentID);

    if (saved.mailboxID !== mailbox.mailboxId || saved.mailboxEmail !== mailbox.mailboxEmail) {
      throw new APIError(409, 'agent_mailbox_mismatch', 'Concurrent mailbox registration conflicts.');
    }

    return mailbox;
  }
}
