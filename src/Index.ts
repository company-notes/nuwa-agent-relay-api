import { AliasService } from './AliasService';
import { AgentAddressTransport } from './AgentAddressTransport';
import { CollaborationPolicy } from './CollaborationPolicy';
import { CollaborationOwnerSession } from './CollaborationOwnerSession';
import { ManagementBrowserLogin } from './ManagementBrowserLogin';
import { ManagementLocation } from './ManagementLocation';
import { PublicWebsite } from './PublicWebsite';
import type { Env } from './Env';
import { GatewaySpeaker } from './GatewaySpeaker';
import { GatewayBindings } from './GatewayBindings';
import { GatewayFirstContactRecovery } from './GatewayFirstContactRecovery';
import type { SpeakerRequest } from './GatewaySpeaker';
import { GatewayModeCodec } from './GatewayModeCodec';
import { GatewayRoster } from './GatewayRoster';
import { APIError, HTTP, type JSONRecord } from './HTTP';
import { InboxEvents } from './InboxEvents';
import { MailReceipt } from './MailReceipt';
import { MessageOutbox } from './MessageOutbox';
import type { DeliveryResult } from './MessageDelivery';
import { OfficeGatewayEnrollment, type OfficeCoworker } from './OfficeGatewayEnrollment';
import { RelayV2Service, type RelayMessageInput } from './RelayV2Service';
import { RelayManagementPage } from './RelayManagementPage';
import { ManagementAgentReset } from './ManagementAgentReset';
import { SessionIdentityClient, type AuthorizedSession, type SessionIdentity } from './SessionIdentityClient';
import { WakeEndpointManagement } from './WakeEndpointManagement';
import { WakePairing } from './WakePairing';
import { WakeTarget } from './WakeTarget';
import { WakeService } from './WakeService';

export { InboxStream } from './InboxStream';

export class RelayAPI {
  static isManagementPath(path: string): boolean {
    return path === '/manage' || path === '/manage.js' ||
      path.startsWith('/manage/') || path.startsWith('/v2/management/');
  }

  static isWakeEndpoint(path: string): boolean {
    return /^\/v2\/management\/sessions\/[^/]+\/wake-endpoint$/.test(path);
  }

  constructor(private readonly env: Env, private readonly context?: { waitUntil(promise: Promise<unknown>): void }) {}

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
      submissionID: MessageOutbox.submissionID(data),
    };
  }

  private messageResponse(result: DeliveryResult): Response {
    if (result.outboxStatus === 'queued' && this.context) {
      this.context.waitUntil(new MessageOutbox(this.env).dispatch(result.id));
    }

    return HTTP.response(result, 201);
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

      return this.messageResponse(await relay.send(
        handoff ? 'handoff' : 'message',
        RelayAPI.message(data, handoff),
      ));
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

      if (body.autonomous !== undefined && typeof body.autonomous !== 'boolean') {
        throw new APIError(400, 'invalid_autonomous_flag', 'autonomous must be a boolean.');
      }

      return this.messageResponse(await relay.reply(
        replyID,
        HTTP.requiredString(body, 'body', 100_000),
        HTTP.optionalString(body, 'subject', 255),
        HTTP.artifacts(body),
        RelayAPI.speaker(body),
        body.messageID === undefined ? undefined : HTTP.requiredString(body, 'messageID', 255),
        body.autonomous === true,
        MessageOutbox.submissionID(body),
      ));
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

    const coworkers: OfficeCoworker[] = data.coworkers.map((record: JSONRecord) => {
      if (record.rejoinRemoved !== undefined && typeof record.rejoinRemoved !== 'boolean') {
        throw new APIError(400, 'invalid_office_roster', 'rejoinRemoved must be a boolean.');
      }

      return {
        displayName: HTTP.requiredString(record, 'displayName', 120),
        recipientBotID: HTTP.requiredString(record, 'recipientBotID', 192),
        threadMode: GatewayModeCodec.readThreadMode(HTTP.requiredString(record, 'threadMode', 32)),
        firstContactMode: GatewayModeCodec.readFirstContactMode(
          HTTP.optionalString(record, 'firstContactMode', 32) ?? 'manual',
        ),
        rejoinRemoved: record.rejoinRemoved === true,
      };
    });

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
        const botID = query.get('recipient_bot_id');

        if ([address, name, botID].filter(Boolean).length !== 1 ||
            address && address.length > 255 || name && name.length > 120 ||
            botID && botID.length > 192) {
          throw new APIError(400, 'gateway_recipient_required',
            'Specify exactly one recipient_name, recipient_address or recipient_bot_id.');
        }

        return HTTP.response(await roster.removeTeammate(
          botID ? { botID } : address ? { address } : { name: name! },
        ));
      }
    }

    if (path === '/v2/gateway-invitation') {
      if (request.method === 'GET') {
        return HTTP.response(await roster.invitation());
      }

      if (request.method === 'PUT') {
        const data = request.body ? await HTTP.json(request) : {};

        if (data.shareConnection !== undefined && typeof data.shareConnection !== 'boolean') {
          throw new APIError(400, 'invalid_office_connection', 'shareConnection must be a boolean.');
        }

        return HTTP.response(await roster.approve(data.shareConnection === true));
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

  private accountClient(authorization: string): SessionIdentityClient {
    const transport = new AgentAddressTransport(this.env.ADDRESS_WORKER);

    return new SessionIdentityClient(
      this.env.ADDRESS_API_URL, authorization, transport.request.bind(transport),
    );
  }

  private static requireManagementOrigin(request: Request, write: boolean): void {
    const origin = request.headers.get('origin');

    if (origin !== null && origin !== RelayManagementPage.origin ||
      write && origin !== RelayManagementPage.origin) {
      throw new APIError(403, 'management_origin_invalid',
        'This operation must come from Nuwa Relay management.');
    }
  }

  private async manageCollaboration(request: Request, path: string): Promise<Response> {
    const write = request.method === 'PUT';
    RelayAPI.requireManagementOrigin(request, write);
    const authorization = RelayAPI.authorization(request);
    const address = this.accountClient(authorization);
    const account = await address.status();

    if (!account.organization) {
      throw new APIError(403, 'organization_required', 'An Agent Address Organization is required.');
    }

    const canEdit = await new CollaborationOwnerSession(this.env).canEdit(request, authorization);
    const policy = new CollaborationPolicy(this.env);
    const id = RelayAPI.match(path, /^\/v2\/management\/collaboration-policies\/([^/]+)$/);

    if (!id && request.method === 'GET') {
      return HTTP.response({ canEdit, policies: await policy.list(account.organization, address) });
    }

    if (id && write) {
      if (!canEdit) {
        throw new APIError(403, 'owner_browser_required', 'Sign in through Relay management to change collaboration settings.');
      }

      const body = await HTTP.json(request);

      return HTTP.response(await policy.update(account.organization.id, id, body.mode, body.revision, address));
    }

    throw new APIError(405, 'method_not_allowed', 'Unsupported collaboration management method.');
  }

  private async wakeSessions(request: Request): Promise<Response> {
    RelayAPI.requireManagementOrigin(request, false);
    const address = this.accountClient(RelayAPI.authorization(request));
    const account = await address.status();

    if (!account.organization) {
      throw new APIError(403, 'organization_required',
        'An Agent Address Organization is required.');
    }

    const stored = await this.env.DB.prepare(
      `SELECT session_id AS sessionID, callback_url AS callbackURL,
              auth_mode AS authMode
         FROM wake_subscriptions WHERE org_id = ? ORDER BY session_id`,
    ).bind(account.organization.id).all<{
      sessionID: string; callbackURL: string; authMode: string;
    }>();

    const sessionIDs = stored.results.map((row) => row.sessionID);
    const verified = new Map<string, { canonical: string; agentDisplayName?: string | null }>();

    for (let offset = 0; offset < sessionIDs.length; offset += 25) {
      const batch = await address.selectSessions(sessionIDs.slice(offset, offset + 25));

      if (batch.organization.id !== account.organization.id) {
        throw new APIError(403, 'management_organization_mismatch',
          'Agent Address Session ownership does not match the Organization.');
      }

      for (const entry of batch.sessions) {
        verified.set(entry.id, entry);
      }
    }

    const entries = stored.results.flatMap((row) => {
      const session = verified.get(row.sessionID);
      if (!session) {
        return [];
      }

      return [{
        sessionID: row.sessionID,
        canonical: session.canonical,
        agentDisplayName: session.agentDisplayName ?? null,
        callbackHost: WakeTarget.validateURL(row.callbackURL).hostname,
        authMode: row.authMode,
      }];
    });
    const response = HTTP.response(entries);
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  private async wakeEndpoint(request: Request, path: string): Promise<Response> {
    RelayAPI.requireManagementOrigin(request, request.method !== 'GET');
    const sessionID = path.match(
      /^\/v2\/management\/sessions\/([^/]+)\/wake-endpoint$/,
    )![1];
    const address = this.accountClient(RelayAPI.authorization(request));
    const selected = await address.selectSessions([sessionID]);

    if (selected.sessions.length !== 1 || selected.sessions[0].id !== sessionID) {
      throw new APIError(403, 'wake_session_not_owned',
        'The account does not own the selected Session.');
    }

    const endpoint = new WakeEndpointManagement(
      this.env, selected.organization.id, sessionID,
    );
    let data: unknown;

    if (request.method === 'GET') {
      data = await endpoint.get();
    } else if (request.method === 'PUT') {
      const body = await HTTP.json(request);
      data = await endpoint.changeURL(HTTP.requiredString(body, 'callbackUrl', 2048));
    } else {
      throw new APIError(405, 'method_not_allowed', 'GET or PUT is required.');
    }

    const response = HTTP.response(data);
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  private async manageFirstContacts(request: Request, path: string): Promise<Response> {
    const match = path.match(
      /^\/v2\/management\/sessions\/([^/]+)\/first-contacts(\/recover)?$/,
    );
    if (!match) {
      throw new APIError(404, 'not_found', 'First-contact management route not found.');
    }

    const write = Boolean(match[2]);
    RelayAPI.requireManagementOrigin(request, write);

    const gatewaySessionID = match[1];
    const address = this.accountClient(RelayAPI.authorization(request));
    const selected = await address.selectSessions([gatewaySessionID]);

    if (selected.sessions.length !== 1 || selected.sessions[0].id !== gatewaySessionID) {
      throw new APIError(403, 'gateway_session_not_owned',
        'This account does not manage the selected Gateway Session.');
    }

    const recovery = new GatewayFirstContactRecovery(
      this.env, selected.organization.id, gatewaySessionID,
    );
    let data: unknown;

    if (!write && request.method === 'GET') {
      data = await recovery.pending();
    } else if (write && request.method === 'POST') {
      const body = await HTTP.json(request);
      if (body.confirmedNoNativeDelivery !== true) {
        throw new APIError(400, 'native_delivery_confirmation_required',
          'Confirm in the receiving platform that no native conversation was created.');
      }

      data = await recovery.recover(
        HTTP.requiredString(body, 'senderSessionID', 64),
        HTTP.requiredString(body, 'recipientSessionID', 64),
        HTTP.requiredString(body, 'initialMessageID', 64),
      );
    } else {
      throw new APIError(405, 'method_not_allowed',
        'GET for pending first contacts or POST to recover is required.');
    }

    const response = HTTP.response(data);
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  private async manageAgents(request: Request, path: string): Promise<Response> {
    const selected = path.match(/^\/v2\/management\/agents\/([^/]+)\/data$/);
    const write = request.method === 'DELETE';
    RelayAPI.requireManagementOrigin(request, write);

    const authorization = RelayAPI.authorization(request);
    const manager = new ManagementAgentReset(
      this.env, this.accountClient(authorization), authorization,
    );
    let data: unknown;

    if (path === '/v2/management/agents' && request.method === 'GET') {
      data = await manager.agents();
    } else if (selected && request.method === 'GET') {
      data = await manager.preview(selected[1]);
    } else if (selected && write) {
      const body = await HTTP.json(request);
      data = await manager.execute(
        selected[1], HTTP.requiredString(body, 'confirmation', 255),
        HTTP.requiredString(body, 'fingerprint', 128),
      );
    } else {
      throw new APIError(405, 'method_not_allowed',
        'List Agents, preview one Agent or DELETE a confirmed reset.');
    }

    const response = HTTP.response(data);
    response.headers.set('cache-control', 'no-store');

    return response;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (PublicWebsite.handles(request)) {
      return new PublicWebsite(this.env.MCP_WORKER).page(request);
    }

    if (request.method === 'GET' && ManagementLocation.isPage(path)) {
      return RelayManagementPage.page();
    }

    if (request.method === 'GET' && path === '/manage/session') {
      return new ManagementBrowserLogin(this.env).begin(request);
    }

    if (request.method === 'GET' && path === '/manage/callback') {
      return new ManagementBrowserLogin(this.env).complete(request);
    }

    if (path === '/manage.js' && request.method === 'GET') {
      return RelayManagementPage.script();
    }

    if (path === '/v2/management/collaboration-policies' || path.startsWith('/v2/management/collaboration-policies/')) {
      return this.manageCollaboration(request, path);
    }

    if (path === '/v2/management/wake-sessions' && request.method === 'GET') {
      return this.wakeSessions(request);
    }

    if (path === '/v2/management/agents' ||
        /^\/v2\/management\/agents\/[^/]+\/data$/.test(path)) {
      return this.manageAgents(request, path);
    }

    if (RelayAPI.isWakeEndpoint(path)) {
      return this.wakeEndpoint(request, path);
    }

    if (/^\/v2\/management\/sessions\/[^/]+\/first-contacts(?:\/recover)?$/.test(path)) {
      return this.manageFirstContacts(request, path);
    }

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
    response.headers.set('x-nuwa-canonical-address', identity.canonicalAddress);

    return response;
  }

  private async authorized(
    request: Request, path: string, identity: AuthorizedSession, address: SessionIdentityClient,
  ): Promise<Response> {
    if (request.method === 'GET' && path === '/v2/inbox/events') {
      return new InboxEvents(this.env, identity).page(InboxEvents.readCursor(request));
    }

    if (request.method === 'GET' && path === '/v2/inbox/events/stream') {
      return new InboxEvents(this.env, identity).subscribe(request, identity);
    }

    if (path === '/v2/collaboration-policy' && (request.method === 'GET' || request.method === 'PUT')) {
      return HTTP.response(await new CollaborationPolicy(this.env).work(identity, address, request.method === 'PUT'));
    }

    const relay = new RelayV2Service(this.env, identity, address);
    const aliases = new AliasService(this.env, identity, address);
    const gatewayBindings = new GatewayBindings(this.env, identity, address);
    const gatewayRoster = new GatewayRoster(this.env, identity, address);
    const officeGateway = new OfficeGatewayEnrollment(this.env, identity, address);

    if (path === '/v2/agent-mailboxes' && request.method === 'PUT') {
      return HTTP.response(await relay.ensureMailbox());
    }

    if (path === '/v2/agent-mailboxes' && request.method === 'POST') {
      return HTTP.response(await relay.provisionMailbox(), 201);
    }

    const receiptID = RelayAPI.match(path, /^\/v2\/messages\/([^/]+)\/receipt$/);

    if (receiptID && request.method === 'GET') {
      const from = new URL(request.url).searchParams.get('from');
      const speaker = await new GatewaySpeaker(this.env, identity, address).resolve(from === null ? undefined : AliasService.readRecipient(from));
      const reader = speaker?.identity ?? identity;

      return new MailReceipt(this.env).status(
        receiptID, reader.organizationID, reader.sessionID,
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
    await Promise.all([
      WakeService.dispatchDue(env, 'scheduled'), InboxEvents.dispatchDue(env),
      new MessageOutbox(env).dispatchDue(),
    ]);
  },

  async fetch(
    request: Request, env: Env,
    context?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const management = RelayAPI.isManagementPath(path);
    const managementOrigin = request.headers.get('origin') === RelayManagementPage.origin;

    if (request.method === 'OPTIONS') {
      if (management && !managementOrigin) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': management ? RelayManagementPage.origin : '*',
          'access-control-allow-methods': management
            ? 'GET,POST,PUT,OPTIONS' : 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': management
            ? 'authorization,content-type'
            : 'authorization,content-type,x-nuwa-runtime-token,x-relay-verification-key',
          'access-control-max-age': '86400',
          ...(management ? { vary: 'Origin' } : {}),
        },
      });
    }

    try {
      const response = await new RelayAPI(env, context).handle(request);

      if (!management || managementOrigin) {
        response.headers.set('access-control-allow-origin',
          management ? RelayManagementPage.origin : '*');
      }

      if (management) {
        response.headers.set('vary', 'Origin');
        response.headers.set('cache-control', 'no-store');
      }

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

      if (!management || managementOrigin) {
        response.headers.set('access-control-allow-origin',
          management ? RelayManagementPage.origin : '*');
      }

      if (management) {
        response.headers.set('vary', 'Origin');
        response.headers.set('cache-control', 'no-store');
      }

      return response;
    }
  },
};
