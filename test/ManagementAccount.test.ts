import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

class ManagementAccountScenario {
  readonly client = new RelayTestClient();

  constructor() {
    this.client.installExternalTestTransport();
  }

  async account(token?: string, origin = RelayTestClient.origin): Promise<Response> {
    return exports.default.fetch(new Request(RelayTestClient.origin + '/v2/management/account', {
      headers: { origin, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    }));
  }
}

describe('Management account identity', () => {
  it('shows only the verified account and organization for the authenticated management user', async () => {
    const scenario = new ManagementAccountScenario();
    const response = await scenario.account('token-a');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, data: {
      account: { email: 'test@example.com' }, organization: { slug: 'relay-test-org' },
    } });

    const foreign = await scenario.account('token-foreign');
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ ok: true, data: {
      account: { email: 'test@example.com' }, organization: { slug: 'other-organization' },
    } });

    expect((await scenario.account()).status).toBe(401);
    expect((await scenario.account('invalid-token')).status).toBe(401);
    expect((await scenario.account('token-a', 'https://untrusted.example')).status).toBe(403);
  });
});
