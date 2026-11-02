import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

type AgentAddress = {
  id: string;
  org: string;
  path: string;
  address: string;
  canonical: string;
  parentAddressId: string | null;
};

class RelayTestClient {
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly slug = 'relay-test-org';

  private readonly mailboxes: Array<{ id: number; username: string; userDomain: number }> = [];
  readonly deliveries: Array<{ to: string[]; subject: string; body: string }> = [];
  failNextMail = false;
  failAddressStatus = false;

  private readonly hostA: AgentAddress = {
    id: 'host-a', org: RelayTestClient.slug, path: 'alpha',
    address: '@alpha', canonical: `${RelayTestClient.slug}/alpha`, parentAddressId: null,
  };
  private readonly hostB: AgentAddress = {
    id: 'host-b', org: RelayTestClient.slug, path: 'beta',
    address: '@beta', canonical: `${RelayTestClient.slug}/beta`, parentAddressId: null,
  };
  private readonly workA: AgentAddress = {
    id: 'work-a', org: RelayTestClient.slug, path: 'alpha/author',
    address: '@alpha/author', canonical: `${RelayTestClient.slug}/alpha/author`, parentAddressId: 'host-a',
  };
  private readonly workB: AgentAddress = {
    id: 'work-b', org: RelayTestClient.slug, path: 'beta/reviewer',
    address: '@beta/reviewer', canonical: `${RelayTestClient.slug}/beta/reviewer`, parentAddressId: 'host-b',
  };

  private async externalFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    const token = headers.get('authorization');

    if (url.hostname === 'address.company-notes.com') {
      if (token !== 'Bearer token-a' && token !== 'Bearer token-b') {
        return Response.json({ ok: false, error: { message: 'Invalid OAuth token' } }, { status: 401 });
      }

      const isAuthor = token === 'Bearer token-a';
      const work = isAuthor ? this.workA : this.workB;
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
        const found = [this.hostA, this.hostB, this.workA, this.workB].find(
          (candidate) => address === candidate.address || address === candidate.canonical,
        );

        if (!found) {
          return Response.json({ ok: false, error: { message: 'Not found' } }, { status: 404 });
        }

        return Response.json({ ok: true, data: found });
      }
    }

    if (url.hostname === 'app.mailtrigger.app') {
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
    }

    throw new Error(`Unexpected external request: ${url.toString()}`);
  }

  installExternalTestTransport(): void {
    vi.stubGlobal('fetch', this.externalFetch.bind(this));
  }

  async call(
    token: 'token-a' | 'token-b' | null,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Nuwa Agent Relay real Worker/D1 core flow', () => {
  it('reports upstream Agent Address outages as a gateway failure, not a forbidden identity', async () => {
    // Regression: Agent Address HTTP 503 must not be translated into a misleading HTTP 403.
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    client.failAddressStatus = true;

    const response = await client.call('token-a', 'GET', '/v1/inbox?work_address_id=work-a');

    expect(response.status, 'An Agent Address outage must be treated as an upstream failure').toBe(502);
    expect(response.body.error.code).toBe('address_lookup_failed');
  });

  it('routes verified email and platform IDs, persists messages, and supports bidirectional replies', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const emailAlias = await client.call('token-b', 'POST', '/v1/aliases?work_address_id=work-b', {
      provider: 'email',
      externalId: 'Reviewer@Example.com',
    });
    expect(emailAlias.status, 'Registration should succeed in a pending state').toBe(201);
    expect(emailAlias.body.data.verified).toBe(false);

    const pending = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: 'reviewer@example.com',
      body: 'Review the patch',
    });
    expect(pending.status, 'Unverified aliases must not receive delivery').toBe(404);

    const deniedVerification = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${emailAlias.body.data.id}/verification?work_address_id=work-b`,
    );
    expect(deniedVerification.status, 'Alias owner alone cannot prove external ID ownership').toBe(403);

    const verified = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${emailAlias.body.data.id}/verification?work_address_id=work-b`,
      undefined,
      'test-alias-verification-key',
    );
    expect(verified.status).toBe(200);

    const grokAlias = await client.call('token-b', 'POST', '/v1/aliases?work_address_id=work-b', {
      provider: 'grokbot',
      externalId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(grokAlias.status).toBe(201);

    const grokVerified = await client.call(
      'token-b', 'POST',
      `/v1/aliases/${grokAlias.body.data.id}/verification?work_address_id=work-b`,
      undefined,
      'test-alias-verification-key',
    );
    expect(grokVerified.status).toBe(200);

    const outbound = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: { provider: 'grokbot', externalId: '550e8400-e29b-41d4-a716-446655440000' },
      body: 'Please check the release build.',
      artifactLinks: ['https://files.example.com/build.zip'],
    });

    expect(outbound.status).toBe(201);
    const threadId = outbound.body.data.threadId as string;

    const inbox = await client.call('token-b', 'GET', '/v1/inbox?work_address_id=work-b');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0].body).toBe('Please check the release build.');
    expect(inbox.body.data[0].artifactLinks).toEqual(['https://files.example.com/build.zip']);

    const saved = await env.DB.prepare('SELECT delivery_status, body FROM messages WHERE id = ?')
      .bind(outbound.body.data.id).first<{ delivery_status: string; body: string }>();
    expect(saved?.delivery_status, 'Real D1 must store a sent message').toBe('sent');
    expect(saved?.body).toBe('Please check the release build.');

    const reply = await client.call(
      'token-b', 'POST',
      `/v1/threads/${threadId}/messages?work_address_id=work-b`,
      { body: 'Verified. Build passes on Linux.' },
    );
    expect(reply.status).toBe(201);

    const history = await client.call('token-a', 'GET', `/v1/threads/${threadId}?work_address_id=work-a`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((item: any) => item.body)).toContain('Verified. Build passes on Linux.');

    expect(client.deliveries, 'MailTrigger must receive both transport calls').toHaveLength(2);
    expect(client.deliveries[0].subject).toMatch(/^\[NAR:/);

    const revoked = await client.call(
      'token-b', 'DELETE',
      `/v1/aliases/${grokAlias.body.data.id}?work_address_id=work-b`,
    );
    expect(revoked.status).toBe(200);

    const noLongerRoutable = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: { provider: 'grokbot', externalId: '550e8400-e29b-41d4-a716-446655440000' },
      body: 'This should fail.',
    });
    expect(noLongerRoutable.status).toBe(404);
  });

  it('requires the same work identity for threads and permits host-targeted handoff acceptance', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const handoff = await client.call('token-a', 'POST', '/v1/handoffs?work_address_id=work-a', {
      to: '@beta',
      subject: 'Sign this release',
      body: 'Please sign the attached artifacts.',
    });

    expect(handoff.status).toBe(201);
    const handoffId = handoff.body.data.id as string;

    const waiting = await client.call('token-b', 'GET', '/v1/host-inbox?work_address_id=work-b');
    expect(waiting.status).toBe(200);
    expect(waiting.body.data[0].body).toBe('Please sign the attached artifacts.');

    const rejectedUnacceptedReply = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/reply?work_address_id=work-b`,
      { body: 'Not accepted yet' },
    );
    expect(rejectedUnacceptedReply.status).toBe(404);

    const accepted = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/accept?work_address_id=work-b`,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.acceptedBy).toBe('relay-test-org/beta/reviewer');

    const alreadyAccepted = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/accept?work_address_id=work-b`,
    );
    expect(alreadyAccepted.status).toBe(409);

    const reply = await client.call(
      'token-b', 'POST', `/v1/handoffs/${handoffId}/reply?work_address_id=work-b`,
      { body: 'The release is signed.' },
    );
    expect(reply.status).toBe(201);

    const thread = await client.call(
      'token-a', 'GET', `/v1/threads/${handoff.body.data.threadId}?work_address_id=work-a`,
    );
    expect(thread.status).toBe(200);
    expect(thread.body.data).toHaveLength(3);

    const unauthorized = await client.call(null, 'GET', '/v1/inbox?work_address_id=work-b');
    expect(unauthorized.status).toBe(401);

    const mismatchedIdentity = await client.call('token-a', 'GET', '/v1/inbox?work_address_id=work-b');
    expect(mismatchedIdentity.status).toBe(403);
  });

  it('rejects invalid artifact links with a client error instead of an internal error', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const invalid = await client.call('token-a', 'POST', '/v1/messages?work_address_id=work-a', {
      to: '@beta/reviewer',
      body: 'This message must not be delivered.',
      artifactLinks: ['not-a-url'],
    });

    expect(invalid.status, 'Invalid user-supplied artifact URLs must return 400').toBe(400);
    expect(invalid.body.error.code).toBe('invalid_artifact_links');
    expect(client.deliveries).toHaveLength(0);
  });

  it('can retry accepting a host handoff after a MailTrigger delivery failure', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const handoff = await client.call('token-a', 'POST', '/v1/handoffs?work_address_id=work-a', {
      to: '@beta',
      subject: 'Confirm the release',
      body: 'Please acknowledge.',
    });
    expect(handoff.status).toBe(201);

    client.failNextMail = true;
    const failed = await client.call(
      'token-b', 'POST',
      `/v1/handoffs/${handoff.body.data.id}/accept?work_address_id=work-b`,
    );

    expect(failed.status, 'MailTrigger failure must be surfaced').toBe(502);

    const pending = await client.call('token-b', 'GET', '/v1/host-inbox?work_address_id=work-b');
    expect(pending.body.data, 'A failed acknowledgement must not permanently consume the handoff').toHaveLength(1);

    const retry = await client.call(
      'token-b', 'POST',
      `/v1/handoffs/${handoff.body.data.id}/accept?work_address_id=work-b`,
    );

    expect(retry.status, 'The same host must be able to retry acceptance').toBe(201);
  });
});
