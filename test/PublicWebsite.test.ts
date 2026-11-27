import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/Env';
import { RelayAPI } from '../src/Index';
import { RelayTestClient } from './RelayTestClient';

class WebsiteScenario {
  readonly requests: Request[] = [];
  readonly api = new RelayAPI({ ...env, MCP_WORKER: {
    fetch: async (request: Request) => {
      this.requests.push(request);
      const path = new URL(request.url).pathname;

      return new Response(path, { headers: {
        'content-security-policy': "script-src 'self'", 'cache-control': 'public, max-age=300',
      } });
    },
  } as Env['MCP_WORKER'] });
}

describe('Canonical Relay website routing', () => {
  it('serves the onboarding page and its assets without forwarding browser credentials', async () => {
    const scenario = new WebsiteScenario();

    for (const path of ['/', '/start', '/start.css', '/start.js']) {
      const response = await scenario.api.handle(new Request(RelayTestClient.origin + path, {
        headers: { cookie: 'private=browser', authorization: 'Bearer private-token' },
      }));
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(path);
      expect(response.headers.get('content-security-policy')).toBe("script-src 'self'");
    }

    expect(scenario.requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/', '/start', '/start.css', '/start.js',
    ]);
    for (const request of scenario.requests) {
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.headers.has('authorization')).toBe(false);
    }
  });
});
