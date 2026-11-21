import { env, exports } from 'cloudflare:workers';
import { AgentAddressTransport } from '../src/AgentAddressTransport';
import { AuthorizedAgentDirectoryCache } from '../src/AuthorizedAgentDirectoryCache';
import { expect, vi } from 'vitest';

const MAILTRIGGER_TEST_ORIGIN = new URL(env.MAILTRIGGER_API_URL).origin;

type Session = {
  id: string;
  agentId: string;
  canonical: string;
  agentDisplayName?: string;
};

export class RelayTestClient {
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly slug = 'relay-test-org';

  private readonly mailboxes: Array<{ id: number; username: string; userDomain: number }> = [];
  readonly deliveries: Array<{ to: string[]; subject: string; body: string }> = [];
  readonly rules: Array<Record<string, unknown>> = [];
  readonly actions: Array<Record<string, unknown>> = [];
  readonly templates: Array<Record<string, unknown>> = [{
    id: 21,
    actionName: 'RelaySMTP',
    displayName: 'MailTrigger SMTP',
    version: 1,
    isActive: true,
  }, {
    id: 22,
    actionName: 'Webhook',
    displayName: 'Webhook (API)',
    version: 1,
    isActive: true,
  }];
  readonly routes: Array<Record<string, unknown>> = [];
  readonly routeCreationBodies: Array<Record<string, unknown>> = [];
  readonly webhookParameters = new Map<number, Array<Record<string, unknown>>>();
  private readonly mailboxArchives = new Map<number, Array<{ id: string; subject: string; body: string }>>();
  readonly wakeCallbacks: Array<{ body: any; signature: string | null }> = [];
  readonly wakeChallenges: Array<{ verificationId: string; challenge: string; sessionID: string }> = [];
  readonly wakeRequests: Array<{ body: any; authorization: string | null; url: string; redirect: RequestRedirect | undefined }> = [];
  readonly officeRegistrations: Array<{ displayName: string; agentName: string }> = [];
  private readonly officeAgents: Array<Session & {
    registrationID: string; handle: string; displayName: string; createdAt: string;
  }> = [];

  loseNextOfficeRegistrationResponse = false;
  failNextMail = false;
  loseNextMailAcknowledgement = false;
  failNextWake = false;
  redirectNextWake = false;
  failAddressStatus = false;
  accountStatusLookups = 0;
  sessionLookups = 0;
  officeSelectionLookups = 0;
  runtimeLeaseLookups = 0;
  failPublicAddressRequests = false;
  failNextRouteCreation = false;
  failNextRouteLookup = false;
  failNextRouteDeletion = false;
  providerCreatesOriginRoutes = false;
  failNextActionDeletion = false;
  failNextWebhookParameterUpdate = false;
  nameDirectoryLookups = 0;
  domainLookups = 0;
  mailTriggerRequests = 0;
  actionTemplateLookups = 0;
  domainVerified = true;
  corruptNameDirectory = false;
  autoReceiptDuringMailSend = false;
  mailboxCreationDelayMs = 0;
  activeMailboxCreations = 0;
  maxConcurrentMailboxCreations = 0;
  duplicateWebhookParameterFields = false;

  private readonly sessionA: Session = {
    id: 'session-a',
    agentId: 'agent-000a',
    canonical: RelayTestClient.slug + '/alpha/author',
    agentDisplayName: '小晴',
  };
  private readonly sessionB: Session = {
    id: 'session-b',
    agentId: 'agent-000b',
    canonical: RelayTestClient.slug + '/beta/reviewer',
    agentDisplayName: '大熊',
  };
  private readonly sessionC: Session = {
    id: 'session-c',
    agentId: 'agent-000b',
    canonical: RelayTestClient.slug + '/beta/observer',
  };
  private readonly sessionD: Session = {
    id: 'session-d',
    agentId: 'agent-000d',
    canonical: RelayTestClient.slug + '/gamma/main',
  };
  private readonly sessionG: Session = {
    id: 'session-g',
    agentId: 'agent-000g',
    canonical: RelayTestClient.slug + '/gateway/main',
    agentDisplayName: 'Gateway',
  };
  private readonly sessionH: Session = {
    id: 'session-h',
    agentId: 'agent-000h',
    canonical: RelayTestClient.slug + '/gateway-2/main',
  };

  private organizationSlug = RelayTestClient.slug;
  private identityRevision = 0;
  private readonly archivedSessions = new Set<string>();
  private readonly previousAddresses = new Map<string, Session>();

  private sessions(): Session[] {
    return [this.sessionA, this.sessionB, this.sessionC, this.sessionD, this.sessionG, this.sessionH,
      ...this.officeAgents];
  }

  renameOrganization(slug: string) {
    for (const session of this.sessions()) {
      this.previousAddresses.set(session.canonical, session);
      session.canonical = slug + '/' + session.canonical.split('/').slice(1).join('/');
    }

    this.organizationSlug = slug;
    this.identityRevision += 1;
  }

  renameOfficeAddress(sessionID: string, handle: string, displayName?: string) {
    const agent = this.officeAgents.find((item) => item.id === sessionID);

    if (!agent) {
      throw new Error('Missing office test identity.');
    }

    this.previousAddresses.set(agent.canonical, agent);
    agent.handle = handle;
    agent.canonical = this.organizationSlug + '/' + handle + '/main';
    if (displayName !== undefined) {
      agent.displayName = displayName;
      agent.agentDisplayName = displayName;
    }

    this.identityRevision += 1;
  }

  archiveOfficeSession(sessionID: string) {
    this.archivedSessions.add(sessionID);
    this.identityRevision += 1;
  }

  private requestAgentAddress(url: URL, token: string | null, init?: RequestInit): Response {
    if (!['Bearer token-a', 'Bearer token-b', 'Bearer token-c', 'Bearer token-d', 'Bearer token-g', 'Bearer token-h', 'Bearer token-foreign'].includes(token ?? '')) {
      return Response.json({ ok: false, error: { code: 'unauthorized' } }, { status: 401 });
    }

    if (url.pathname === '/v2/account/status') {
      this.accountStatusLookups += 1;

      if (this.failAddressStatus) {
        return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
      }

      return Response.json({
        ok: true,
        data: {
          account: { email: 'test@example.com' },
          organization: token === 'Bearer token-foreign'
            ? { id: 'org-other', slug: 'other-organization', identityRevision: 0 }
            : { id: 'org-id', slug: this.organizationSlug, identityRevision: this.identityRevision },
        },
      });
    }

    const registration = url.pathname.match(
      /^\/v2\/account\/agent-registrations\/(office-[a-f0-9]{32})$/,
    );

    if (registration && init?.method === 'PUT') {
      const input = JSON.parse(String(init.body)) as {
        agentName?: string; agentDisplayName: string; sessionName: string;
      };
      const existing = this.officeAgents.find((agent) => agent.registrationID === registration[1]);

      if (existing && existing.displayName !== input.agentDisplayName) {
        return Response.json({ ok: false, error: { code: 'agent_registration_conflict' } }, { status: 409 });
      }

      if (existing) {
        return Response.json({ ok: true, data: { session: existing } });
      }

      const handle = input.agentName ?? 'agent-' + crypto.randomUUID().slice(0, 8);
      const registered = {
        id: 'office-session-' + crypto.randomUUID(),
        agentId: 'office-agent-' + crypto.randomUUID(),
        registrationID: registration[1],
        canonical: this.organizationSlug + '/' + handle + '/' + input.sessionName,
        handle,
        displayName: input.agentDisplayName,
        agentDisplayName: input.agentDisplayName,
        createdAt: new Date().toISOString(),
      };
      this.officeAgents.push(registered);
      this.identityRevision += 2;
      this.officeRegistrations.push({ displayName: input.agentDisplayName, agentName: handle });

      if (this.loseNextOfficeRegistrationResponse) {
        this.loseNextOfficeRegistrationResponse = false;
        return Response.json({ ok: false, error: { code: 'response_lost' } }, { status: 503 });
      }

      return Response.json({ ok: true, data: { session: registered } });
    }

    if (url.pathname === '/v2/account/agents') {
      this.nameDirectoryLookups += 1;

      if (this.corruptNameDirectory) {
        return Response.json({ ok: true, data: [{
          id: 'agent-000b', handle: 'beta', displayName: '大熊',
          defaultSessionID: 'session-b', defaultSessionHandle: null,
        }] });
      }

      return Response.json({ ok: true, data: [
        { id: 'agent-000a', handle: 'alpha', displayName: '小晴',
          defaultSessionID: 'session-a', defaultSessionHandle: 'author' },
        { id: 'agent-000b', handle: 'beta', displayName: '大熊',
          defaultSessionID: 'session-b', defaultSessionHandle: 'reviewer' },
        { id: 'agent-000d', handle: 'gamma', displayName: '雙胞胎',
          defaultSessionID: 'session-d', defaultSessionHandle: 'main' },
        { id: 'agent-000g', handle: 'gateway', displayName: '雙胞胎',
          defaultSessionID: 'session-g', defaultSessionHandle: 'main' },
        { id: 'agent-000h', handle: 'gateway-2', displayName: '未啟用',
          defaultSessionID: null, defaultSessionHandle: null },
        ...this.officeAgents.filter((agent) => !this.archivedSessions.has(agent.id)).map((agent) => ({
          id: agent.agentId,
          handle: agent.handle,
          registrationID: agent.registrationID,
          displayName: agent.displayName,
          defaultSessionID: agent.id,
          defaultSessionHandle: 'main',
          createdAt: agent.createdAt,
        })),
      ] });
    }

    const agentUpdate = url.pathname.match(/^\/v2\/account\/agents\/([^/]+)$/);

    if (agentUpdate && init?.method === 'PATCH') {
      const agent = this.officeAgents.find((item) => item.agentId === agentUpdate[1]);

      if (!agent) {
        return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
      }

      const data = JSON.parse(String(init.body)) as { agentDisplayName: string };
      agent.displayName = data.agentDisplayName;
      agent.agentDisplayName = data.agentDisplayName;
      this.identityRevision += 1;

      return Response.json({ ok: true, data: { id: agent.agentId, displayName: agent.displayName } });
    }

    if (url.pathname === '/v2/account/sessions') {
      this.officeSelectionLookups += 1;
      const selected = new Set(url.searchParams.getAll('session_id'));

      return Response.json({ ok: true, data: {
        organization: token === 'Bearer token-foreign'
          ? { id: 'org-other', slug: 'other-organization', identityRevision: 0 }
          : { id: 'org-id', slug: this.organizationSlug, identityRevision: this.identityRevision },
        sessions: token === 'Bearer token-foreign' ? [] : this.sessions().filter((session) =>
          selected.has(session.id) && !this.archivedSessions.has(session.id)),
      } });
    }

    const matched = url.pathname.match(/^\/v2\/account\/sessions\/([^/]+)(\/runtime-lease)?$/);

    if (matched) {
      const session = this.sessions().find((candidate) => candidate.id === matched[1]);

      if (!session || this.archivedSessions.has(session.id)) {
        return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
      }

      if (matched[2]) {
        this.runtimeLeaseLookups += 1;

        if (this.failAddressStatus) {
          return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
        }

        const provided = JSON.parse(String(init?.body)) as { runtimeToken: string };
        const expected = session.id.replace('session-', 'runtime-');

        if (init?.method !== 'PATCH' || provided.runtimeToken !== expected) {
          return Response.json({ ok: false, error: { code: 'runtime_not_owner' } }, { status: 409 });
        }

        return Response.json({
          ok: true, data: {
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            ...(url.searchParams.get('include_identity') === '1' ? {
              session,
              organization: token === 'Bearer token-foreign'
                ? { id: 'org-other', slug: 'other-organization', identityRevision: 0 }
                : { id: 'org-id', slug: this.organizationSlug, identityRevision: this.identityRevision },
            } : {}),
          },
        });
      }

      this.sessionLookups += 1;

      return Response.json({ ok: true, data: session });
    }

    if (url.pathname === '/v2/account/addresses') {
      const input = url.searchParams.get('address');
      const session = this.sessions().find((item) =>
        input === item.canonical ||
        input === item.canonical.split('/').slice(0, 2).join('/') &&
          item.id !== this.sessionC.id) ?? this.previousAddresses.get(input ?? '');

      return session && !this.archivedSessions.has(session.id)
        ? Response.json({ ok: true, data: session })
        : Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
    }

    throw new Error('Unexpected Agent Address request: ' + url.pathname);
  }

  private requestRoutingResource(url: URL, init?: RequestInit): Response | null {
    const parameterList = url.pathname.match(/^\/api\/v1\/actions\/(\d+)\/parameters\/$/);
    if (parameterList && !init?.method) {
      return Response.json(this.webhookParameters.get(Number(parameterList[1])) ?? []);
    }

    const parameterItem = url.pathname.match(
      /^\/api\/v1\/actions\/(\d+)\/parameters\/(\d+)\/$/,
    );
    if (parameterItem && init?.method === 'PATCH') {
      if (this.failNextWebhookParameterUpdate) {
        this.failNextWebhookParameterUpdate = false;
        return new Response(null, { status: 503 });
      }

      const item = this.webhookParameters.get(Number(parameterItem[1]))?.find((row) =>
        Number(row.id) === Number(parameterItem[2]));
      if (!item) {
          return new Response(null, { status: 404 });
        }

      const incoming = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (typeof incoming.value !== 'string') {
        return Response.json({ error: 'Expected string value' }, { status: 400 });
      }
      item.value = incoming.value;
      return Response.json(item);
    }

    if (url.pathname === '/api/v1/action-templates/' && !init?.method) {
      this.actionTemplateLookups += 1;

      return Response.json(this.templates);
    }

    const collections: Record<string, Array<Record<string, unknown>>> = {
      '/api/v1/rules/': this.rules,
      '/api/v1/actions/': this.actions,
      '/api/v1/routes/': this.routes,
    };
    const collection = collections[url.pathname];

    if (collection) {
      if (!init?.method) {
        if (url.pathname === '/api/v1/routes/' && this.failNextRouteLookup) {
          this.failNextRouteLookup = false;

          return new Response(null, { status: 503 });
        }

        return Response.json(collection);
      }

      if (init.method === 'POST') {
        if (url.pathname === '/api/v1/routes/' && this.failNextRouteCreation) {
          this.failNextRouteCreation = false;

          return new Response(null, { status: 503 });
        }

        const value = JSON.parse(String(init.body)) as Record<string, unknown>;

        // Match the uploaded Swagger 2.0 serializer instead of accepting
        // arbitrary JSON that a real MailTrigger API would reject.
        if (url.pathname === '/api/v1/rules/' &&
          (!Number.isInteger(value.target) || !Number.isInteger(value.ruleType) ||
            typeof value.value !== 'string' || !Number.isInteger(value.user) ||
            typeof value.note !== 'string' || 'name' in value)) {
          return Response.json({ error: 'Invalid Rule serializer' }, { status: 400 });
        }

        if (url.pathname === '/api/v1/actions/' &&
          (typeof value.name !== 'string' || !Number.isInteger(value.user) ||
            !Number.isInteger(value.action) || 'actionType' in value ||
            'parameters' in value)) {
          return Response.json({ error: 'Invalid Action serializer' }, { status: 400 });
        }

        if (url.pathname === '/api/v1/routes/' &&
          (![1, 3].includes(value.filterOption as number) || !Number.isInteger(value.mailbox) ||
            !Array.isArray(value.ruleConfigs) || !Array.isArray(value.actions) ||
            typeof value.isActive !== 'boolean' || 'ruleGroup' in value ||
            'rules' in value || 'isEnabled' in value || 'mailFilterOption' in value)) {
          return Response.json({ error: 'Invalid Route serializer' }, { status: 400 });
        }

        const nextId = Math.max(0, ...collection.map((entry) => Number(entry.id))) + 1;
        const row = url.pathname === '/api/v1/routes/'
          ? { id: nextId, ...value, ruleGroup: 1 }
          : { id: nextId, ...value };

        if (url.pathname === '/api/v1/routes/') {
          this.routeCreationBodies.push(value);
        }

        collection.push(row);

        if (url.pathname === '/api/v1/actions/' && value.action === 22) {
          // MailTrigger's actual ActionConfigParameterSerializer returns fieldName,
          // not name. Duplicate template fields produce duplicate config parameters.
          const fields = ['method', 'webhook_url', 'headers', 'data', 'params', 'timeout'];
          const parameters = fields.map((fieldName, index) => ({
            id: nextId * 100 + index + 1, fieldName, value: '',
          }));
          if (this.duplicateWebhookParameterFields) {
            for (const fieldName of ['method', 'webhook_url', 'headers', 'data', 'params']) {
              parameters.push({
                id: nextId * 100 + parameters.length + 1, fieldName, value: '',
              });
            }
          }
          this.webhookParameters.set(nextId, parameters);
        }

        return Response.json(row, { status: 201 });
      }
    }

    const resource = url.pathname.match(/^\/api\/v1\/(rules|actions|routes)\/(\d+)\/$/);

    if (resource && init?.method === 'DELETE') {
      if (resource[1] === 'routes' && this.failNextRouteDeletion) {
        this.failNextRouteDeletion = false;

        return new Response(null, { status: 503 });
      }

      if (resource[1] === 'actions' && this.failNextActionDeletion) {
        this.failNextActionDeletion = false;

        return new Response(null, { status: 503 });
      }

      const rows = collections['/api/v1/' + resource[1] + '/'];
      const index = rows.findIndex((entry) => String(entry.id) === resource[2]);

      if (index === -1) {
        return new Response(null, { status: 404 });
      }

      rows.splice(index, 1);

      if (resource[1] === 'actions') {
        this.webhookParameters.delete(Number(resource[2]));
      }

      return new Response(null, { status: 204 });
    }

    const route = url.pathname.match(/^\/api\/v1\/routes\/(\d+)\/$/);

    if (route && init?.method === 'PATCH') {
      const existing = this.routes.find((entry) => String(entry.id) === route[1]);

      if (!existing) {
        return new Response(null, { status: 404 });
      }

      Object.assign(existing, JSON.parse(String(init.body)));

      return Response.json(existing);
    }

    return null;
  }

  private requestMailTrigger(url: URL, init?: RequestInit): Response {
    const routingResponse = this.requestRoutingResource(url, init);

    if (routingResponse) {
      return routingResponse;
    }

    if (url.pathname === '/api/v1/domains/') {
      this.domainLookups += 1;

      return Response.json([{ id: 1, domainName: 'relay-test.example',
        isVerified: this.domainVerified, user: 31 }]);
    }

    if (url.pathname === '/api/v1/mailbox/' && init?.method === 'POST') {
      const data = JSON.parse(String(init.body)) as { username: string; userDomain: number };
      const mailbox = {
        id: this.mailboxes.length + 1,
        username: data.username,
        userDomain: data.userDomain,
      };

      this.mailboxes.push(mailbox);

      if (this.providerCreatesOriginRoutes) {
        // MailTrigger's mailbox provisioning can create multiple defaults
        // before Nuwa's own SMTP route is configured.
        const next = Math.max(0, ...this.routes.map((route) => Number(route.id))) + 1;
        this.routes.push({
          id: next,
          name: 'SMTP to Origin Router',
          mailbox: mailbox.id,
          ruleGroup: 1,
          filterOption: 3,
          ruleConfigs: [],
          actions: [],
          isActive: true,
        });
        this.routes.push({
          id: next + 1,
          name: 'Relay to Origin',
          mailbox: mailbox.id,
          ruleGroup: 1,
          filterOption: 3,
          ruleConfigs: [],
          actions: [],
          isActive: true,
        });
      }

      return Response.json(mailbox, { status: 201 });
    }

    if (url.pathname === '/api/v1/mailbox/' && !init?.method) {
      return Response.json(this.mailboxes);
    }

    const archiveRoute = url.pathname.match(/^\/api\/v1\/mailbox\/(\d+)\/archives\/$/);

    if (archiveRoute && !init?.method) {
      return Response.json(this.mailboxArchives.get(Number(archiveRoute[1])) || []);
    }

    const mailboxRoute = url.pathname.match(/^\/api\/v1\/mailbox\/(\d+)\/$/);

    if (mailboxRoute) {
      const id = Number(mailboxRoute[1]);
      const found = this.mailboxes.find((item) => item.id === id);

      if (!found) {
        return new Response(null, { status: 404 });
      }

      if (init?.method === 'DELETE') {
        this.mailboxes.splice(this.mailboxes.indexOf(found), 1);

        return new Response(null, { status: 204 });
      }

      if (!init?.method) {
        return Response.json(found);
      }
    }

    if (url.pathname.endsWith('/mail/send/') && init?.method === 'POST') {
      if (this.failNextMail) {
        this.failNextMail = false;

        return new Response(null, { status: 503 });
      }

      const delivery = JSON.parse(String(init.body)) as { to: string[]; subject: string; body: string };
      this.deliveries.push(delivery);

      if (this.loseNextMailAcknowledgement) {
        // The provider accepted the message, but Relay never received its success response.
        this.loseNextMailAcknowledgement = false;

        return new Response(null, { status: 503 });
      }

      return new Response(null, { status: 201 });
    }

    throw new Error(`Unexpected MailTrigger request: ${url.pathname}`);
  }

  private async externalFetch(
    input: RequestInfo | URL, init?: RequestInit, privateBinding = false,
  ): Promise<Response> {
    // Cloudflare Workers rejects redirect: 'error' before making an outbound
    // request. Node's mocked fetch must enforce the same runtime restriction.
    if (init?.redirect === 'error') {
      throw new TypeError('Unsupported redirect mode: error');
    }
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.origin === MAILTRIGGER_TEST_ORIGIN && init?.method === 'POST' &&
      url.pathname.endsWith('/mail/send/') && this.autoReceiptDuringMailSend) {
      const body = JSON.parse(String(init.body)) as {
        subject: string; to: string[];
      };
      const mailboxId = Number(url.pathname.match(/mailbox\/(\d+)\/mail\/send/)?.[1]);
      const from = this.mailboxes.find((box) => box.id === mailboxId);

      if (!from) {
        throw new Error('Unknown sender mailbox in early receipt test.');
      }

      const arrived = await this.callWithHeaders('POST', '/v1/mailtrigger/receipt', {
        from: from.username + '@relay-test.example',
        receiver: body.to[0],
        subject: body.subject,
      }, { 'x-relay-inbound-key': 'test-inbound-key' });

      expect(arrived.status).toBe(200);
      expect(arrived.body.data.matched).toBe(true);
    }

    if (url.hostname === 'address.company-notes.com') {
      if (this.failPublicAddressRequests && !privateBinding) {
        throw new TypeError('Public Worker subrequest to Agent Address is unavailable.');
      }

      if (url.pathname === '/register' && init?.method === 'POST') {
        const registration = JSON.parse(String(init.body));
        expect(registration.redirect_uris).toHaveLength(1);
        expect([
          'https://agent-relay.company-notes.com/wake-pair/oauth/callback',
          'https://agent-relay.company-notes.com/manage/callback',
        ]).toContain(registration.redirect_uris[0]);
        expect(init.redirect).toBe('manual');

        return Response.json({ client_id: 'test-pairing-oauth-client' }, { status: 201 });
      }

      if (url.pathname === '/token' && init?.method === 'POST') {
        const request = new URLSearchParams(String(init.body));
        expect(request.get('code_verifier')).toMatch(/^[a-f0-9]{64}$/);
        expect(request.get('grant_type')).toBe('authorization_code');
        expect(init.redirect).toBe('manual');

        return Response.json({
          access_token: request.get('code') === 'different-owner'
            ? 'token-foreign' : request.get('code') === 'owned-a' ? 'token-a' : request.get('code') === 'owned-c' ? 'token-c' : 'token-b',
          token_type: 'Bearer',
        });
      }

      const token = new Headers(init?.headers).get('authorization');

      return this.requestAgentAddress(url, token, init);
    }

    if (url.origin === MAILTRIGGER_TEST_ORIGIN &&
      url.pathname === '/api/v1/mailbox/' && init?.method === 'POST' &&
      this.mailboxCreationDelayMs > 0) {
      this.activeMailboxCreations += 1;
      this.maxConcurrentMailboxCreations = Math.max(
        this.maxConcurrentMailboxCreations, this.activeMailboxCreations,
      );

      await new Promise<void>((resolve) => setTimeout(resolve, this.mailboxCreationDelayMs));
      this.activeMailboxCreations -= 1;
    }

    if (url.origin === MAILTRIGGER_TEST_ORIGIN) {
      this.mailTriggerRequests += 1;
      return this.requestMailTrigger(url, init);
    }

    if (['agent-hook.example.com', 'api2.cursor.sh', 'agent-demo.ngrok-free.app'].includes(url.hostname)) {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      this.wakeRequests.push({
        body, authorization: headers.get('authorization'),
        url: url.toString(), redirect: init?.redirect,
      });

      if (body.event === 'nuwa.wake.verification') {
        this.wakeChallenges.push(body);
      } else {
        this.wakeCallbacks.push({
          body,
          signature: headers.get('x-nuwa-wake-signature'),
        });
      }

      if (this.redirectNextWake) {
        this.redirectNextWake = false;
        return new Response(null, {
          status: 302, headers: { location: 'https://untrusted.example.net/steal' },
        });
      }

      if (this.failNextWake) {
        this.failNextWake = false;

        return new Response(null, { status: 503 });
      }

      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected external request: ${url.toString()}`);
  }

  installExternalTestTransport(): void {
    AuthorizedAgentDirectoryCache.shared.clear();

    vi.spyOn(AgentAddressTransport.prototype, 'request')
      .mockImplementation((input, init) => this.externalFetch(input, init, true));

    vi.stubGlobal('fetch', this.externalFetch.bind(this));
  }

  async call(
    token: 'token-a' | 'token-b' | 'token-c' | 'token-d' | 'token-g' | 'token-h' | null,
    method: string,
    path: string,
    data?: object,
    verificationKey?: string,
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};

    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers['x-nuwa-runtime-token'] = token.replace('token-', 'runtime-');
    }

    if (data !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (verificationKey) {
      headers['x-relay-verification-key'] = verificationKey;
    }

    const response = await exports.default.fetch(
      new Request(`${RelayTestClient.origin}${path}`, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    );

    return { status: response.status, body: await response.json() };
  }

  async confirmLatestWake(token: 'token-a' | 'token-b' | 'token-c' | 'token-d' | 'token-g' | 'token-h' = 'token-b') {
    const challenge = this.wakeChallenges.at(-1);
    expect(challenge, 'A real challenge POST must reach the target').toBeTruthy();
    const response = await this.call(token, 'POST',
      '/v2/wake-subscription/verification?session_id=' + challenge!.sessionID,
      { verificationId: challenge!.verificationId, challenge: challenge!.challenge });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('active');
  }

  async registerVerifiedWake(callbackURL = 'https://agent-hook.example.com/wake',
                             authMode = 'hmac', bearerToken?: string) {
    const response = await this.call('token-b', 'POST',
      '/v2/wake-subscription?session_id=session-b',
      { callbackUrl: callbackURL, authMode, ...(bearerToken ? { bearerToken } : {}) });
    expect(response.status).toBe(201);
    await this.confirmLatestWake();
    return response;
  }

  archiveDeliveredEmail(mailboxId: string, subject: string): void {
    const id = Number(mailboxId);
    const archive = this.mailboxArchives.get(id) || [];
    archive.push({ id: 'mailtrigger-archive-' + archive.length, subject, body: 'archived provider content' });
    this.mailboxArchives.set(id, archive);
  }

  async callAsSession(
    sessionID: string, method: string, path: string, data?: object,
  ): Promise<{ status: number; body: any }> {
    const separator = path.includes('?') ? '&' : '?';

    return this.callWithHeaders(method, path + separator + 'session_id=' + sessionID, data, {
      authorization: 'Bearer token-a',
      'x-nuwa-runtime-token': sessionID.replace('session-', 'runtime-'),
    });
  }

  async callWithHeaders(
    method: string,
    path: string,
    data: object | undefined,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const response = await exports.default.fetch(
      new Request(`${RelayTestClient.origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    );

    return { status: response.status, body: await response.json() };
  }

  async provisionAgentMailboxes(): Promise<void> {
    const first = await this.call('token-a', 'POST', '/v2/agent-mailboxes?session_id=session-a');
    const second = await this.call('token-b', 'POST', '/v2/agent-mailboxes?session_id=session-b');

    expect(first.status, 'Sender Agent mailbox should be provisioned').toBe(201);
    expect(second.status, 'Recipient Agent mailbox should be provisioned').toBe(201);
  }
}
