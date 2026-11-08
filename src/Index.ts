import { AddressClient } from './AddressClient';
import { AliasService } from './AliasService';
import type { Env } from './Env';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { IdentityContext } from './IdentityContext';
import { MailReceipt } from './MailReceipt';
import { WakeService } from './WakeService';
import { RelayService, type NewMessage } from './RelayService';

export class RelayAPI {
  private static authorization(request: Request): string {
    const header = request.headers.get('authorization');

    if (!header || !/^Bearer\s+\S+$/i.test(header)) {
      throw new APIError(401, 'unauthorized', 'Agent Address OAuth bearer token is required.');
    }

    return header;
  }

  private static readMessage(data: JSONRecord, handoff: boolean): NewMessage {
    const body = HTTP.requiredString(data, 'body', 100_000);
    const subject = handoff
      ? HTTP.requiredString(data, 'subject', 255)
      : HTTP.optionalString(data, 'subject', 255) ?? 'Agent Relay message';

    return {
      to: AliasService.readRecipient(data.to),
      subject,
      body,
      artifactLinks: HTTP.artifacts(data),
    };
  }

  private static match(pathname: string, pattern: RegExp): string | null {
    return pathname.match(pattern)?.[1] ?? null;
  }

  constructor(private readonly env: Env) {}

  private async routeAliases(
    request: Request,
    pathname: string,
    aliases: AliasService,
  ): Promise<Response | null> {
    if (request.method === 'POST' && pathname === '/v1/aliases') {
      const data = await HTTP.json(request);
      const alias = await aliases.create(
        HTTP.requiredString(data, 'provider', 32),
        HTTP.requiredString(data, 'externalId', 255),
      );

      return HTTP.response(alias, 201);
    }

    if (request.method === 'GET' && pathname === '/v1/aliases') {
      return HTTP.response(await aliases.list());
    }

    const aliasId = RelayAPI.match(pathname, /^\/v1\/aliases\/([^/]+)$/);

    if (request.method === 'DELETE' && aliasId) {
      return HTTP.response(await aliases.revoke(aliasId));
    }

    const verificationId = RelayAPI.match(pathname, /^\/v1\/aliases\/([^/]+)\/verification$/);

    if (request.method === 'POST' && verificationId) {
      const key = request.headers.get('x-relay-verification-key');

      return HTTP.response(await aliases.verify(verificationId, key));
    }

    return null;
  }

  private async routeMessages(
    request: Request,
    pathname: string,
    relay: RelayService,
  ): Promise<Response | null> {
    if (request.method === 'POST' && (pathname === '/v1/messages' || pathname === '/v1/handoffs')) {
      const data = await HTTP.json(request);
      const handoff = pathname === '/v1/handoffs';
      const message = RelayAPI.readMessage(data, handoff);

      return HTTP.response(await relay.send(handoff ? 'handoff' : 'message', message), 201);
    }

    if (request.method === 'GET' && pathname === '/v1/inbox') {
      return HTTP.response(await relay.inbox());
    }

    if (request.method === 'GET' && pathname === '/v1/host-inbox') {
      return HTTP.response(await relay.hostInbox());
    }

    return null;
  }

  private async routeHandoffs(
    request: Request,
    pathname: string,
    relay: RelayService,
  ): Promise<Response | null> {
    const handoffAcceptanceId = RelayAPI.match(pathname, /^\/v1\/handoffs\/([^/]+)\/accept$/);

    if (request.method === 'POST' && handoffAcceptanceId) {
      return HTTP.response(await relay.acceptHandoff(handoffAcceptanceId), 201);
    }

    const handoffReplyId = RelayAPI.match(pathname, /^\/v1\/handoffs\/([^/]+)\/reply$/);

    if (request.method === 'POST' && handoffReplyId) {
      const data = await HTTP.json(request);

      return HTTP.response(
        await relay.replyToHandoff(
          handoffReplyId,
          HTTP.requiredString(data, 'body', 100_000),
          HTTP.artifacts(data),
        ),
        201,
      );
    }

    return null;
  }

  private async routeThreads(
    request: Request,
    pathname: string,
    relay: RelayService,
  ): Promise<Response | null> {
    const threadId = RelayAPI.match(pathname, /^\/v1\/threads\/([^/]+)$/);

    if (request.method === 'GET' && threadId) {
      return HTTP.response(await relay.history(threadId));
    }

    const threadReplyId = RelayAPI.match(pathname, /^\/v1\/threads\/([^/]+)\/messages$/);

    if (request.method === 'POST' && threadReplyId) {
      const data = await HTTP.json(request);

      return HTTP.response(
        await relay.reply(
          threadReplyId,
          HTTP.requiredString(data, 'body', 100_000),
          HTTP.optionalString(data, 'subject', 255),
          HTTP.artifacts(data),
        ),
        201,
      );
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/health') {
      return HTTP.response({ service: 'nuwa-agent-relay-api', status: 'ok' });
    }

    // MailTrigger uses a separate high-entropy key; never require Agent Address
    // OAuth on a server-to-server inbound receipt.
    if (request.method === 'POST' && pathname === '/v1/mailtrigger/receipt') {
      return new MailReceipt(this.env).receive(request);
    }

    if (request.method === 'GET' && pathname === '/') {
      return HTTP.response({
        service: 'Nuwa Agent Relay API',
        canonicalHost: url.host,
        documentation: 'https://github.com/company-notes/nuwa-agent-relay-api',
      });
    }

    const authorization = RelayAPI.authorization(request);
    const addressClient = new AddressClient(this.env, authorization);
    const status = await addressClient.getStatus(
      url.searchParams.get('work_address_id') ?? undefined,
    );
    const identity = new IdentityContext(status);

    const relay = new RelayService(this.env, identity, addressClient);
    const aliases = new AliasService(this.env, identity);

    if (request.method === 'POST' && pathname === '/v1/wake-subscription') {
      const data = await HTTP.json(request);
      const callback = HTTP.requiredString(data, 'callbackUrl', 2048);

      return HTTP.response(await new WakeService(this.env, identity).subscribe(callback), 201);
    }

    if (pathname === '/v1/wake-subscription' && request.method === 'GET') {
      return HTTP.response(await new WakeService(this.env, identity).getSubscription());
    }

    if (pathname === '/v1/wake-subscription' && request.method === 'DELETE') {
      return HTTP.response(await new WakeService(this.env, identity).unsubscribe());
    }

    if (pathname === '/v1/wake-events' && request.method === 'GET') {
      return HTTP.response(await new WakeService(this.env, identity).deliveries());
    }

    const messageId = RelayAPI.match(pathname, /^\/v1\/messages\/([^/]+)$/);

    if (request.method === 'GET' && messageId) {
      return HTTP.response(await relay.messageById(messageId));
    }

    const readId = RelayAPI.match(pathname, /^\/v1\/messages\/([^/]+)\/read$/);

    if (request.method === 'POST' && readId) {
      return HTTP.response(await relay.acknowledgeRead(readId), 201);
    }

    const receiptId = RelayAPI.match(pathname, /^\/v1\/messages\/([^/]+)\/receipt$/);

    if (request.method === 'GET' && receiptId) {
      return new MailReceipt(this.env).status(
        receiptId, identity.organization.id, identity.work.id,
        url.searchParams.get('refresh') === 'archive',
      );
    }

    if (request.method === 'DELETE' && pathname === '/v1/smoke/host') {
      const runId = HTTP.requiredString(
        { runId: url.searchParams.get('run_id') },
        'runId',
        10,
      );

      return HTTP.response(await relay.cleanupSmokeHost(runId));
    }

    if (request.method === 'POST' && pathname === '/v1/hosts/provision') {
      return HTTP.response(await relay.provisionHost(), 201);
    }

    const aliasResponse = await this.routeAliases(request, pathname, aliases);
    if (aliasResponse) {
      return aliasResponse;
    }

    const messageResponse = await this.routeMessages(request, pathname, relay);
    if (messageResponse) {
      return messageResponse;
    }

    const handoffResponse = await this.routeHandoffs(request, pathname, relay);
    if (handoffResponse) {
      return handoffResponse;
    }

    const threadResponse = await this.routeThreads(request, pathname, relay);
    if (threadResponse) {
      return threadResponse;
    }

    throw new APIError(404, 'not_found', 'Endpoint not found.');
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Receipt Webhook is the live arrival path. Do not poll provider Archives
    // periodically; only retry persisted Wake events here.
    await WakeService.dispatchDue(env);
  },

  async fetch(
    request: Request, env: Env,
    context?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type,x-relay-verification-key',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      const response = await new RelayAPI(env).handle(request);
      response.headers.set('access-control-allow-origin', '*');

      // The authenticated MailTrigger Route can accelerate wake delivery.
      // Cron remains the durable retry/fallback. Never dispatch on send-201.
      if (request.method === 'POST' &&
        new URL(request.url).pathname === '/v1/mailtrigger/receipt' &&
        response.ok && context && env.WAKE_ALLOWED_HOSTS) {
        context.waitUntil(WakeService.dispatchDue(env));
      }

      return response;
    } catch (error) {
      const response = HTTP.error(error);
      response.headers.set('access-control-allow-origin', '*');

      return response;
    }
  },
};
