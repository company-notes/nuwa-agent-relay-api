import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('Native work Inbox stream', () => {
  it('wakes the addressed online work and recovers a message sent while disconnected', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const denied = await client.openInboxStream('token-a', 'session-b');
    expect(denied.status).toBeGreaterThanOrEqual(400);

    const response = await client.openInboxStream('token-b', 'session-b');
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    let cursor = 0;

    try {
      const signal = new Promise<string>((resolve) => {
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
      });
      const sent = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
        to: 'relay-test-org/beta/reviewer',
        body: 'Please review the change.',
      });
      expect(sent.status).toBe(201);
      expect(JSON.parse(await signal)).toEqual({ inboxChanged: true });

      const page = await client.call('token-b', 'GET',
        '/v2/inbox/events?session_id=session-b&after_sequence=0');
      expect(page.body.data.items.map((item: { messageID: string }) => item.messageID))
        .toEqual([sent.body.data.id]);
      cursor = page.body.data.cursor;
    } finally {
      socket.close(1000);
    }

    const offline = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'Follow-up while disconnected.',
    });
    expect(offline.status).toBe(201);

    const resumed = await client.openInboxStream('token-b', 'session-b');
    expect(resumed.status).toBe(101);
    const resumedSocket = resumed.webSocket!;
    resumedSocket.accept();

    try {
      const page = await client.call('token-b', 'GET',
        `/v2/inbox/events?session_id=session-b&after_sequence=${cursor}`);
      expect(page.body.data.items.map((item: { messageID: string }) => item.messageID))
        .toEqual([offline.body.data.id]);
    } finally {
      resumedSocket.close(1000);
    }
  }, 15_000);

  it('keeps an offline work backlog beyond the manual Inbox window and isolates replies', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const first = await client.call('token-a', 'POST', '/v2/messages?session_id=session-a', {
      to: 'relay-test-org/beta/reviewer',
      body: 'First work request',
    });
    expect(first.status).toBe(201);

    const expectedIDs = [first.body.data.id];

    for (let index = 0; index < 100; index += 1) {
      const sent = await client.call('token-a', 'POST',
        `/v2/threads/${first.body.data.threadId}/messages?session_id=session-a`,
        { body: `Offline follow-up ${index}` });
      expect(sent.status).toBe(201);
      expectedIDs.push(sent.body.data.id);
    }

    const firstPage = await client.call('token-b', 'GET',
      '/v2/inbox/events?session_id=session-b&after_sequence=0');
    expect(firstPage.status, 'A resumed work must have an authorized event cursor').toBe(200);
    expect(firstPage.body.data.items.map((item: { messageID: string }) => item.messageID))
      .toEqual(expectedIDs.slice(0, 100));
    expect(firstPage.body.data.hasMore).toBe(true);

    const secondPage = await client.call('token-b', 'GET',
      `/v2/inbox/events?session_id=session-b&after_sequence=${firstPage.body.data.cursor}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.items.map((item: { messageID: string }) => item.messageID))
      .toEqual(expectedIDs.slice(100));
    expect(secondPage.body.data.hasMore).toBe(false);

    const reply = await client.call('token-b', 'POST',
      `/v2/threads/${first.body.data.threadId}/messages?session_id=session-b`,
      { body: 'Work completed.' });
    expect(reply.status).toBe(201);

    const senderEvents = await client.call('token-a', 'GET',
      '/v2/inbox/events?session_id=session-a&after_sequence=0');
    expect(senderEvents.status).toBe(200);
    expect(senderEvents.body.data.items.map((item: { messageID: string }) => item.messageID))
      .toEqual([reply.body.data.id]);

    const denied = await client.call('token-a', 'GET',
      '/v2/inbox/events?session_id=session-b&after_sequence=0');
    expect(denied.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
