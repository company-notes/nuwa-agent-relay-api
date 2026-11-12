import { describe, expect, it } from 'vitest';

import { SessionIdentityClient } from '../src/SessionIdentityClient';

class AddressScenario {
  readonly requests: Array<{ path: string; method: string; runtimeToken?: string }> = [];

  constructor(
    private readonly sessionID = 'session-a',
    private readonly authorizedToken = 'runtime-a',
    private readonly sessionAddress = 'nuwa/reviewer/main',
  ) {}

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
        data: { organization: { id: 'org-a', slug: 'nuwa' } },
      });
    }

    if (url.pathname === '/v2/account/sessions/' + this.sessionID + '/heartbeat' &&
        init?.method === 'POST') {
        if (requestBody?.runtimeToken !== this.authorizedToken) {
          return Response.json({ ok: false, error: { code: 'runtime_not_owner' } }, { status: 409 });
        }

        return Response.json({
          ok: true,
          data: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
        });
    }

    if (url.pathname === '/v2/account/sessions/' + this.sessionID) {
      return Response.json({
        ok: true,
        data: {
          id: this.sessionID,
          agentId: 'agent-a',
          canonical: this.sessionAddress,
        },
      });
    }

    if (url.pathname === '/v2/account/resolve') {
      return Response.json({
        ok: true,
        data: { id: 'session-b', agentId: 'agent-b', canonical: 'nuwa/author/main' },
      });
    }

    return Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
  };
}

describe('Relay V2 Session authorization', () => {
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
    });
    expect(scenario.requests.map(({ path }) => path)).toEqual([
      '/v2/account/status',
      '/v2/account/sessions/session-a',
      '/v2/account/sessions/session-a/heartbeat',
    ]);
    expect(scenario.requests[2].runtimeToken).toBe('runtime-a');
    expect(scenario.requests[2].path).not.toContain('runtime-a');
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

    expect(scenario.requests).toHaveLength(3);
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

    expect(scenario.requests, 'A mismatched identity must never reach the Runtime capability exchange')
      .toHaveLength(2);
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
    expect(scenario.requests[0].path).toBe('/v2/account/resolve?address=nuwa%2Fauthor');
  });
});
