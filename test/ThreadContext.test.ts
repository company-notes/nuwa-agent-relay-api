import { describe, expect, it } from 'vitest';

import { RelayTestClient } from './RelayTestClient';

describe('bounded Relay Thread context in one authorized message read', () => {
  it('returns preceding messages in the same Thread with strict bounds and no automatic reads', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const first = await client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: 'relay-test-org/beta/reviewer', body: 'A'.repeat(3300),
      });
    expect(first.status).toBe(201);
    const threadID = first.body.data.threadId as string;

    const second = await client.call('token-b', 'POST',
      '/v2/threads/' + threadID + '/messages?session_id=session-b', {
        body: 'Second message from the recipient.',
      });
    expect(second.status).toBe(201);

    const third = await client.call('token-a', 'POST',
      '/v2/threads/' + threadID + '/messages?session_id=session-a', {
        body: 'Third message, please keep the previous context.',
      });
    expect(third.status).toBe(201);
    const thirdID = third.body.data.id as string;

    const ordinary = await client.call('token-b', 'GET',
      '/v2/messages/' + thirdID + '?session_id=session-b');
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.data.threadId).toBe(threadID);
    expect(ordinary.body.data.recentThreadMessages).toBeUndefined();

    const withContext = await client.call('token-b', 'GET',
      '/v2/messages/' + thirdID + '?session_id=session-b&context_limit=2');
    expect(withContext.status).toBe(200);
    expect(withContext.body.data.id).toBe(thirdID);
    expect(withContext.body.data.recentThreadMessages).toHaveLength(2);
    expect(withContext.body.data.recentThreadMessages.map((row: any) => row.id))
      .toEqual([first.body.data.id, second.body.data.id]);
    expect(withContext.body.data.recentThreadMessages[0].body).toHaveLength(3000);
    expect(withContext.body.data.recentThreadMessages[0].bodyTruncated).toBe(true);
    expect(withContext.body.data.recentThreadMessages[1].body)
      .toBe('Second message from the recipient.');
    expect(withContext.body.data.recentThreadMessages[1].bodyTruncated).toBe(false);

    const oneContext = await client.call('token-b', 'GET',
      '/v2/messages/' + thirdID + '?session_id=session-b&context_limit=1');
    expect(oneContext.body.data.recentThreadMessages.map((row: any) => row.id))
      .toEqual([second.body.data.id]);

    const zeroContext = await client.call('token-b', 'GET',
      '/v2/messages/' + thirdID + '?session_id=session-b&context_limit=0');
    expect(zeroContext.status).toBe(200);
    expect(zeroContext.body.data.recentThreadMessages).toBeUndefined();

    const history = await client.call('token-a', 'GET',
      '/v2/threads/' + threadID + '?session_id=session-a');
    expect(history.body.data.map((row: any) => row.id))
      .toEqual([first.body.data.id, second.body.data.id, thirdID]);
    expect(history.body.data[0].body).toHaveLength(3300);
    expect(history.body.data[0].bodyTruncated).toBeUndefined();
  });

  it('does not expose other Sessions Thread history or permit unbounded context', async () => {
    const client = new RelayTestClient();
    client.installExternalTestTransport();
    await client.provisionAgentMailboxes();

    const sent = await client.call('token-a', 'POST',
      '/v2/messages?session_id=session-a', {
        to: 'relay-test-org/beta/reviewer', body: 'private message',
      });
    expect(sent.status).toBe(201);

    const wrongSession = await client.call('token-c', 'GET',
      '/v2/messages/' + sent.body.data.id + '?session_id=session-c&context_limit=2');
    expect(wrongSession.status).toBe(404);

    const mismatchedToken = await client.call('token-a', 'GET',
      '/v2/messages/' + sent.body.data.id + '?session_id=session-b&context_limit=2');
    expect(mismatchedToken.status).toBe(409);

    for (const limit of ['-1', '13', '1.5', 'nan', '']) {
      const response = await client.call('token-b', 'GET',
        '/v2/messages/' + sent.body.data.id +
        '?session_id=session-b&context_limit=' + encodeURIComponent(limit));
      expect(response.status, 'invalid context limit: ' + limit).toBe(400);
      expect(response.body.error.code).toBe('invalid_context_limit');
    }
  });
});
