import {
  accessToken,
  assert,
  execute,
  loadState,
  request,
  saveState,
  statePath,
  workQuery,
} from './Shared.mjs';

const command = process.argv[2] || 'send';

await execute(async () => {
  const state = await loadState();
  const a = state.sides.a;
  const b = state.sides.b;
  const token = await accessToken('a', state.addressUrl);

  assert(a && b && !a.released && !b.released, 'Setup is incomplete or already cleaned up.');
  await request(state.addressUrl, '/v1/account/status' + workQuery(a), token);

  if (command === 'send') {
    if (!state.message) {
      const body = '[relay-smoke:' + state.runId + '] A to B: hello';
      const sent = await request(state.relayUrl, '/v1/messages' + workQuery(a), token, {
        method: 'POST',
        expected: [201],
        body: { to: b.canonical, subject: 'Relay E2E ' + state.runId, body },
      });

      assert(sent.id && sent.threadId, 'Message send returned no message ID or thread ID.');
      state.message = { id: sent.id, threadId: sent.threadId, body };
      await saveState(state);
      console.log('Message submitted to MailTrigger: ' + sent.id);
    }

    if (!state.handoff) {
      const body = '[relay-smoke:' + state.runId + '] A to B host: handoff';
      const sent = await request(state.relayUrl, '/v1/handoffs' + workQuery(a), token, {
        method: 'POST',
        expected: [201],
        body: { to: b.hostCanonical, subject: 'Relay handoff ' + state.runId, body },
      });

      assert(sent.id && sent.threadId, 'Handoff send returned no message ID or thread ID.');
      state.handoff = { id: sent.id, threadId: sent.threadId, body };
      await saveState(state);
      console.log('Host handoff submitted: ' + sent.id);
    }

    console.log('Share the state file with Side B if testing on separate machines.');
    console.log('Next: npm run smoke:b -- reply');
    return;
  }

  if (command === 'verify') {
    assert(state.message?.replyId && state.handoff?.replyId,
      'Side B has not replied to both threads. Copy its updated state file back first.');

    const messages = await request(
      state.relayUrl, '/v1/threads/' + encodeURIComponent(state.message.threadId) + workQuery(a), token,
    );
    const handoffs = await request(
      state.relayUrl, '/v1/threads/' + encodeURIComponent(state.handoff.threadId) + workQuery(a), token,
    );

    assert(messages.some((item) => item.id === state.message.id && item.body === state.message.body),
      'Original message is missing from persisted thread history.');
    assert(messages.some((item) => item.id === state.message.replyId),
      'Side B reply is missing from persisted thread history.');

    assert(handoffs.some((item) => item.id === state.handoff.id),
      'Host handoff is missing from persisted thread history.');
    assert(handoffs.some((item) => item.id === state.handoff.acceptId && item.kind === 'acceptance'),
      'Handoff acceptance message is missing.');
    assert(handoffs.some((item) => item.id === state.handoff.replyId),
      'Handoff reply is missing.');

    console.log('PASS — Side A can read original message, reply, host acceptance and handoff reply.');
    console.log('Message thread: ' + state.message.threadId);
    console.log('Handoff thread: ' + state.handoff.threadId);
    console.log('Next: npm run smoke:cleanup');
    return;
  }

  throw new Error('Usage: npm run smoke:a -- send|verify');
});
