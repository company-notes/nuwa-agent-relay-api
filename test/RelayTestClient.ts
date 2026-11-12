import { env, exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

const MAILTRIGGER_TEST_ORIGIN = new URL(env.MAILTRIGGER_API_URL).origin;

type Session = {
  id: string;
  agentId: string;
  canonical: string;
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

  failNextMail = false;
  failNextWake = false;
  redirectNextWake = false;
  failAddressStatus = false;
  failNextRouteCreation = false;
  failNextRouteLookup = false;
  failNextRouteDeletion = false;
  providerCreatesOriginRoutes = false;
  failNextActionDeletion = false;
  failNextWebhookParameterUpdate = false;
  autoReceiptDuringMailSend = false;
  duplicateWebhookParameterFields = false;

  private readonly sessionA: Session = {
    id: 'session-a',
    agentId: 'agent-a',
    canonical: RelayTestClient.slug + '/alpha/author',
  };
  private readonly sessionB: Session = {
    id: 'session-b',
    agentId: 'agent-b',
    canonical: RelayTestClient.slug + '/beta/reviewer',
  };
  private readonly sessionC: Session = {
    id: 'session-c',
    agentId: 'agent-b',
    canonical: RelayTestClient.slug + '/beta/observer',
  };

  private requestAgentAddress(url: URL, token: string | null, init?: RequestInit): Response {
    if (!['Bearer token-a', 'Bearer token-b', 'Bearer token-c'].includes(token ?? '')) {
      return Response.json({ ok: false, error: { code: 'unauthorized' } }, { status: 401 });
    }

    if (url.pathname === '/v2/account/status') {
      if (this.failAddressStatus) {
        return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
      }

      return Response.json({
        ok: true,
        data: {
          account: { email: 'test@example.com' },
          organization: { id: 'org-id', slug: RelayTestClient.slug },
        },
      });
    }

    const matched = url.pathname.match(/^\/v2\/account\/sessions\/([^/]+)(\/heartbeat)?$/);

    if (matched) {
      const session = [this.sessionA, this.sessionB, this.sessionC]
        .find((candidate) => candidate.id === matched[1]);

      if (!session) {
        return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
      }

      if (matched[2]) {
        const provided = JSON.parse(String(init?.body)) as { runtimeToken: string };
        const expected = session.id.replace('session-', 'runtime-');

        if (init?.method !== 'POST' || provided.runtimeToken !== expected) {
          return Response.json({ ok: false, error: { code: 'runtime_not_owner' } }, { status: 409 });
        }

        return Response.json({
          ok: true, data: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
        });
      }

      return Response.json({ ok: true, data: session });
    }

    if (url.pathname === '/v2/account/resolve') {
      const input = url.searchParams.get('address');
      const session = [this.sessionA, this.sessionB, this.sessionC].find((item) =>
        input === item.canonical ||
        input === item.canonical.split('/').slice(0, 2).join('/') &&
          item.id !== this.sessionC.id);

      return session
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
      return Response.json([{ id: 1, domainName: 'relay-test.example', isVerified: true, user: 31 }]);
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

      return new Response(null, { status: 201 });
    }

    throw new Error(`Unexpected MailTrigger request: ${url.pathname}`);
  }

  private async externalFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
      if (url.pathname === '/register' && init?.method === 'POST') {
        const registration = JSON.parse(String(init.body));
        expect(registration.redirect_uris).toEqual([
          'https://agent-relay.company-notes.com/wake-pair/oauth/callback',
        ]);
        expect(init.redirect).toBe('manual');

        return Response.json({ client_id: 'test-pairing-oauth-client' }, { status: 201 });
      }

      if (url.pathname === '/token' && init?.method === 'POST') {
        const request = new URLSearchParams(String(init.body));
        expect(request.get('code_verifier')).toMatch(/^[a-f0-9]{64}$/);
        expect(request.get('grant_type')).toBe('authorization_code');
        expect(init.redirect).toBe('manual');

        return Response.json({
          access_token: request.get('code') === 'owned-a' || request.get('code') === 'different-owner'
            ? 'token-a' : request.get('code') === 'owned-c' ? 'token-c' : 'token-b',
          token_type: 'Bearer',
        });
      }

      const token = new Headers(init?.headers).get('authorization');

      return this.requestAgentAddress(url, token, init);
    }

    if (url.origin === MAILTRIGGER_TEST_ORIGIN) {
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
    vi.stubGlobal('fetch', this.externalFetch.bind(this));
  }

  async call(
    token: 'token-a' | 'token-b' | 'token-c' | null,
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

  async confirmLatestWake(token: 'token-a' | 'token-b' | 'token-c' = 'token-b') {
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

  async callWithHeaders(
    method: string,
    path: string,
    data: object,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const response = await exports.default.fetch(
      new Request(`${RelayTestClient.origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(data),
      }),
    );

    return { status: response.status, body: await response.json() };
  }

  async provisionAgentMailboxes(): Promise<void> {
    const first = await this.call('token-a', 'POST', '/v2/agents/mailbox?session_id=session-a');
    const second = await this.call('token-b', 'POST', '/v2/agents/mailbox?session_id=session-b');

    expect(first.status, 'Sender Agent mailbox should be provisioned').toBe(201);
    expect(second.status, 'Recipient Agent mailbox should be provisioned').toBe(201);
  }
}
