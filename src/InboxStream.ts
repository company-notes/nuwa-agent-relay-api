import { DurableObject } from 'cloudflare:workers';

import type { Env } from './Env';
import { Logger } from './Logger';

/** A session-scoped, hibernatable channel carrying notification signals only. */
export class InboxStream extends DurableObject<Env> {
  private static readonly logger = Logger.forModule('relay.inbox.stream');

  private async closeExpired(): Promise<WebSocket[]> {
    const active: WebSocket[] = [];
    const now = Date.now();
    let nextExpiry = Infinity;

    for (const socket of this.ctx.getWebSockets()) {
      const expiry = socket.deserializeAttachment() as number | null;

      if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= now) {
        socket.close(1008, 'Reconnect with current authorization');
        continue;
      }

      active.push(socket);
      nextExpiry = Math.min(nextExpiry, expiry);
    }

    if (Number.isFinite(nextExpiry)) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }

    return active;
  }

  async alarm(): Promise<void> {
    await this.closeExpired();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'POST') {
      const active = await this.closeExpired();

      for (const socket of active) {
        try {
          socket.send(JSON.stringify({ inboxChanged: true }));
        } catch (error) {
          InboxStream.logger.exception('signal_failed', error);
          socket.close(1011, 'Reconnect to recover Inbox');
        }
      }

      return new Response(null, { status: 204 });
    }

    const expiry = Number(request.headers.get('x-nuwa-stream-expiry'));

    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !Number.isFinite(expiry) || expiry <= Date.now()) {
      return new Response(null, { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(expiry);
    await this.closeExpired();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(1008, 'This channel only delivers Inbox notifications');
  }

  webSocketClose(socket: WebSocket, code: number): void {
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
      socket.close(code);
    } else {
      socket.close();
    }
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    InboxStream.logger.exception('socket_failed', error);
    socket.close(1011, 'Reconnect to recover Inbox');
  }
}
