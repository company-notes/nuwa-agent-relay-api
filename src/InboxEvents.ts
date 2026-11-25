import type { Env } from './Env';
import { APIError, HTTP } from './HTTP';
import { Logger } from './Logger';
import type { AuthorizedSession, SessionIdentity } from './SessionIdentityClient';

type PendingEvent = {
  sequence: number;
  organizationID: string;
  sessionID: string;
};

export class InboxEvents {
  private static readonly logger = Logger.forModule('relay.inbox.events');
  private static readonly PAGE_SIZE = 100;
  private static readonly STREAM_TTL_MS = 300_000;

  private static stream(env: Env, organizationID: string, sessionID: string) {
    return env.INBOX_STREAM.get(env.INBOX_STREAM.idFromName(JSON.stringify([organizationID, sessionID])));
  }

  private static async signal(env: Env, rows: PendingEvent[]): Promise<void> {
    const groups = new Map<string, PendingEvent>();

    for (const row of rows) {
      const key = JSON.stringify([row.organizationID, row.sessionID]);
      const previous = groups.get(key);

      if (!previous || row.sequence > previous.sequence) {
        groups.set(key, row);
      }
    }

    for (const row of groups.values()) {
      try {
        const response = await this.stream(env, row.organizationID, row.sessionID)
          .fetch('https://inbox.internal/', { method: 'POST' });

        if (!response.ok) {
          throw new Error('Inbox signal was rejected');
        }

        await env.DB.prepare(
          `UPDATE inbox_events SET notified_at = ?
            WHERE org_id = ? AND session_id = ? AND sequence <= ? AND notified_at IS NULL`,
        ).bind(new Date().toISOString(), row.organizationID, row.sessionID, row.sequence).run();
      } catch (error) {
        this.logger.exception('inbox_signal_pending', error, { sessionID: row.sessionID });
      }
    }
  }

  static async notify(env: Env, messageID: string): Promise<void> {
    try {
      const row = await env.DB.prepare(
        `SELECT sequence, org_id AS organizationID, session_id AS sessionID
           FROM inbox_events WHERE message_id = ? AND notified_at IS NULL`,
      ).bind(messageID).first<PendingEvent>();

      if (row) {
        await this.signal(env, [row]);
      }
    } catch (error) {
      this.logger.exception('inbox_signal_pending', error, { messageID });
    }
  }

  static async dispatchDue(env: Env): Promise<void> {
    const rows = await env.DB.prepare(
      `SELECT sequence, org_id AS organizationID, session_id AS sessionID
         FROM inbox_events WHERE notified_at IS NULL ORDER BY sequence LIMIT 100`,
    ).all<PendingEvent>();

    await this.signal(env, rows.results);
  }

  static readCursor(request: Request): number {
    const raw = new URL(request.url).searchParams.get('after_sequence') ?? '0';
    const cursor = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor)) {
      throw new APIError(400, 'invalid_inbox_cursor', 'A nonnegative integer Inbox cursor is required.');
    }

    return cursor;
  }

  constructor(private readonly env: Env, private readonly identity: SessionIdentity) {}

  async head(): Promise<Response> {
    const row = await this.env.DB.prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS cursor FROM inbox_events
        WHERE org_id = ? AND session_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first<{ cursor: number }>();

    return HTTP.response({ cursor: row?.cursor ?? 0 });
  }

  async page(cursor: number): Promise<Response> {
    const rows = await this.env.DB.prepare(
      `SELECT sequence, message_id AS messageID FROM inbox_events
        WHERE org_id = ? AND session_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID, cursor,
      InboxEvents.PAGE_SIZE + 1).all<{ sequence: number; messageID: string }>();
    const items = rows.results.slice(0, InboxEvents.PAGE_SIZE);

    return HTTP.response({
      items, cursor: items.at(-1)?.sequence ?? cursor,
      hasMore: rows.results.length > InboxEvents.PAGE_SIZE,
    });
  }

  async subscribe(request: Request, identity: AuthorizedSession): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new APIError(426, 'websocket_required', 'A WebSocket upgrade is required.');
    }

    const expiry = Math.min(Date.parse(identity.leaseExpiresAt), Date.now() + InboxEvents.STREAM_TTL_MS);

    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new APIError(403, 'session_expired', 'A current Session Runtime is required.');
    }

    const response = await InboxEvents.stream(this.env, identity.organizationID, identity.sessionID)
      .fetch('https://inbox.internal/', {
        headers: { upgrade: 'websocket', 'x-nuwa-stream-expiry': String(expiry) },
      });

    if (response.status !== 101 || !response.webSocket) {
      throw new APIError(502, 'inbox_stream_unavailable', 'Inbox WebSocket could not be established.');
    }

    return new Response(null, { status: 101, webSocket: response.webSocket });
  }
}
