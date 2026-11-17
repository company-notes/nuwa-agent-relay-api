import { AliasService } from './AliasService';
import { AgentAddressTransport } from './AgentAddressTransport';
import type { Env } from './Env';
import { GatewayBindings } from './GatewayBindings';
import type { SpeakerRequest } from './GatewaySpeaker';
import { GatewayModeCodec } from './GatewayModeCodec';
import { GatewayRoster } from './GatewayRoster';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { MailReceipt } from './MailReceipt';
import { OfficeGatewayEnrollment, type OfficeCoworker } from './OfficeGatewayEnrollment';
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

  private static speaker(data: JSONRecord): SpeakerRequest {
    return {
      ...(data.from === undefined ? {} : { from: AliasService.readRecipient(data.from) }),
    };
  }

  private static message(data: JSONRecord, handoff: boolean): RelayMessageInput {
    return {
      ...RelayAPI.speaker(data),
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
      const query = new URL(request.url).searchParams;
      const rawLimit = query.get('context_limit');
      const contextLimit = rawLimit === null ? 0 : Number(rawLimit);

      if (rawLimit !== null && !/^(?:0|[1-9]|1[0-2])$/.test(rawLimit)) {
        throw new APIError(400, 'invalid_context_limit', 'Context limit must be 0–12.');
      }

      const from = query.get('from');

      return HTTP.response(await relay.message(messageID, contextLimit,
        RelayAPI.speaker(from === null ? {} : { from })));
    }

    const readID = RelayAPI.match(path, /^\/v2\/messages\/([^/]+)\/read-receipt$/);

    if (readID && request.method === 'PUT') {
      return HTTP.response(await relay.acknowledgeRead(readID), 201);
    }

    return null;
  }

  private async handoffs(
    request: Request, path: string, relay: RelayV2Service,
  ): Promise<Response | null> {
    const acceptanceID = RelayAPI.match(path, /^\/v2\/handoffs\/([^/]+)\/acceptance$/);

    if (acceptanceID && request.method === 'PUT') {
      return HTTP.response(await relay.acceptHandoff(acceptanceID), 201);
    }

    const replyID = RelayAPI.match(path, /^\/v2\/handoffs\/([^/]+)\/replies$/);

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
        RelayAPI.speaker(body),
      ), 201);
    }

    return null;
  }

  private async gateway(
    request: Request, path: string, bindings: GatewayBindings,
  ): Promise<Response | null> {
    if (path === '/v2/gateway-route') {
      if (request.method === 'GET') {
        return HTTP.response(await bindings.getRoute());
      }

      if (request.method === 'PUT') {
        const data = await HTTP.json(request);

        return HTTP.response(await bindings.setRoute(
          HTTP.requiredString(data, 'recipientBotID', 192),
          GatewayModeCodec.readThreadMode(HTTP.requiredString(data, 'threadMode', 32)),
          GatewayModeCodec.readFirstContactMode(
            HTTP.optionalString(data, 'firstContactMode', 32) ?? 'manual',
          ),
        ));
      }

      if (request.method === 'DELETE') {
        return HTTP.response(await bindings.deleteRoute());
      }
    }

    if (path === '/v2/gateway-conversations' && request.method === 'GET') {
      return HTTP.response(await bindings.getConversations());
    }

    if (path === '/v2/gateway-first-contacts' && request.method === 'GET') {
      return HTTP.response(await bindings.getFirstContacts());
    }

    const firstContactSender = RelayAPI.match(
      path, /^\/v2\/gateway-first-contacts\/([^/]+)$/,
    );

    if (firstContactSender && request.method === 'PUT') {
      const data = await HTTP.json(request);

      return HTTP.response(await bindings.confirmFirstContact(
        firstContactSender,
        HTTP.requiredString(data, 'messageID', 64),
        HTTP.requiredString(data, 'nativeThreadID', 192),
      ));
    }

    if (firstContactSender && request.method === 'DELETE') {
      return HTTP.response(await bindings.cancelFirstContact(firstContactSender));
    }

    const teammateFirstContact = path.match(
      /^\/v2\/gateway-teammates\/([^/]+)\/first-contacts\/([^/]+)$/,
    );

    if (teammateFirstContact && request.method === 'PUT') {
      const data = await HTTP.json(request);

      return HTTP.response(await bindings.confirmTeammateFirstContact(
        teammateFirstContact[1], teammateFirstContact[2],
        HTTP.requiredString(data, 'messageID', 64),
        HTTP.requiredString(data, 'nativeThreadID', 192),
      ));
    }

    const senderSessionID = RelayAPI.match(
      path, /^\/v2\/gateway-conversations\/([^/]+)$/,
    );

    if (senderSessionID && request.method === 'PUT') {
      const data = await HTTP.json(request);

      return HTTP.response(await bindings.setConversation(
        senderSessionID, HTTP.requiredString(data, 'nativeThreadID', 192),
      ));
    }

    if (senderSessionID && request.method === 'DELETE') {
      return HTTP.response(await bindings.deleteConversation(senderSessionID));
    }

    return null;
  }

  private async officeGateway(
    request: Request, path: string, enrollment: OfficeGatewayEnrollment,
  ): Promise<Response | null> {
    if (path !== '/v2/gateway-office-coworkers') {
      return null;
    }

    if (request.method === 'GET') {
      return HTTP.response(await enrollment.listOffice());
    }

    if (request.method !== 'POST') {
      return null;
    }

    const data = await HTTP.json(request);

    if (!Array.isArray(data.coworkers) ||
        data.coworkers.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new APIError(400, 'invalid_office_roster', 'A list of native coworkers is required.');
    }

    const coworkers: OfficeCoworker[] = data.coworkers.map((record: JSONRecord) => ({
      displayName: HTTP.requiredString(record, 'displayName', 120),
      recipientBotID: HTTP.requiredString(record, 'recipientBotID', 192),
      threadMode: GatewayModeCodec.readThreadMode(HTTP.requiredString(record, 'threadMode', 32)),
      firstContactMode: GatewayModeCodec.readFirstContactMode(
        HTTP.optionalString(record, 'firstContactMode', 32) ?? 'manual',
      ),
    }));

    return HTTP.response(await enrollment.enrollOffice(coworkers), 201);
  }

  private async gatewayTeammates(
    request: Request, path: string, roster: GatewayRoster,
  ): Promise<Response | null> {
    if (path === '/v2/gateway-teammates') {
      if (request.method === 'GET') {
        return HTTP.response(await roster.list());
      }

      if (request.method === 'POST') {
        const data = await HTTP.json(request);
        const address = HTTP.optionalString(data, 'recipientAddress', 255);
        const name = HTTP.optionalString(data, 'recipientName', 120);

        if (Boolean(address) === Boolean(name)) {
          throw new APIError(400, 'gateway_recipient_required',
            'Specify exactly one recipientAddress or recipientName.');
        }

        return HTTP.response(await roster.invite(
          address ? { address } : { name: name! },
          HTTP.requiredString(data, 'recipientBotID', 192),
          GatewayModeCodec.readThreadMode(HTTP.requiredString(data, 'threadMode', 32)),
          GatewayModeCodec.readFirstContactMode(
            HTTP.optionalString(data, 'firstContactMode', 32) ?? 'manual',
          ),
        ), 201);
      }

      if (request.method === 'DELETE') {
        const query = new URL(request.url).searchParams;
        const address = query.get('recipient_address');
        const name = query.get('recipient_name');

        if (Boolean(address) === Boolean(name) ||
            address && address.length > 255 || name && name.length > 120) {
          throw new APIError(400, 'gateway_recipient_required',
            'Specify exactly one valid recipient_name or recipient_address.');
        }

        return HTTP.response(await roster.removeTeammate(
          address ? { address } : { name: name! },
        ));
      }
    }

    if (path === '/v2/gateway-invitation') {
      if (request.method === 'GET') {
        return HTTP.response(await roster.invitation());
      }

      if (request.method === 'PUT') {
        return HTTP.response(await roster.approve());
      }

      if (request.method === 'DELETE') {
        return HTTP.response(await roster.leave());
      }
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

    const transport = new AgentAddressTransport(this.env.ADDRESS_WORKER);
    const address = new SessionIdentityClient(
      this.env.ADDRESS_API_URL, authorization, transport.request.bind(transport),
    );
    const identity = await address.authorize(sessionID, runtimeToken);
    const response = await this.authorized(request, path, identity, address);
    response.headers.set('x-nuwa-lease-expires-at', identity.leaseExpiresAt);

    return response;
  }

  private async authorized(
    request: Request, path: string, identity: SessionIdentity, address: SessionIdentityClient,
  ): Promise<Response> {
    const relay = new RelayV2Service(this.env, identity, address);
    const aliases = new AliasService(this.env, identity, address);
    const gatewayBindings = new GatewayBindings(this.env, identity, address);
    const gatewayRoster = new GatewayRoster(this.env, identity, address);
    const officeGateway = new OfficeGatewayEnrollment(this.env, identity, address);

    if (path === '/v2/agent-mailboxes' && request.method === 'POST') {
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
      () => this.gateway(request, path, gatewayBindings),
      () => this.gatewayTeammates(request, path, gatewayRoster),
      () => this.officeGateway(request, path, officeGateway),
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
    await WakeService.dispatchDue(env, 'scheduled');
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
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers':
            'authorization,content-type,x-nuwa-runtime-token,x-relay-verification-key',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      const response = await new RelayAPI(env).handle(request);
      response.headers.set('access-control-allow-origin', '*');

      const path = new URL(request.url).pathname;

      if (response.ok && context &&
          ((request.method === 'POST' && path === '/v1/mailtrigger/receipt') ||
            (request.method === 'PUT' &&
              (path.startsWith('/v2/gateway-first-contacts/') ||
                /^\/v2\/gateway-teammates\/[^/]+\/first-contacts\/[^/]+$/.test(path))))) {
        context.waitUntil(WakeService.dispatchDue(env,
          path === '/v1/mailtrigger/receipt' ? 'mail-receipt' : 'first-contact'));
      }

      return response;
    } catch (error) {
      const response = HTTP.error(error);
      response.headers.set('access-control-allow-origin', '*');

      return response;
    }
  },
};
