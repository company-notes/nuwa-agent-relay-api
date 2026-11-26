import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

export class ManagementLoginScenario {
  async signIn(code: string, section = 'session-replies', policyID?: string) {
    const query = new URLSearchParams({ section });
    if (policyID) {
      query.set('collaboration', policyID);
    }

    const begin = await exports.default.fetch(new Request(
      RelayTestClient.origin + '/manage/session?' + query, { redirect: 'manual' },
    ));
    expect(begin.status, 'The management entry must redirect directly to Agent Address').toBe(302);
    const location = new URL(begin.headers.get('location')!);
    expect(location.origin).toBe('https://address.company-notes.com');
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const flowCookie = begin.headers.get('set-cookie')!.split(';')[0];
    const callback = RelayTestClient.origin + '/manage/callback?code=' + code +
      '&state=' + location.searchParams.get('state');

    const invalid = await exports.default.fetch(new Request(callback));
    expect(invalid.status, 'The OAuth callback requires its initiating browser').toBe(403);
    const complete = await exports.default.fetch(new Request(callback, {
      headers: { cookie: flowCookie },
    }));
    expect(complete.status).toBe(200);
    expect(complete.headers.get('cache-control')).toBe('no-store');
    const html = await complete.text();
    const data = JSON.parse(html.match(/<script id="management-login" type="application\/json">([^<]+)<\/script>/)![1]);
    expect(data.target).toBe('/manage/' + section + (policyID ? '?collaboration=' + policyID : ''));
    const cookie = complete.headers.getSetCookie().find((value) => value.startsWith('__Host-nuwa_owner_'))!.split(';')[0];

    return { token: data.accessToken as string, cookie };
  }
}
