import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/Env';
import { RelayAPI } from '../src/Index';
import { RelayTestClient } from './RelayTestClient';

class ResetScenario {
  readonly client = new RelayTestClient();
  readonly cleared: Array<{ agentID: string; sessionIDs: string[] }> = [];
  readonly api: RelayAPI;

  constructor() {
    this.client.installExternalTestTransport();
    const mcpWorker = {
      fetch: async (request: Request) => {
        expect(request.headers.get('authorization')).toBe('Bearer token-g');
        expect(request.headers.get('origin')).toBe(RelayTestClient.origin);

        const match = new URL(request.url).pathname.match(
          /^\/v2\/management\/agents\/([^/]+)\/bindings$/,
        );
        expect(match).toBeTruthy();
        const body = await request.json() as {
          confirmAgentID: string; sessionIDs: string[];
        };
        expect(body.confirmAgentID).toBe(match![1]);
        this.cleared.push({ agentID: match![1], sessionIDs: body.sessionIDs });

        return Response.json({ ok: true, data: { agentID: match![1] } });
      },
    };
    this.api = new RelayAPI({
      ...env, MCP_WORKER: mcpWorker as unknown as Env['MCP_WORKER'],
    });
  }

  async management(method: string, path: string, data?: object, token = 'token-g') {
    const response = await this.api.handle(new Request(RelayTestClient.origin + path, {
      method,
      headers: {
        origin: RelayTestClient.origin,
        authorization: 'Bearer ' + token,
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }));

    return { status: response.status, body: await response.json() as any };
  }

  async provisionOffice() {
    const mailbox = await this.client.call(
      'token-g', 'POST', '/v2/agent-mailboxes?session_id=session-g',
    );
    expect(mailbox.status).toBe(201);

    const receiver = await this.client.call('token-g', 'POST',
      '/v2/wake-subscription?session_id=session-g', {
        callbackUrl: 'https://agent-hook.example.com/office-reset',
      });
    expect(receiver.status).toBe(201);
    await this.client.confirmLatestWake('token-g');

    const enrolled = await this.client.call('token-g', 'POST',
      '/v2/gateway-office-coworkers?session_id=session-g', {
        coworkers: [{
          displayName: 'Team assistant', recipientBotID: 'native-team-assistant',
          threadMode: 'platform', firstContactMode: 'manual',
        }],
      });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.data).toBeDefined();
  }
}

describe('Owner resets one installed Gateway to simulate first-time onboarding', () => {
  it('previews affected coworkers, requires exact confirmation, and clears only selected office data', async () => {
    const scenario = new ResetScenario();
    await scenario.provisionOffice();

    const agents = await scenario.management('GET', '/v2/management/agents');
    expect(agents.status).toBe(200);
    expect(agents.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-000g', canonical: 'relay-test-org/gateway/main' }),
    ]));

    const path = '/v2/management/agents/agent-000g/data';
    const preview = await scenario.management('GET', path);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      targetAgentID: 'agent-000g',
      targetCanonical: 'relay-test-org/gateway/main',
      confirmation: 'RESET relay-test-org/gateway/main',
      stage: 'preview',
    });
    expect(preview.body.data.members).toHaveLength(2);

    const denied = await scenario.management('GET', path, undefined, 'token-foreign');
    expect(denied.status).toBe(404);

    await expect(scenario.management('DELETE', path, {
      confirmation: 'RESET wrong-address',
      fingerprint: preview.body.data.fingerprint,
    })).rejects.toMatchObject({ status: 409, code: 'reset_confirmation_changed' });

    const originalWake = await env.DB.prepare(
      'SELECT count(*) AS count FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-g').first<{ count: number }>();
    expect(originalWake?.count).toBe(1);

    const completed = await scenario.management('DELETE', path, {
      confirmation: preview.body.data.confirmation,
      fingerprint: preview.body.data.fingerprint,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.data.completed).toBe(true);
    expect(scenario.cleared).toHaveLength(2);
    expect(scenario.client.resetAgentIDs.size).toBe(2);

    const afterWake = await env.DB.prepare(
      'SELECT count(*) AS count FROM wake_subscriptions WHERE session_id = ?',
    ).bind('session-g').first<{ count: number }>();
    expect(afterWake?.count).toBe(0);

    const afterRoster = await env.DB.prepare(
      'SELECT count(*) AS count FROM gateway_office_coworkers WHERE gateway_session_id = ?',
    ).bind('session-g').first<{ count: number }>();
    expect(afterRoster?.count).toBe(0);

    const other = await scenario.management('GET', '/v2/management/agents');
    expect(other.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-000a' }),
    ]));
    expect(other.body.data.some((agent: { id: string }) => agent.id === 'agent-000g'))
      .toBe(false);

    const retried = await scenario.management('DELETE', path, {
      confirmation: preview.body.data.confirmation,
      fingerprint: preview.body.data.fingerprint,
    });
    expect(retried.body.data.completed).toBe(true);
    expect(scenario.cleared).toHaveLength(2);
  });
});
