import {
  accessToken,
  assert,
  execute,
  loadState,
  request,
  saveState,
  workQuery,
} from './Shared.mjs';

const command = process.argv[2] || 'reply';

await execute(async () => {
  assert(command === 'reply', 'Usage: npm run smoke:b -- reply');

  const state = await loadState();
  const b = state.sides.b;
  const token = await accessToken('b', state.addressUrl);

  assert(b && !b.released && state.message && state.handoff,
    'Run Side A send first and copy the state file to Side B.');

  await request(state.addressUrl, '/v1/account/status' + workQuery(b), token);

  const inbox = await request(state.relayUrl, '/v1/inbox' + workQuery(b), token);
  assert(inbox.some((item) => item.id === state.message.id && item.body === state.message.body),
    'Side B inbox does not contain the message from Side A.');

  // Only the recipient's explicit acknowledgement is a read receipt.
  const readMessage = await request(
    state.relayUrl,
    '/v1/messages/' + encodeURIComponent(state.message.id) + '/read' + workQuery(b),
    token,
    { method: 'POST', expected: [201] },
  );
  assert(readMessage.workAddressId === b.id && readMessage.readAt,
    'The receiving Work did not record its read acknowledgement.');

  if (!state.message.replyId) {
    const body = '[relay-smoke:' + state.runId + '] B to A: acknowledged';
    const reply = await request(
      state.relayUrl,
      '/v1/threads/' + encodeURIComponent(state.message.threadId) + '/messages' + workQuery(b),
      token,
      { method: 'POST', expected: [201], body: { body } },
    );

    assert(reply.id, 'Thread reply returned no message ID.');
    state.message.replyId = reply.id;
    await saveState(state);
  }

  const hostInbox = await request(state.relayUrl, '/v1/host-inbox' + workQuery(b), token);

  if (!state.handoff.acceptId) {
    assert(hostInbox.some((item) => item.id === state.handoff.id),
      'Side B host inbox does not contain the handoff.');

    const acceptance = await request(
      state.relayUrl,
      '/v1/handoffs/' + encodeURIComponent(state.handoff.id) + '/accept' + workQuery(b),
      token,
      { method: 'POST', expected: [201] },
    );

    assert(acceptance.id && acceptance.acceptedBy === b.canonical,
      'Host acceptance returned incomplete or incorrect identity.');
    state.handoff.acceptId = acceptance.id;
    await saveState(state);
  }

  // Host handoff cannot be read by an individual Work until it accepts.
  const readHandoff = await request(
    state.relayUrl,
    '/v1/messages/' + encodeURIComponent(state.handoff.id) + '/read' + workQuery(b),
    token,
    { method: 'POST', expected: [201] },
  );
  assert(readHandoff.workAddressId === b.id && readHandoff.readAt,
    'Accepted handoff has no recipient read acknowledgement.');

  if (!state.handoff.replyId) {
    const body = '[relay-smoke:' + state.runId + '] B to A: handoff done';
    const reply = await request(
      state.relayUrl,
      '/v1/handoffs/' + encodeURIComponent(state.handoff.id) + '/reply' + workQuery(b),
      token,
      { method: 'POST', expected: [201], body: { body } },
    );

    assert(reply.id, 'Handoff reply returned no message ID.');
    state.handoff.replyId = reply.id;
    await saveState(state);
  }

  console.log('PASS — Side B received the message, replied, accepted the handoff and replied.');
  console.log('Share the updated state file back with Side A if testing on separate machines.');
  console.log('Next: npm run smoke:a -- verify');
});
