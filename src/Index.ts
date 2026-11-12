import { AliasService } from './AliasService';
import type { Env } from './Env';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { MailReceipt } from './MailReceipt';
import { RelayV2Service, type RelayMessageInput } from './RelayV2Service';
import { SessionIdentityClient, type SessionIdentity } from './SessionIdentityClient';
import { WakePairing } from './WakePairing';
import { WakeService } from './WakeService';

export class RelayAPI {
  constructor(private readonly env: Env) {}

  private static authorization(request: Request): string {
    const header = request.headers.get('authorization');

    if (!header || !/^Bearer\s+\S+$/i.test(header)) {
      throw new APIError(401, 'unauthorized', 'Agent Address OAuth bearer token is required.');
    }

    return header;
  }

  private static match(path: string, pattern: RegExp): string | null {
    return path.match(pattern)?.[1] ?? null;
  }

  private static message(data: JSONRecord, handoff: boolean): RelayMessageInput {
    return {
      to: AliasService.readRecipient(data.to),
      subject: handoff
        ? HTTP.requiredString(data, 'subject', 255)
        : HTTP.optionalString(data, 'subject', 255) ?? 'Agent Relay message',
      body: HTTP.requiredString(data, 'body', 100_000),
      artifactLinks: HTTP.artifacts(data),
    };
  }

  private async aliases(
    request: Request, path: string, aliases: AliasService,
  ): Promise<Response | null> {
    if (path === '/v2/aliases' && request.method === 'POST') {
      const data = await HTTP.json(request);

      return HTTP.response(await aliases.create(
        HTTP.requiredString(data, 'provider', 32),
        HTTP.requiredString(data, 'externalId', 255),
      ), 201);
    }

    if (path === '/v2/aliases' && request.method === 'GET') {
      return HTTP.response(await aliases.list());
    }

    const aliasID = RelayAPI.match(path, /^\/v2\/aliases\/([^/]+)$/);

    if (aliasID && request.method === 'DELETE') {
      return HTTP.response(await aliases.revoke(aliasID));
    }

    const verificationID = RelayAPI.match(path, /^\/v2\/aliases\/([^/]+)\/verification$/);

    if (verificationID && request.method === 'POST') {
      return HTTP.response(await aliases.verify(
        verificationID, request.headers.get('x-relay-verification-key'),
      ));
    }

    return null;
  }

  private async messages(
    request: Request, path: string, relay: RelayV2Service,
  ): Promise<Response | null> {
    if (request.method === 'POST' && (path === '/v2/messages' || path === '/v2/handoffs')) {
      const handoff = path === '/v2/handoffs';
      const data = await HTTP.json(request);

      return HTTP.response(await relay.send(
        handoff ? 'handoff' : 'message',
        RelayAPI.message(data, handoff),
      ), 201);
    }

    if (path === '/v2/inbox' && request.method === 'GET') {
      return HTTP.response(await relay.inbox());
    }

    if (path === '/v2/agent-inbox' && request.method === 'GET') {
      return HTTP.response(await relay.agentInbox());
    }

    const messageID = RelayAPI.match(path, /^\/v2\/messages\/([^/]+)$/);

    if (messageID && request.method === 'GET') {
      const rawLimit = new URL(request.url).searchParams.get('context_limit');
      const contextLimit = rawLimit === null ? 0 : Number(rawLimit);

      if (rawLimit !== null && !/^(?:0|[1-9]|1[0-2])$/.test(rawLimit)) {
        throw new APIError(400, 'invalid_context_limit', 'Context limit must be 0–12.');
      }

      return HTTP.response(await relay.message(messageID, contextLimit));
    }

    const readID = RelayAPI.match(path, /^\/v2\/messages\/([^/]+)\/read$/);

    if (readID && request.method === 'POST') {
      return HTTP.response(await relay.acknowledgeRead(readID), 201);
    }

    return null;
  }

  private async handoffs(
    request: Request, path: string, relay: RelayV2Service,
  ): Promise<Response | null> {
    const acceptanceID = RelayAPI.match(path, /^\/v2\/handoffs\/([^/]+)\/accept$/);

    if (acceptanceID && request.method === 'POST') {
      return HTTP.response(await relay.acceptHandoff(acceptanceID), 201);
    }

    const replyID = RelayAPI.match(path, /^\/v2\/handoffs\/([^/]+)\/reply$/);

    if (replyID && request.method === 'POST') {
      const body = await HTTP.json(request);

      return HTTP.response(await relay.replyHandoff(
        replyID, HTTP.requiredString(body, 'body', 100_000),
        HTTP.artifacts(body),
      ), 201);
    }

    return null;
  }

  private async threads(
    request: Request, path: string, relay: RelayV2Service,
  ): Promise<Response | null> {
    const threadID = RelayAPI.match(path, /^\/v2\/threads\/([^/]+)$/);

    if (threadID && request.method === 'GET') {
      return HTTP.response(await relay.history(threadID));
    }

    const replyID = RelayAPI.match(path, /^\/v2\/threads\/([^/]+)\/messages$/);

    if (replyID && request.method === 'POST') {
      const body = await HTTP.json(request);

      return HTTP.response(await relay.reply(
        replyID,
        HTTP.requiredString(body, 'body', 100_000),
        HTTP.optionalString(body, 'subject', 255),
        HTTP.artifacts(body),
      ), 201);
    }

    return null;
  }

  private async wake(
    request: Request, path: string, identity: SessionIdentity,
  ): Promise<Response | null> {
    const wake = new WakeService(this.env, identity);

    if (path === '/v2/wake-pairings' && request.method === 'POST') {
      return HTTP.response(await new WakePairing(this.env).create(identity), 201);
    }

    if (path === '/v2/wake-subscription' && request.method === 'POST') {
      const data = await HTTP.json(request);

      return HTTP.response(await wake.subscribe(
        HTTP.requiredString(data, 'callbackUrl', 2048),
        (HTTP.optionalString(data, 'authMode', 32) ?? 'hmac') as
          'hmac' | 'bearer' | 'capability',
        HTTP.optionalString(data, 'bearerToken', 2048) ?? undefined,
      ), 201);
    }

    if (path === '/v2/wake-subscription/verification' && request.method === 'POST') {
      const data = await HTTP.json(request);

      return HTTP.response(await wake.verify(
        HTTP.requiredString(data, 'verificationId', 64),
        HTTP.requiredString(data, 'challenge', 128),
      ));
    }

    if (path === '/v2/wake-subscription' && request.method === 'GET') {
      return HTTP.response(await wake.getSubscription());
    }

    if (path === '/v2/wake-subscription' && request.method === 'DELETE') {
      return HTTP.response(await wake.unsubscribe());
    }

    if (path === '/v2/wake-events' && request.method === 'GET') {
      return HTTP.response(await wake.deliveries());
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.startsWith('/wake-pair/')) {
      return new WakePairing(this.env).handlePublic(request);
    }

    if (path === '/health' && request.method === 'GET') {
      return HTTP.response({ service: 'nuwa-agent-relay-api', status: 'ok' });
    }

    // This endpoint is the configured MailTrigger webhook contract.
    // Keep its HTTP URL independent of the Agent Address identity version.
    if (path === '/v1/mailtrigger/receipt' && request.method === 'POST') {
      return new MailReceipt(this.env).receive(request);
    }

    const authorization = RelayAPI.authorization(request);
    const sessionID = new URL(request.url).searchParams.get('session_id');
    const runtimeToken = request.headers.get('x-nuwa-runtime-token');

    if (!sessionID || !runtimeToken) {
      throw new APIError(400, 'session_capability_required',
        'Authenticated requests require session_id and a Runtime capability header.');
    }

    const address = new SessionIdentityClient(this.env.ADDRESS_API_URL, authorization);
    const identity = await address.authorize(sessionID, runtimeToken);
    const relay = new RelayV2Service(this.env, identity, address);
    const aliases = new AliasService(this.env, identity, address);

    if (path === '/v2/agents/mailbox' && request.method === 'POST') {
      return HTTP.response(await relay.provisionMailbox(), 201);
    }

    const receiptID = RelayAPI.match(path, /^\/v2\/messages\/([^/]+)\/receipt$/);

    if (receiptID && request.method === 'GET') {
      return new MailReceipt(this.env).status(
        receiptID, identity.organizationID, identity.sessionID,
        new URL(request.url).searchParams.get('refresh') === 'archive',
      );
    }

    const handlers = [
      () => this.aliases(request, path, aliases),
      () => this.messages(request, path, relay),
      () => this.handoffs(request, path, relay),
      () => this.threads(request, path, relay),
      () => this.wake(request, path, identity),
    ];

    for (const handler of handlers) {
      const response = await handler();

      if (response) {
        return response;
      }
    }

    throw new APIError(404, 'not_found', 'Endpoint not found.');
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
          'access-control-allow-headers':
            'authorization,content-type,x-nuwa-runtime-token,x-relay-verification-key',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      const response = await new RelayAPI(env).handle(request);
      response.headers.set('access-control-allow-origin', '*');

      if (request.method === 'POST' &&
        new URL(request.url).pathname === '/v1/mailtrigger/receipt' &&
        response.ok && context) {
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
