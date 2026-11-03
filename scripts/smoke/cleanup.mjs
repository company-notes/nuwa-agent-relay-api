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
    if (side.hostCreatedBySmoke && !side.relayCleaned) {
      const result = await request(state.relayUrl,
        '/v1/smoke/host?work_address_id=' + encodeURIComponent(side.id) +
          '&run_id=' + encodeURIComponent(state.runId),
        token,
        { method: 'DELETE', expected: [200] },
      );

      assert(result.cleaned && result.hostId === side.parentAddressId,
        'Relay did not confirm scoped test resource cleanup.');
      side.relayCleaned = true;
      await saveState(state);
      console.log('Removed Relay D1 and MailTrigger mailbox resources for Side ' + name.toUpperCase());
    }

    await request(state.addressUrl, '/v1/account/work/' + encodeURIComponent(side.id), token, {
      method: 'DELETE',
      expected: [200],
    });

    side.released = true;
    await saveState(state);
    console.log('Released test work ' + name.toUpperCase() + ': ' + side.canonical);
  }

  // A previous cleanup attempt may have already released the Work, then
  // failed while revoking its Host. Resume from the persisted state.
  for (const name of ['a', 'b']) {
    const side = state.sides[name];

    if (!side || !side.hostCreatedBySmoke || side.hostReleased) {
      continue;
    }

    assert(side.released && side.relayCleaned,
      'Cannot revoke a Host before scoped mailbox and Work cleanup.');

    const token = await accessToken(name, state.addressUrl);
    const status = await request(state.addressUrl, '/v1/account/status', token);

    assert(status.organization?.id === state.organization.id,
      'Organization changed before Host cleanup.');
    assert(status.hosts.some((host) => host.id === side.parentAddressId &&
      host.path === side.hostPath), 'Test Host no longer matches its recorded owner.');

    const deleted = await request(
      state.addressUrl,
      '/v1/account/host/' + encodeURIComponent(side.parentAddressId) +
        '?run_id=' + encodeURIComponent(state.runId),
      token,
      { method: 'DELETE', expected: [200] },
    );

    assert(deleted.id === side.parentAddressId && deleted.active === false,
      'Agent Address did not confirm Host revocation.');
    side.hostReleased = true;
    await saveState(state);

    console.log('Revoked empty test Host ' + name.toUpperCase() + ': ' + side.hostPath);
  }

  for (const side of Object.values(state.sides)) {
    assert(side.released && (!side.hostCreatedBySmoke || side.hostReleased),
      'Some test identities are not fully cleaned. Preserve the state for retry.');
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
  console.log('Only run-scoped test Hosts / Works, their managed Mailboxes and related D1 records');
  console.log('were removed. Existing shared Hosts and Organizations are not deleted.');
});
