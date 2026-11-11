import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

const origin = RelayTestClient.origin;

async function open(url: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(url, {
    ...init,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(init.headers as Record<string, string> ?? {}),
    },
  }));
}

function extractCookie(response: Response, name: string): string {
  const headers = response.headers as Headers & { getSetCookie?(): string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const match = values.join('; ').match(new RegExp(name + '=([^;]+)'));

  expect(match, name + ' should be set by Relay').not.toBeNull();

  return name + '=' + match![1];
}

async function authorize(client: RelayTestClient, token: 'token-a' | 'token-b' | 'token-c' = 'token-b', work = 'work-b') {
  const created = await client.call(token, 'POST',
    '/v1/wake-pairings?work_address_id=' + work);
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({
    status: 'awaiting_user', workAddressId: work,
  });
  expect(created.body.data.pairingUrl).toMatch(
    /^https:\/\/agent-relay\.company-notes\.com\/wake-pair\/[a-f0-9]{64}$/,
  );
  expect(JSON.stringify(created.body)).not.toContain('bearerToken');

  const start = await open(created.body.data.pairingUrl);
  expect(start.status).toBe(303);
  expect(start.headers.get('referrer-policy')).toBe('no-referrer');
  const target = new URL(start.headers.get('location')!);
  expect(target.hostname).toBe('address.company-notes.com');
  expect(target.pathname).toBe('/authorize');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');
  const state = target.searchParams.get('state');
  expect(state).toMatch(/^[0-9a-f-]{36}\.[a-f0-9]{48}$/);

  const oauthCookie = extractCookie(start, '__Host-nuwa_pair_oauth');

  return { created, state: state!, oauthCookie };
}

describe('user-controlled Wake Pairing', () => {
  it('OAuth-verifies exact Work, accepts key only in private browser form, and emits one challenge', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const { created, state, oauthCookie } = await authorize(client);

    const callback = await open(origin + '/wake-pair/oauth/callback?' +
      new URLSearchParams({ state, code: 'owned-work' }), oauthCookie);

    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(origin + '/wake-pair/complete');
    const sessionCookie = extractCookie(callback, '__Host-nuwa_pair_session');
    expect(callback.headers.get('cache-control')).toBe('no-store');

    const form = await open(origin + '/wake-pair/complete', sessionCookie);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('work-b');
    expect(html).toContain('name="bearerToken"');
    expect(html).toContain('type="password"');
    expect(form.headers.get('content-security-policy')).toContain("form-action 'self'");

    const bearerToken = 'human-entered-secret-for-cursor-webhook';
    const callbackUrl = 'https://api2.cursor.sh/automations/webhook/private-path';
    const encoded = new URLSearchParams({ callbackUrl, bearerToken });

    const attempt = await open(origin + '/wake-pair/complete', sessionCookie, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin,
      },
      body: encoded.toString(),
    });
    expect(attempt.status).toBe(200);
    const body = await attempt.text();
    expect(body).toContain('Webhook 已提交驗證');
    expect(body).not.toContain(bearerToken);
    expect(body).not.toContain('private-path');

    expect(client.wakeRequests).toHaveLength(1);
    expect(client.wakeRequests[0]).toMatchObject({
      url: callbackUrl,
      authorization: 'Bearer ' + bearerToken,
      redirect: 'manual',
    });
    expect(client.wakeChallenges[0].workAddressId).toBe('work-b');

    const stored = await env.DB.prepare(
      'SELECT encrypted_target AS encrypted, callback_url AS publicURL ' +
      'FROM wake_registration_attempts WHERE work_address_id = ?',
    ).bind('work-b').first<{ encrypted: string; publicURL: string }>();
    expect(stored!.publicURL).toBe('https://api2.cursor.sh');
    expect(stored!.encrypted).not.toContain(bearerToken);
    expect(stored!.encrypted).not.toContain('private-path');

    const savedPair = await env.DB.prepare(
      'SELECT consumed_at AS consumedAt, link_digest AS linkDigest ' +
      'FROM wake_pairing_requests WHERE work_address_id = ?',
    ).bind('work-b').first<{ consumedAt: string | null; linkDigest: string }>();
    expect(savedPair!.consumedAt).toBeTruthy();
    expect(savedPair!.linkDigest).not.toContain(created.body.data.pairingUrl.split('/').at(-1));

    const replay = await open(origin + '/wake-pair/complete', sessionCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: encoded.toString(),
    });
    expect(replay.status).toBe(403);
    expect(client.wakeChallenges).toHaveLength(1);

    const subscriptionBefore = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(subscriptionBefore.body.data.enabled).toBe(false);

    await client.confirmLatestWake();

    const subscriptionAfter = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(subscriptionAfter.body.data.enabled).toBe(true);
  });

  it('rejects foreign OAuth accounts, unsanctioned forms, forged state, and consumed links', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const { created, state, oauthCookie } = await authorize(client, 'token-c', 'work-c');

    const forged = await open(origin + '/wake-pair/oauth/callback?' +
      new URLSearchParams({ state, code: 'owned-c' }), '__Host-nuwa_pair_oauth=fake');
    expect(forged.status).toBe(403);

    const otherAccount = await open(origin + '/wake-pair/oauth/callback?' +
      new URLSearchParams({ state, code: 'different-owner' }), oauthCookie);
    expect(otherAccount.status).toBe(403);

    const legitimate = await open(origin + '/wake-pair/oauth/callback?' +
      new URLSearchParams({ state, code: 'owned-c' }), oauthCookie);
    expect(legitimate.status).toBe(303);
    const sessionCookie = extractCookie(legitimate, '__Host-nuwa_pair_session');

    const direct = await open(origin + '/wake-pair/complete', undefined, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        callbackUrl: 'https://api2.cursor.sh/automations/webhook/hidden',
        bearerToken: 'secrets-not-in-MCP',
      }),
    });
    expect(direct.status).toBe(403);

    const wrongOrigin = await open(origin + '/wake-pair/complete', sessionCookie, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example.org',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        callbackUrl: 'https://api2.cursor.sh/automations/webhook/hidden',
        bearerToken: 'secrets-not-in-MCP',
      }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(client.wakeRequests).toHaveLength(0);

    const secondInvitation = await client.call('token-c', 'POST',
      '/v1/wake-pairings?work_address_id=work-c');
    expect(secondInvitation.status).toBe(429);

    // Confirm the initial invitation cannot be re-used after completion.
    const good = await open(origin + '/wake-pair/complete', sessionCookie, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        callbackUrl: 'https://api2.cursor.sh/automations/webhook/hidden',
        bearerToken: 'secrets-not-in-MCP',
      }),
    });
    expect(good.status).toBe(200);

    const reused = await open(created.body.data.pairingUrl);
    expect(reused.status).toBe(404);
  });

  it('keeps sensitive callback paths and key values out of pairing, OAuth and HTML responses', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    const { state, oauthCookie } = await authorize(client, 'token-a', 'work-a');
    const callback = await open(origin + '/wake-pair/oauth/callback?' +
      new URLSearchParams({ state, code: 'owned-a' }), oauthCookie);
    expect(callback.status).toBe(303);

    const sessionCookie = extractCookie(callback, '__Host-nuwa_pair_session');
    const secretPath = 'dont-leak-private-path';
    const key = 'dont-leak-secret-bearer-token';

    const posted = await open(origin + '/wake-pair/complete', sessionCookie, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        callbackUrl: 'https://api2.cursor.sh/automations/webhook/' + secretPath,
        bearerToken: key,
      }),
    });
    const text = await posted.text();
    expect(text).not.toContain(secretPath);
    expect(text).not.toContain(key);
    expect(posted.headers.get('referrer-policy')).toBe('no-referrer');
    expect(posted.headers.get('cache-control')).toBe('no-store');
  });
});
