import { describe, expect, it, vi } from 'vitest';

import { AgentAddressTransport } from '../src/AgentAddressTransport';

describe('Agent Address private Worker transport', () => {
  it('forwards the authorized request to the binding without using global fetch', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, data: { organization: { id: 'org-id' } } }));
    const publicFetch = vi.fn(async () => {
      throw new TypeError('Public Agent Address subrequest is blocked.');
    });
    const transport = new AgentAddressTransport({ fetch: upstream });
    vi.stubGlobal('fetch', publicFetch);

    const url = new URL('https://address.company-notes.com/v2/account/status');
    const result = await transport.request(url, {
      method: 'GET',
      headers: { authorization: 'Bearer test-grant' },
      redirect: 'manual',
    });

    expect(result.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toEqual(url);
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get('authorization'))
      .toBe('Bearer test-grant');
    expect(upstream.mock.calls[0][1]?.redirect).toBe('manual');

    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the service binding rejects the request', async () => {
    const upstream = vi.fn(async () => {
      throw new TypeError('Service binding unavailable.');
    });
    const transport = new AgentAddressTransport({ fetch: upstream });

    await expect(transport.request('https://address.company-notes.com/v2/account/status'))
      .rejects.toThrow('Service binding unavailable.');
  });
});
