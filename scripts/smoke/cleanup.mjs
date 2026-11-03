import { removeLocalAuth } from './Auth.mjs';

import {
  accessToken,
  askConfirmation,
  assert,
  execute,
  loadState,
  moveCompletedState,
  request,
  saveState,
  statePath,
  validateWork,
  workQuery,
} from './Shared.mjs';

await execute(async () => {
  const state = await loadState();
  assert(state.sides.a || state.sides.b, 'No smoke-created work addresses recorded.');

  // Only release exact work IDs with a generated name from this run.
  // Never delete hosts, other agents, mailboxes, threads or shared D1 records.
  const candidates = [];

  for (const name of ['a', 'b']) {
    const side = state.sides[name];

    if (!side || side.released) {
      continue;
    }

    const token = await accessToken(name, state.addressUrl);
    const status = await request(state.addressUrl, '/v1/account/status' + workQuery(side), token);

    assert(status.organization?.id === state.organization.id, 'Organization changed; refusing cleanup.');
    validateWork(status.work, state.runId, name);

    assert(status.work.id === side.id, 'Work ID differs from recorded test identity.');
    assert(status.work.parentAddressId === side.parentAddressId,
      'Parent host differs from recorded test identity.');

    candidates.push({ name, token, side });
  }

  await askConfirmation(state.runId);

  for (const { name, token, side } of candidates) {
    await request(state.addressUrl, '/v1/account/work/' + encodeURIComponent(side.id), token, {
      method: 'DELETE',
      expected: [200],
    });

    side.released = true;
    await saveState(state);
    console.log('Released test work ' + name.toUpperCase() + ': ' + side.canonical);
  }

  state.cleanedAt = new Date().toISOString();
  await saveState(state);
  const archive = await moveCompletedState(state);

  // Only clear local credentials after every recorded test work was released.
  if (process.env.RELAY_SMOKE_KEEP_LOGIN !== '1') {
    await removeLocalAuth();
    console.log('本機 OAuth 憑證已刪除。下次測試請重新 smoke:login。');
  }

  console.log('Cleanup complete: ' + archive);
  console.log('Only test work addresses were revoked. Shared hosts, MailTrigger mailboxes,');
  console.log('Relay D1 messages and threads remain; the API currently has no delete endpoints for these.');
});
