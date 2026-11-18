import { describe, expect, it } from 'vitest';

import { SessionIdentityClient } from '../src/SessionIdentityClient';

class AddressScenario {
  readonly requests: Array<{ path: string; method: string; runtimeToken?: string }> = [];
  readonly expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  private readonly organization = { id: 'org-a', slug: 'nuwa' };

  constructor(
    private readonly sessionID = 'session-a',
    private readonly authorizedToken = 'runtime-a',
    private readonly sessionAddress = 'nuwa/reviewer/main',
  ) {}

  private session() {
    return { id: this.sessionID, agentId: 'agent-a', canonical: this.sessionAddress };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const requestBody = init?.body ? JSON.parse(String(init.body)) as { runtimeToken: string } : undefined;
    this.requests.push({
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      runtimeToken: requestBody?.runtimeToken,
    });

    if (init?.headers && (init.headers as Record<string, string>).authorization !== 'Bearer oauth-a') {
      return Response.json({ ok: false, error: { code: 'unauthorized' } }, { status: 401 });
    }

    if (url.pathname === '/v2/account/status') {
      return Response.json({
        ok: true,
        data: { organization: this.organization },
      });
    }

    if (url.pathname === '/v2/account/sessions/' + this.sessionID + '/runtime-lease' &&
        init?.method === 'PATCH') {
      if (requestBody?.runtimeToken !== this.authorizedToken) {
        return Response.json({ ok: false, error: { code: 'runtime_not_owner' } }, { status: 409 });
      }

      return Response.json({
        ok: true,
        data: {
          expiresAt: this.expiresAt,
          ...(url.searchParams.get('include_identity') === '1'
            ? { session: this.session(), organization: this.organization } : {}),
        },
      });
    }

    if (url.pathname === '/v2/account/sessions/' + this.sessionID) {
      return Response.json({
        ok: true,
        data: this.session(),
      });
    }

    if (url.pathname === '/v2/account/addresses') {
      return Response.json({
        ok: true,
        data: { id: 'session-b', agentId: 'agent-b', canonical: 'nuwa/author/main' },
      });
    }

    return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
  };
}

describe('Relay V2 Session authorization', () => {
  it('returns a safe gateway error when Agent Address transport throws TypeError', async () => {
    const unreachable: typeof fetch = async () => {
      throw new TypeError('Connection failed with sensitive upstream details.');
    };
    const client = new SessionIdentityClient(
      'https://address.example.com', 'Bearer oauth-a', unreachable,
    );

    await expect(client.status()).rejects.toMatchObject({
      status: 502,
      code: 'address_transport_failed',
      message: 'Agent Address service request failed.',
    });
  });

  it('authenticates the active Runtime and obtains immutable Agent and Session identities', async () => {
    const scenario = new AddressScenario();
    const client = new SessionIdentityClient(
      'https://address.example.com',
      'Bearer oauth-a',
      scenario.fetch,
    );

    const identity = await client.authorize('session-a', 'runtime-a');

    expect(identity).toEqual({
      organizationID: 'org-a',
      organizationSlug: 'nuwa',
      agentID: 'agent-a',
      sessionID: 'session-a',
      canonicalAddress: 'nuwa/reviewer/main',
      agentDisplayName: null,
      leaseExpiresAt: scenario.expiresAt,
    });
    expect(scenario.requests).toEqual([{
      path: '/v2/account/sessions/session-a/runtime-lease?include_identity=1',
      method: 'PATCH', runtimeToken: 'runtime-a',
    }]);
    expect(scenario.requests[0].path).not.toContain('runtime-a');
  });

  it('rejects an OAuth member impersonating a Session without its Runtime capability', async () => {
    const scenario = new AddressScenario();
    const client = new SessionIdentityClient(
      'https://address.example.com',
      'Bearer oauth-a',
      scenario.fetch,
    );

    await expect(client.authorize('session-a', 'stolen-session-id-is-not-a-capability'))
      .rejects.toMatchObject({ status: 409, code: 'address_authorization_failed' });

    expect(scenario.requests).toHaveLength(1);
    expect(scenario.requests.every(({ path }) => !path.includes('stolen-session-id-is-not-a-capability')))
      .toBe(true);
  });

  it('fails closed when Account and Session identity disagree across Organizations', async () => {
    const scenario = new AddressScenario('session-a', 'runtime-a', 'foreign/reviewer/main');
    const client = new SessionIdentityClient(
      'https://address.example.com',
      'Bearer oauth-a',
      scenario.fetch,
    );

    await expect(client.authorize('session-a', 'runtime-a'))
      .rejects.toMatchObject({ status: 502, code: 'address_response_invalid' });

    expect(scenario.requests, 'Reject the inconsistent identity returned by the single renewal request')
      .toHaveLength(1);
  });

  it('resolves an Agent short address to its immutable default Session', async () => {
    const scenario = new AddressScenario();
    const client = new SessionIdentityClient(
      'https://address.example.com',
      'Bearer oauth-a',
      scenario.fetch,
    );

    expect(await client.resolve('nuwa/author')).toEqual({
      id: 'session-b',
      agentId: 'agent-b',
      canonical: 'nuwa/author/main',
    });
    expect(scenario.requests[0].path).toBe('/v2/account/addresses?address=nuwa%2Fauthor');
  });
});
