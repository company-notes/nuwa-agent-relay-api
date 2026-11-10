import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MailReceipt } from '../src/MailReceipt';
import { WakeService } from '../src/WakeService';
import { RelayTestClient } from './RelayTestClient';

describe('Self-service signed Wake registration', () => {
  it('requires proof from the callback before activating and isolates OAuth Work', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    const registration = await client.call('token-b', 'POST',
      '/v1/wake-subscription?work_address_id=work-b', {
        callbackUrl: 'https://agent-hook.example.com/wake',
      });
    expect(registration.status).toBe(201);
    expect(registration.body.data).toMatchObject({
      status: 'pending_verification',
      challengeDelivered: true,
    });
    expect(JSON.stringify(registration.body)).not.toContain(client.wakeChallenges[0].challenge);

    const pending = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(pending.body.data.enabled).toBe(false);
    expect(pending.body.data.pending.verificationId)
      .toBe(registration.body.data.verificationId);

    const challenge = client.wakeChallenges[0];
    const stranger = await client.call('token-a', 'POST',
      '/v1/wake-subscription/verification?work_address_id=work-a', {
        verificationId: challenge.verificationId,
        challenge: challenge.challenge,
      });
    expect(stranger.status).toBe(409);

    const invalid = await client.call('token-b', 'POST',
      '/v1/wake-subscription/verification?work_address_id=work-b', {
        verificationId: challenge.verificationId, challenge: 'wrong',
      });
    expect(invalid.status).toBe(403);

    await client.confirmLatestWake();

    const activated = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(activated.body.data).toMatchObject({
      enabled: true,
      callbackHost: 'agent-hook.example.com',
      authMode: 'hmac',
      pending: null,
    });
    expect(JSON.stringify(activated.body)).not.toContain('signingSecret');

    const replay = await client.call('token-b', 'POST',
      '/v1/wake-subscription/verification?work_address_id=work-b', {
        verificationId: challenge.verificationId,
        challenge: challenge.challenge,
      });
    expect(replay.status).toBe(409);
  });

  it('delivers a Bearer-authenticated GrokBot wake and keeps credentials encrypted and undisclosed', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const bearer = 'grokbot-private-key-THIS-IS-SECRET';
    const url = 'https://api2.cursor.sh/automations/webhook/agent-b';
    const registration = await client.call('token-b', 'POST',
      '/v1/wake-subscription?work_address_id=work-b', {
        callbackUrl: url, authMode: 'bearer', bearerToken: bearer,
      });
    expect(registration.status).toBe(201);
    expect(registration.body.data.challengeDelivered).toBe(true);
    expect(JSON.stringify(registration.body)).not.toContain(bearer);
    expect(client.wakeRequests[0].authorization).toBe('Bearer ' + bearer);

    const attempt = await env.DB.prepare(
      'SELECT encrypted_target AS ciphertext, callback_url AS url FROM wake_registration_attempts WHERE work_address_id = ?',
    ).bind('work-b').first<{ ciphertext: string; url: string }>();
    expect(attempt!.url).toBe('https://api2.cursor.sh');
    expect(attempt!.ciphertext).not.toContain(bearer);
    expect(attempt!.ciphertext).not.toContain('automations/webhook');

    await client.confirmLatestWake();
    const sent = await client.call('token-a', 'POST',
      '/v1/messages?work_address_id=work-a', {
        to: '@beta/reviewer', body: 'Public GrokBot callback test.',
      });
    const arrival = await MailReceipt.confirmArrival(env, sent.body.data.id, 'webhook');
    expect(arrival).toBe(true);
    await WakeService.dispatchDue(env);

    const last = client.wakeRequests.at(-1)!;
    expect(last.url).toBe(url);
    expect(last.authorization).toBe('Bearer ' + bearer);
    expect(last.body).toMatchObject({
      event: 'nuwa.message.available',
      messageId: sent.body.data.id,
      workAddressId: 'work-b',
    });

    const status = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(JSON.stringify(status.body)).not.toContain(bearer);
    expect(JSON.stringify(status.body)).not.toContain('automations/webhook');
  });

  it('supports a tunnelled OpenMausBot capability URL without exposing the secret path', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionBothHosts();

    const url = 'https://agent-demo.ngrok-free.app/hooks/wh_private/whsec_super-secret';
    const registration = await client.call('token-b', 'POST',
      '/v1/wake-subscription?work_address_id=work-b', {
        callbackUrl: url, authMode: 'capability',
      });
    expect(registration.status).toBe(201);
    expect(JSON.stringify(registration.body)).not.toContain('whsec_super-secret');
    expect(client.wakeRequests[0].url).toBe(url);
    expect(client.wakeRequests[0].authorization).toBeNull();

    await client.confirmLatestWake();
    const now = await client.call('token-b', 'GET',
      '/v1/wake-subscription?work_address_id=work-b');
    expect(JSON.stringify(now.body)).not.toContain('/hooks/');
    expect(now.body.data.callbackHost).toBe('agent-demo.ngrok-free.app');

    const sent = await client.call('token-a', 'POST',
      '/v1/messages?work_address_id=work-a', {
        to: '@beta/reviewer', body: 'OpenMausBot webhook test.',
      });
    await MailReceipt.confirmArrival(env, sent.body.data.id, 'webhook');
    await WakeService.dispatchDue(env);
    expect(client.wakeRequests.at(-1)!.url).toBe(url);
  });

  it('refuses private or ambiguous callback URLs and throttles repeated registration', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();

    for (const callbackUrl of [
      'http://127.0.0.1:8800/wake',
      'https://localhost/wake',
      'https://127.0.0.1/wake',
      'https://169.254.169.254/latest',
      'https://metadata.google.internal/wake',
      'https://agent-hook.example.com:8443/wake',
      'https://agent-hook.example.com/wake?token=secret',
      'https://person:secret@agent-hook.example.com/wake',
    ]) {
      const failed = await client.call('token-b', 'POST',
        '/v1/wake-subscription?work_address_id=work-b', { callbackUrl });
      expect(failed.status).toBe(400);
    }

    const registered = await client.call('token-b', 'POST',
      '/v1/wake-subscription?work_address_id=work-b', {
        callbackUrl: 'https://agent-hook.example.com/wake',
      });
    expect(registered.status).toBe(201);
    const repeat = await client.call('token-b', 'POST',
      '/v1/wake-subscription?work_address_id=work-b', {
        callbackUrl: 'https://agent-hook.example.com/wake',
      });
    expect(repeat.status).toBe(429);
    expect(client.wakeChallenges).toHaveLength(1);
  });
});
