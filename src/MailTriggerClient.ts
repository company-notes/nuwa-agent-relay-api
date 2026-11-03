import type { Env } from './Env';
import { APIError } from './HTTP';

export type ManagedMailbox = {
  mailboxId: string;
  mailboxEmail: string;
  created: boolean;
};

type DomainRow = {
  id: string | number;
  domainName?: string;
  isVerified?: boolean;
};

type MailboxRow = {
  id: string | number;
  username?: string;
  userDomain?: string | number | { id?: string | number };
};

export class MailTriggerClient {
  constructor(private readonly env: Env) {}

  private headers(): HeadersInit {
    if (!this.env.MAILTRIGGER_API_TOKEN) {
      throw new APIError(503, 'mailtrigger_unconfigured', 'MailTrigger API token has not been configured.');
    }

    const scheme = this.env.MAILTRIGGER_AUTH_SCHEME ?? 'Token';

    return {
      authorization: `${scheme} ${this.env.MAILTRIGGER_API_TOKEN}`,
      'content-type': 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.env.MAILTRIGGER_API_URL.replace(/\/$/, '')}${path}`;
  }

  private async getRows(path: string, code: string): Promise<Record<string, unknown>[]> {
    const response = await fetch(this.url(path), { headers: this.headers() });

    if (!response.ok) {
      throw new APIError(502, code, `MailTrigger lookup failed (HTTP ${response.status}).`);
    }

    const data: unknown = await response.json();
    const value = data as { results?: unknown[] } | unknown[];
    const rows = Array.isArray(value) ? value : value?.results;

    if (!Array.isArray(rows)) {
      throw new APIError(502, code, 'MailTrigger returned an invalid resource list.');
    }

    return rows.filter((row): row is Record<string, unknown> => (
      row !== null && typeof row === 'object' && !Array.isArray(row)
    ));
  }

  private async verifiedDomain(): Promise<DomainRow> {
    const name = this.env.MAILTRIGGER_MANAGED_DOMAIN?.trim().toLowerCase();

    if (!name) {
      throw new APIError(503, 'managed_domain_required', 'Configure a verified MailTrigger managed domain.');
    }

    const rows = await this.getRows('/api/v1/domains/', 'mailtrigger_domain_lookup_failed');
    const domain = rows.map((row) => row as DomainRow).find((row) => (
      row.domainName?.trim().toLowerCase() === name
    ));

    if (!domain) {
      throw new APIError(503, 'managed_domain_not_found', 'The managed domain is not accessible to the service token.');
    }

    if (!domain.isVerified) {
      throw new APIError(503, 'managed_domain_unverified', 'The managed domain is not verified by MailTrigger.');
    }

    return domain;
  }

  private async findMailbox(domainId: string | number, username: string): Promise<MailboxRow | null> {
    const rows = await this.getRows(
      '/api/v1/mailbox/?page_size=1000',
      'mailtrigger_mailbox_lookup_failed',
    );

    const matching = rows.map((row) => row as MailboxRow).find((row) => {
      const rowDomain = typeof row.userDomain === 'object' ? row.userDomain?.id : row.userDomain;

      return String(rowDomain) === String(domainId) && row.username?.trim().toLowerCase() === username;
    });

    return matching ?? null;
  }

  async ensureManagedMailbox(usernameInput: string): Promise<ManagedMailbox> {
    const domain = await this.verifiedDomain();
    const name = this.env.MAILTRIGGER_MANAGED_DOMAIN!.trim().toLowerCase();
    const username = usernameInput.trim().toLowerCase();
    const mailboxEmail = `${username}@${name}`;

    const existing = await this.findMailbox(domain.id, username);

    if (existing) {
      return { mailboxId: String(existing.id), mailboxEmail, created: false };
    }

    const password = `Nar!${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, '')}`;
    const response = await fetch(this.url('/api/v1/mailbox/'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        userDomain: domain.id,
        username,
        password,
        isSender: true,
        isReceiver: true,
      }),
    });

    if (response.status === 201) {
      const created = await response.json() as MailboxRow;

      if (created?.id === undefined || created?.id === null) {
        throw new APIError(502, 'mailtrigger_mailbox_invalid', 'MailTrigger did not return a mailbox ID.');
      }

      return { mailboxId: String(created.id), mailboxEmail, created: true };
    }

    // Concurrent provisioning can lose the insert race. Recover by exact mailbox lookup.
    const raced = await this.findMailbox(domain.id, username);

    if (raced) {
      return { mailboxId: String(raced.id), mailboxEmail, created: false };
    }

    throw new APIError(502, 'mailtrigger_mailbox_failed', `Mailbox provisioning failed (HTTP ${response.status}).`);
  }

  async deleteManagedMailbox(mailboxId: string, expectedUsername: string): Promise<void> {
    const domain = await this.verifiedDomain();
    const mailbox = await this.findMailbox(domain.id, expectedUsername);

    if (!mailbox) {
      // Already removed by a partially completed cleanup.
      return;
    }

    if (String(mailbox.id) !== mailboxId) {
      throw new APIError(409, 'mailbox_mismatch', 'Refusing to delete a mismatched MailTrigger mailbox.');
    }

    const response = await fetch(this.url('/api/v1/mailbox/' + encodeURIComponent(mailboxId) + '/'), {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (![200, 204, 404].includes(response.status)) {
      throw new APIError(502, 'mailtrigger_cleanup_failed',
        'MailTrigger rejected test mailbox removal (HTTP ' + response.status + ').');
    }
  }

  async send(
    mailboxId: string,
    recipientEmail: string,
    subject: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const messageId = String(metadata.messageId);
    const markedSubject = `[NAR:${messageId}] ${subject}`;

    const response = await fetch(
      this.url(`/api/v1/mailbox/${encodeURIComponent(mailboxId)}/mail/send/`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          to: [recipientEmail],
          subject: markedSubject,
          body,
          attachments: [{
            name: 'nuwa-agent-relay.json',
            contentType: 'application/json',
            data: JSON.stringify(metadata),
            encoding: 'utf-8',
          }],
        }),
      },
    );

    if (response.status !== 201) {
      throw new APIError(502, 'mailtrigger_send_failed', `MailTrigger rejected message (HTTP ${response.status}).`);
    }

    return messageId;
  }
}
