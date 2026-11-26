import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

class CollaborationScenario {
  readonly client = new RelayTestClient();
  static readonly origin = RelayTestClient.origin;

  constructor() {
    this.client.installExternalTestTransport();
  }

  async request(method: string, path: string, token?: string, body?: object, cookie?: string,
                runtimeToken?: string) {
    const response = await exports.default.fetch(new Request(CollaborationScenario.origin + path, {
      method,
      headers: {
        origin: CollaborationScenario.origin,
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(cookie ? { cookie } : {}),
        ...(runtimeToken ? { 'x-nuwa-runtime-token': runtimeToken } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

    return { status: response.status, body: await response.json() as any,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  async owner(code: string) {
    const registration = await this.request('POST', '/manage/oauth/client', undefined, {});
    expect(registration.status).toBe(201);
    const signedIn = await this.request('POST', '/manage/oauth/token', undefined, {
      clientId: registration.body.data.clientId, code, verifier: 'a'.repeat(64),
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toMatch(/^__Host-nuwa_owner_/);

    return { token: signedIn.body.data.accessToken as string, cookie: signedIn.cookie! };
  }
}

describe('Owner-authorized routine collaboration', () => {
  it('persists one grant policy across works, requires browser approval, and denies revoked autonomous replies', async () => {
    const scenario = new CollaborationScenario();
    const client = scenario.client;
    await client.provisionAgentMailboxes();
    const work = '/v2/collaboration-policy?session_id=session-b';
    const initial = await client.call('token-b', 'PUT', work);
    expect(initial.status).toBe(200);
    expect(initial.body.data.mode).toBe('unconfigured');
    const id = initial.body.data.id;
    const management = '/v2/management/collaboration-policies/' + id;

    const request = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer', body: 'Please report routine progress.',
    });
    expect(request.status).toBe(201);
    const replyPath = '/v2/threads/' + request.body.data.threadId + '/messages?session_id=session-b';
    const reply = { messageID: request.body.data.id, body: 'Routine status.', autonomous: true };

    expect((await client.call('token-b', 'POST', replyPath, reply)).status).toBe(403);
    expect((await scenario.request('PUT', management, 'token-b', {
      mode: 'autonomous', revision: 0,
    })).status, 'An Agent bearer plus a spoofed Origin is not browser approval').toBe(403);

    const owner = await scenario.owner('owned-a');
    const listing = await scenario.request('GET', '/v2/management/collaboration-policies', owner.token,
      undefined, owner.cookie);
    expect(listing.status).toBe(200);
    expect(listing.body.data.canEdit).toBe(true);
    expect(listing.body.data.policies).toEqual([expect.objectContaining({ id, mode: 'unconfigured', revision: 0 })]);

    const foreign = await scenario.owner('different-owner');
    expect((await scenario.request('PUT', management, foreign.token, {
      mode: 'autonomous', revision: 0,
    }, foreign.cookie)).status).toBe(404);
    expect((await scenario.request('PUT', management, owner.token, {
      mode: 'autonomous', revision: 0,
    }, foreign.cookie)).status).toBe(403);

    const allowed = await scenario.request('PUT', management, owner.token, {
      mode: 'autonomous', revision: 0,
    }, owner.cookie);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toMatchObject({ id, mode: 'autonomous', revision: 1 });

    const sameGrant = await scenario.request('PUT', '/v2/collaboration-policy?session_id=session-c',
      'token-b', undefined, undefined, 'runtime-c');
    expect(sameGrant.status).toBe(200);
    expect(sameGrant.body.data).toMatchObject({ id, mode: 'autonomous', revision: 1 });
    const otherGrant = await client.call('token-c', 'PUT', '/v2/collaboration-policy?session_id=session-c');
    expect(otherGrant.body.data.mode).toBe('unconfigured');
    expect(otherGrant.body.data.id).not.toBe(id);

    expect((await client.call('token-b', 'POST', replyPath, {
      body: reply.body, autonomous: true,
    })).status).toBe(400);
    expect((await client.call('token-b', 'POST', replyPath, {
      ...reply, artifactLinks: ['https://files.example.com/private.zip'],
    })).status).toBe(403);
    expect((await client.call('token-b', 'POST', replyPath, reply)).status).toBe(201);

    const revoked = await scenario.request('PUT', management, owner.token, {
      mode: 'manual', revision: 1,
    }, owner.cookie);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({ mode: 'manual', revision: 2 });
    expect((await scenario.request('PUT', management, owner.token, {
      mode: 'autonomous', revision: 1,
    }, owner.cookie)).status).toBe(409);
    expect((await client.call('token-b', 'POST', replyPath, reply)).status).toBe(403);
    expect(client.deliveries).toHaveLength(2);
    expect((await client.call('token-b', 'POST', replyPath, {
      messageID: request.body.data.id, body: 'Owner specifically approved this reply.',
    })).status).toBe(201);

    const saved = await env.DB.prepare('SELECT mode, revision FROM collaboration_policies WHERE id = ?')
      .bind(id).first<{ mode: number; revision: number }>();
    expect(saved).toEqual({ mode: 0, revision: 2 });
  });
});
