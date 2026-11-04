import type { Env } from './Env';
import { APIError } from './HTTP';
import { MailTriggerRouteProvisioner } from './MailTriggerRouteProvisioner';

export type ManagedMailbox = {
  mailboxId: string;
  mailboxEmail: string;
  created: boolean;
};

type DomainRow = {
  id: string | number;
  domainName?: string;
  isVerified?: boolean;
  user?: number;
};

type MailboxRow = {
  id: string | number;
  username?: string;
  userDomain?: string | number | { id?: string | number };
};

export class MailTriggerClient {
  private readonly routes: MailTriggerRouteProvisioner;

  constructor(private readonly env: Env) {
    this.routes = new MailTriggerRouteProvisioner({
      list: (path, code) => this.getRows(path, code),
      write: (method, path, body, code) => this.writeResource(method, path, body, code),
      delete: (kind, id) => this.deleteResource(kind, id),
    });
  }

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

  private async writeResource(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
    code: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new APIError(502, code, `MailTrigger resource write failed (HTTP ${response.status}).`);
    }

    const data: unknown = await response.json();

    if (!data || typeof data !== 'object' || Array.isArray(data) || !('id' in data)) {
      throw new APIError(502, code, 'MailTrigger did not return a resource ID.');
    }

    return data as Record<string, unknown>;
  }

  private async deleteResource(
    kind: 'rules' | 'actions' | 'routes',
    id: number,
  ): Promise<void> {
    const response = await fetch(this.url('/api/v1/' + kind + '/' + id + '/'), {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (![200, 204, 404].includes(response.status)) {
      throw new APIError(502, 'mailtrigger_cleanup_failed',
        'MailTrigger rejected managed resource deletion (HTTP ' + response.status + ').');
    }
  }

  async ensureManagedSMTPRoute(mailbox: ManagedMailbox): Promise<void> {
    const domain = await this.verifiedDomain();

    if (!Number.isSafeInteger(domain.user) || (domain.user ?? 0) < 1) {
      throw new APIError(503, 'mailtrigger_owner_missing',
        'The managed domain must expose its provider user ID.');
    }

    await this.routes.ensureForMailbox(mailbox, domain.user!);
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

  /**
   * ReleaseBot used MailTrigger's recipient mailbox archives as the source of
   * inbox evidence. Keep the same provider-backed check rather than treating
   * SMTP submission (HTTP 201) as proof of recipient-side arrival.
   *
   * Some MailTrigger archive responses only expose a subject and body. The
   * [NAR:uuid] marker is generated by Relay and is checked within the exact
   * recipient mailbox selected in D1 (never a caller-supplied mailbox).
   */
  async archivedProtocolMessageIds(mailboxId: string): Promise<Set<string>> {
    const rows = await this.getRows(
      '/api/v1/mailbox/' + encodeURIComponent(mailboxId) + '/archives/',
      'mailtrigger_archive_lookup_failed',
    );
    const found = new Set<string>();
    const marker = /^\[NAR:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\](?:\s|$)/i;

    for (const row of rows) {
      if (typeof row.subject !== 'string') {
        continue;
      }

      const match = row.subject.match(marker);

      if (match) {
        found.add(match[1].toLowerCase());
      }
    }

    return found;
  }

  async deleteManagedMailbox(mailboxId: string, expectedUsername: string): Promise<void> {
    const domain = await this.verifiedDomain();
    const url = this.url('/api/v1/mailbox/' + encodeURIComponent(mailboxId) + '/');
    const details = await fetch(url, { headers: this.headers() });

    if (details.status === 404) {
      // Retry cleanup of NAR resources after a partially completed mailbox delete.
      if (!Number.isSafeInteger(domain.user) || (domain.user ?? 0) < 1) {
        throw new APIError(503, 'mailtrigger_owner_missing',
          'Cannot verify routing ownership for a missing mailbox.');
      }

      await this.routes.cleanupForMailbox({
        mailboxId,
        mailboxEmail: expectedUsername + '@' +
          this.env.MAILTRIGGER_MANAGED_DOMAIN!.trim().toLowerCase(),
        created: false,
      }, domain.user!);

      return;
    }

    if (!details.ok) {
      throw new APIError(502, 'mailtrigger_cleanup_lookup_failed',
        'Unable to verify test mailbox ownership before deletion.');
    }

    const mailbox = await details.json() as MailboxRow;
    const actualDomain = typeof mailbox.userDomain === 'object'
      ? mailbox.userDomain?.id
      : mailbox.userDomain;

    if (String(mailbox.id) !== mailboxId ||
      String(actualDomain) !== String(domain.id) ||
      mailbox.username?.trim().toLowerCase() !== expectedUsername) {
      throw new APIError(409, 'mailbox_mismatch',
        'Refusing to delete a MailTrigger mailbox that does not exactly match this Host.');
    }

    if (!Number.isSafeInteger(domain.user) || (domain.user ?? 0) < 1) {
      throw new APIError(503, 'mailtrigger_owner_missing',
        'Cannot safely remove routing resources without their owner ID.');
    }

    await this.routes.cleanupForMailbox({
      mailboxId,
      mailboxEmail: expectedUsername + '@' +
        this.env.MAILTRIGGER_MANAGED_DOMAIN!.trim().toLowerCase(),
      created: false,
    }, domain.user!);

    const response = await fetch(url, {
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
