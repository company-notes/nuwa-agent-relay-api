import { exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

type AgentAddress = {
  id: string;
  org: string;
  path: string;
  address: string;
  canonical: string;
  parentAddressId: string | null;
};

export class RelayTestClient {
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly slug = 'relay-test-org';

  private readonly mailboxes: Array<{ id: number; username: string; userDomain: number }> = [];
  readonly deliveries: Array<{ to: string[]; subject: string; body: string }> = [];

  failNextMail = false;
  failAddressStatus = false;

  private readonly hostA: AgentAddress = {
    id: 'host-a',
    org: RelayTestClient.slug,
    path: 'alpha',
    address: '@alpha',
    canonical: `${RelayTestClient.slug}/alpha`,
    parentAddressId: null,
  };
  private readonly hostB: AgentAddress = {
    id: 'host-b',
    org: RelayTestClient.slug,
    path: 'beta',
    address: '@beta',
    canonical: `${RelayTestClient.slug}/beta`,
    parentAddressId: null,
  };
  private readonly workA: AgentAddress = {
    id: 'work-a',
    org: RelayTestClient.slug,
    path: 'alpha/author',
    address: '@alpha/author',
    canonical: `${RelayTestClient.slug}/alpha/author`,
    parentAddressId: 'host-a',
  };
  private readonly workC: AgentAddress = {
    id: 'work-c',
    org: RelayTestClient.slug,
    path: 'beta/observer',
    address: '@beta/observer',
    canonical: `${RelayTestClient.slug}/beta/observer`,
    parentAddressId: 'host-b',
  };

  private readonly workB: AgentAddress = {
    id: 'work-b',
    org: RelayTestClient.slug,
    path: 'beta/reviewer',
    address: '@beta/reviewer',
    canonical: `${RelayTestClient.slug}/beta/reviewer`,
    parentAddressId: 'host-b',
  };

  private requestAgentAddress(url: URL, token: string | null): Response {
    if (token !== 'Bearer token-a' && token !== 'Bearer token-b' && token !== 'Bearer token-c') {
      return Response.json({ ok: false, error: { message: 'Invalid OAuth token' } }, { status: 401 });
    }

    const isAuthor = token === 'Bearer token-a';
    const work = isAuthor ? this.workA : token === 'Bearer token-b' ? this.workB : this.workC;
    const host = isAuthor ? this.hostA : this.hostB;

    if (url.pathname === '/v1/account/status') {
      if (this.failAddressStatus) {
        return Response.json({ ok: false, error: { message: 'Upstream unavailable' } }, { status: 503 });
      }

      const requestedWorkId = url.searchParams.get('work_address_id');

      if (requestedWorkId && requestedWorkId !== work.id) {
        return Response.json({ ok: false, error: { message: 'Work not owned' } }, { status: 403 });
      }

      return Response.json({
        ok: true,
        data: {
          organization: { id: 'org-id', slug: RelayTestClient.slug },
          hosts: [host],
          work: requestedWorkId ? work : null,
        },
      });
    }

    if (url.pathname === '/v1/account/resolve') {
      const address = url.searchParams.get('address');
      const found = [this.hostA, this.hostB, this.workA, this.workB, this.workC].find(
        (candidate) => address === candidate.address || address === candidate.canonical,
      );

      if (!found) {
        return Response.json({ ok: false, error: { message: 'Not found' } }, { status: 404 });
      }

      return Response.json({ ok: true, data: found });
    }

    throw new Error(`Unexpected Agent Address request: ${url.pathname}`);
  }

  private requestMailTrigger(url: URL, init?: RequestInit): Response {
    if (url.pathname === '/api/v1/domains/') {
      return Response.json([{ id: 1, domainName: 'relay-test.example', isVerified: true }]);
    }

    if (url.pathname === '/api/v1/mailbox/' && init?.method === 'POST') {
      const data = JSON.parse(String(init.body)) as { username: string; userDomain: number };
      const mailbox = { id: this.mailboxes.length + 1, username: data.username, userDomain: data.userDomain };
      this.mailboxes.push(mailbox);

      return Response.json(mailbox, { status: 201 });
    }

    if (url.pathname === '/api/v1/mailbox/' && !init?.method) {
      return Response.json(this.mailboxes);
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
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.hostname === 'address.company-notes.com') {
      const token = new Headers(init?.headers).get('authorization');

      return this.requestAgentAddress(url, token);
    }

    if (url.hostname === 'app.mailtrigger.app') {
      return this.requestMailTrigger(url, init);
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

  async provisionBothHosts(): Promise<void> {
    const first = await this.call('token-a', 'POST', '/v1/hosts/provision?work_address_id=work-a');
    const second = await this.call('token-b', 'POST', '/v1/hosts/provision?work_address_id=work-b');

    expect(first.status, 'Sender mailbox should be provisioned').toBe(201);
    expect(second.status, 'Recipient mailbox should be provisioned').toBe(201);
  }
}
