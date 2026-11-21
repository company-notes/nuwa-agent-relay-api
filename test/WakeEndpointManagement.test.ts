import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';
import { WakeTarget } from '../src/WakeTarget';

const path = '/v2/account-wake/sessions/session-b/endpoint';
const original = 'https://agent-hook.example.com/private-wake';
const migrated = 'https://agent-demo.ngrok-free.app/new-private-webhook';
const bearer = 'preexisting-webhook-secret-preserved';

async function portal(method: string, pathName: string, token: string | null, body?: object,
                      origin = 'https://address.company-notes.com') {
  const response = await exports.default.fetch(new Request(RelayTestClient.origin + pathName, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      origin,
    },
    body: body ? JSON.stringify(body) : undefined,
  }));

  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

describe('account-owned Wake endpoint migration', () => {
  it('lets the signed-in owner change only the URL and preserves active Wake credentials and queued messages', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.registerVerifiedWake(original, 'bearer', bearer);

    const before = await env.DB.prepare(
      'SELECT encrypted_target AS encrypted, created_at AS activated FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ encrypted: string; activated: string }>();

    const existing = await portal('GET', path, 'token-b');
    expect(existing.status).toBe(200);
    expect(existing.body.data).toMatchObject({
      enabled: true, callbackHost: 'agent-hook.example.com', authMode: 'bearer',
    });
    expect(JSON.stringify(existing.body)).not.toContain('/private-wake');
    expect(JSON.stringify(existing.body)).not.toContain(bearer);

    const changed = await portal('PUT', path, 'token-b', { callbackUrl: migrated });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({
      enabled: true, callbackHost: 'agent-demo.ngrok-free.app', authMode: 'bearer',
    });
    expect(changed.headers.get('access-control-allow-origin')).toBe('https://address.company-notes.com');

    const after = await env.DB.prepare(
      'SELECT callback_url AS host, encrypted_target AS encrypted, created_at AS activated FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ host: string; encrypted: string; activated: string }>();

    expect(after?.host).toBe('https://agent-demo.ngrok-free.app');
    expect(after?.activated).toBe(before?.activated);
    expect(after?.encrypted).not.toBe(before?.encrypted);
    expect(JSON.stringify(after)).not.toContain(bearer);
    const preserved = await WakeTarget.decrypt(env, after!.encrypted);
    expect(preserved.callbackURL).toBe(migrated);
    expect(preserved.bearerToken).toBe(bearer);

    expect(client.wakeChallenges).toHaveLength(1); // Original verification only.
    expect(client.wakeRequests).toHaveLength(1); // Updating a URL sends no new notification.
    await WakeTarget.send(preserved, { event: 'nuwa.message.available' });
    expect(client.wakeRequests.at(-1)).toMatchObject({
      url: migrated, authorization: 'Bearer ' + bearer,
    });
  });

  it('requires account ownership, valid HTTPS, an existing active receiver, and trusted Portal origin', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.registerVerifiedWake(original, 'bearer', bearer);

    expect((await portal('PUT', path, null, { callbackUrl: migrated })).status).toBe(401);
    expect((await portal('PUT', path, 'token-foreign', { callbackUrl: migrated })).status).toBe(403);
    expect((await portal('PUT', path, 'token-b', { callbackUrl: migrated },
      'https://attacker.example.com')).status).toBe(403);
    expect((await portal('PUT', '/v2/account-wake/sessions/session-a/endpoint',
      'token-a', { callbackUrl: migrated })).status).toBe(404);

    for (const invalid of ['http://agent-demo.ngrok-free.app/hooks',
      'https://localhost/hooks', 'https://agent-demo.ngrok-free.app/hooks?token=unsafe',
      'https://127.0.0.1/hooks']) {
      const attempt = await portal('PUT', path, 'token-b', { callbackUrl: invalid });
      expect(attempt.status).toBe(400);
    }

    const unchanged = await env.DB.prepare(
      'SELECT callback_url AS callbackURL FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ callbackURL: string }>();
    expect(unchanged?.callbackURL).toBe('https://agent-hook.example.com');

    const preflight = await exports.default.fetch(new Request(
      RelayTestClient.origin + path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://address.company-notes.com',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'authorization,content-type',
        },
      },
    ));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://address.company-notes.com');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');

    const deniedPreflight = await exports.default.fetch(new Request(
      RelayTestClient.origin + path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://attacker.example.com',
          'access-control-request-method': 'PUT',
        },
      },
    ));
    expect(deniedPreflight.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('changing only a Quick Tunnel host retains the protected Webhook route path', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.registerVerifiedWake(original, 'bearer', bearer);

    const updated = await portal('PUT', path, 'token-b', {
      callbackUrl: 'https://agent-demo.ngrok-free.app',
    });
    expect(updated.status).toBe(200);
    const saved = await env.DB.prepare(
      'SELECT encrypted_target AS encrypted FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ encrypted: string }>();

    const target = await WakeTarget.decrypt(env, saved!.encrypted);
    expect(target.callbackURL).toBe('https://agent-demo.ngrok-free.app/private-wake');
    expect(target.bearerToken).toBe(bear);
  });

  it('migrates a legacy signed receiver preserving the existing signature secret', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.registerVerifiedWake(original);

    const before = await env.DB.prepare(
      'SELECT encrypted_target AS encrypted, signing_secret AS secret FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ encrypted: string | null; secret: string }>();

    const updated = await portal('PUT', path, 'token-b', { callbackUrl: migrated });
    expect(updated.status).toBe(200);
    const after = await env.DB.prepare(
      'SELECT encrypted_target AS encrypted, signing_secret AS secret FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-b').first<{ encrypted: string | null; secret: string }>();
    expect(after?.secret).toBe(before?.secret);
    if (before?.encrypted) {
      expect((await WakeTarget.decrypt(env, after!.encrypted!)).signingSecret)
        .toBe((await WakeTarget.decrypt(env, before.encrypted)).signingSecret);
    }
  });
});
