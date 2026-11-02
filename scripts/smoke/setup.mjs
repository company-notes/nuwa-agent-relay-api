import { access, constants } from 'node:fs/promises';

import {
  accessToken,
  addressOrigin,
  assert,
  chooseHosts,
  createRunId,
  execute,
  relayOrigin,
  request,
  saveState,
  statePath,
  validateWork,
} from './Shared.mjs';

await execute(async () => {
  try {
    await access(statePath, constants.F_OK);
    throw new Error('Active smoke-test state exists at ' + statePath + '. Run cleanup before setup.');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const tokenA = accessToken('a');
  const tokenB = process.env.RELAY_SMOKE_TOKEN_B || tokenA;

  // Check live endpoints before creating any registry resource.
  const health = await request(relayOrigin, '/health');
  assert(health.status === 'ok', 'Relay health check did not report ok.');

  const statusA = await request(addressOrigin, '/v1/account/status', tokenA);
  const statusB = await request(addressOrigin, '/v1/account/status', tokenB);
  const hosts = chooseHosts(
    statusA,
    statusB,
    process.env.RELAY_SMOKE_HOST_A,
    process.env.RELAY_SMOKE_HOST_B,
  );

  const runId = createRunId();
  const state = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    addressUrl: addressOrigin,
    relayUrl: relayOrigin,
    organization: statusA.organization,
    sides: {},
    message: null,
    handoff: null,
  };

  console.log('Using existing hosts: ' + hosts.a.path + ' and ' + hosts.b.path);
  console.log('Test run ID: ' + runId);

  for (const [name, host, token] of [
    ['a', hosts.a, tokenA],
    ['b', hosts.b, tokenB],
  ]) {
    const claim = await request(addressOrigin, '/v1/account/work', token, {
      method: 'POST',
      expected: [201],
      body: {
        host: host.path,
        handle: 'relay-smoke-' + runId + '-' + name,
        displayName: 'Temporary Relay E2E ' + name.toUpperCase(),
      },
    });

    const work = validateWork(claim.work, runId, name);
    assert(work.parentAddressId === host.id, 'Unexpected parent host after work claim.');
    assert(claim.organization.id === state.organization.id, 'Claimed work is in the wrong organization.');

    state.sides[name] = {
      id: work.id,
      path: work.path,
      canonical: work.canonical,
      parentAddressId: work.parentAddressId,
      hostPath: host.path,
      hostCanonical: host.canonical,
      released: false,
    };

    // Save immediately: a later failure can still be cleaned up safely.
    await saveState(state);

    const mailbox = await request(relayOrigin, '/v1/hosts/provision' + '?work_address_id=' +
      encodeURIComponent(work.id), token, { method: 'POST', expected: [201] });

    assert(mailbox.mailboxId && mailbox.mailboxEmail, 'Mailbox provisioning returned incomplete data.');
    state.sides[name].mailboxEmail = mailbox.mailboxEmail;
    await saveState(state);

    console.log('Side ' + name.toUpperCase() + ': ' + work.canonical +
      ' — mailbox ' + mailbox.mailboxEmail);
  }

  console.log('\nSetup complete. State file (NO TOKENS): ' + statePath);
  console.log('Next: npm run smoke:a -- send');
});
