import { accessToken, assert, execute, loadState, request, workQuery } from './Shared.mjs';

await execute(async () => {
  const state = await loadState();
  const token = await accessToken('a', state.addressUrl);
  const a = state.sides.a;

  assert(a && state.message?.id && state.handoff?.id,
    'Run setup and Side A send before checking MailTrigger arrival.');

  for (const [kind, messageId] of [
    ['message', state.message.id],
    ['handoff', state.handoff.id],
  ]) {
    const receipt = await request(
      state.relayUrl,
      '/v1/messages/' + encodeURIComponent(messageId) + '/receipt' + workQuery(a) +
        '&refresh=archive',
      token,
    );

    assert(receipt.submissionStatus === 'sent',
      kind + ': MailTrigger has not accepted the send request.');
    assert(receipt.arrivedInMailTrigger === true && receipt.receivedAt,
      kind + ': no MailTrigger incoming Route webhook was recorded. ' +
      'Check the actual MailTrigger incoming mail logs and Route configuration.');

    console.log('PASS: ' + kind + ' arrived in MailTrigger at ' + receipt.receivedAt);
  }

  console.log('Both messages have independent authenticated MailTrigger receipt evidence.');
});
