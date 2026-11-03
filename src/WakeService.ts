import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';
import type { IdentityContext } from './IdentityContext';

type WakeRow = {
  messageId: string;
  workAddressId: string;
  callbackUrl: string;
  signingSecret: string;
  attempts: number;
};

export class WakeService {
  private static allowedURL(value: string, allowedHosts: string | undefined): string {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new APIError(400, 'invalid_callback_url', 'Callback must be a public HTTPS URL.');
    }

    const allowed = (allowedHosts || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);

    if (url.protocol !== 'https:' || !allowed.includes(url.hostname.toLowerCase()) ||
      !url.hostname.includes('.') || url.username || url.password || url.hash ||
      (url.port && url.port !== '443')) {
      throw new APIError(
        400, 'callback_not_allowed',
        'Callbacks require an exact hostname in WAKE_ALLOWED_HOSTS and public HTTPS.',
      );
    }

    return url.toString();
  }

  constructor(
    private readonly env: Env,
    private readonly identity: IdentityContext,
  ) {}

  async subscribe(rawURL: string): Promise<Record<string, unknown>> {
    const callback = WakeService.allowedURL(rawURL, this.env.WAKE_ALLOWED_HOSTS);
    const signingSecret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const created = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO wake_subscriptions
          (work_address_id, org_id, callback_url, signing_secret, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(work_address_id) DO UPDATE SET
          callback_url = excluded.callback_url,
          signing_secret = excluded.signing_secret,
          created_at = excluded.created_at`,
    ).bind(this.identity.work.id, this.identity.organization.id, callback, signingSecret, created).run();

    return {
      workAddressId: this.identity.work.id,
      callbackUrl: callback,
      signingSecret,
      description: 'Keep signingSecret private. Validate X-Nuwa-Wake-Signature (HMAC-SHA256).',
    };
  }

  async getSubscription(): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      'SELECT callback_url AS callbackUrl FROM wake_subscriptions WHERE work_address_id = ? AND org_id = ?',
    ).bind(this.identity.work.id, this.identity.organization.id)
      .first<{ callbackUrl: string }>();

    return {
      workAddressId: this.identity.work.id,
      enabled: Boolean(row),
      callbackUrl: row?.callbackUrl ?? null,
    };
  }

  async unsubscribe(): Promise<Record<string, unknown>> {
    await this.env.DB.prepare(
      'DELETE FROM wake_subscriptions WHERE work_address_id = ? AND org_id = ?',
    ).bind(this.identity.work.id, this.identity.organization.id).run();

    // Unsubscribe also removes retry jobs to avoid contacting the old endpoint.
    await this.env.DB.prepare(
      "DELETE FROM wake_events WHERE work_address_id = ? AND status = 'pending'",
    ).bind(this.identity.work.id).run();

    return { removed: true };
  }

  async deliveries(): Promise<Record<string, unknown>[]> {
    const result = await this.env.DB.prepare(
      `SELECT message_id AS messageId, attempts, status, notified_at AS notifiedAt,
              last_error AS lastError
         FROM wake_events
        WHERE work_address_id = ?
        ORDER BY next_attempt_at DESC LIMIT 100`,
    ).bind(this.identity.work.id).all();

    return result.results as Record<string, unknown>[];
  }

  static async enqueue(env: Env, messageId: string, recipientWorkId: string | null): Promise<void> {
    if (!recipientWorkId) {
      return;
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO wake_events (message_id, work_address_id, next_attempt_at)
       SELECT ?, work_address_id, ? FROM wake_subscriptions
       WHERE work_address_id = ?`,
    ).bind(messageId, new Date().toISOString(), recipientWorkId).run();
  }

  private static async signature(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));

    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static async dispatchDue(env: Env): Promise<void> {
    if (!env.WAKE_ALLOWED_HOSTS) {
      return;
    }

    const now = new Date().toISOString();
    const rows = await env.DB.prepare(
      `SELECT e.message_id AS messageId, e.work_address_id AS workAddressId,
              e.attempts, s.callback_url AS callbackUrl, s.signing_secret AS signingSecret
         FROM wake_events e
         JOIN wake_subscriptions s ON s.work_address_id = e.work_address_id
        WHERE e.status = 'pending' AND e.next_attempt_at <= ?
        ORDER BY e.next_attempt_at LIMIT 25`,
    ).bind(now).all<WakeRow>();

    for (const event of rows.results) {
      // Enforce the current operator allowlist again, including migrated D1 rows.
      let callback: string;

      try {
        callback = WakeService.allowedURL(event.callbackUrl, env.WAKE_ALLOWED_HOSTS);
      } catch {
        await env.DB.prepare(
          "UPDATE wake_events SET status = 'failed', last_error = 'url_not_allowed' WHERE message_id = ?",
        ).bind(event.messageId).run();
        continue;
      }

      const body = JSON.stringify({
        event: 'nuwa.message.available',
        messageId: event.messageId,
        workAddressId: event.workAddressId,
      });
      const signature = await WakeService.signature(event.signingSecret, body);

      let success = false;
      let reason = 'network_error';

      try {
        const response = await fetch(callback, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-nuwa-wake-signature': 'sha256=' + signature,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });

        success = response.ok;
        reason = response.ok ? '' : 'http_' + response.status;
      } catch {
        // Never leak callback secrets or HTTP response bodies to logs.
      }

      const attempts = event.attempts + 1;
      const state = success ? 'delivered' : attempts >= 6 ? 'failed' : 'pending';
      const backoff = Math.min(60, 2 ** attempts);
      const due = new Date(Date.now() + backoff * 60_000).toISOString();

      await env.DB.prepare(
        `UPDATE wake_events
            SET attempts = ?, status = ?, next_attempt_at = ?,
                notified_at = ?, last_error = ?
          WHERE message_id = ? AND status = 'pending'`,
      ).bind(
        attempts,
        state,
        due,
        success ? new Date().toISOString() : null,
        success ? null : reason,
        event.messageId,
      ).run();
    }
  }
}
