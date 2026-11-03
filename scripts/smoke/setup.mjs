import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  addressOrigin,
  assert,
  createRunId,
  execute,
  relayOrigin,
  request,
  saveState,
  statePath,
  validateWork,
} from './Shared.mjs';

export function planHosts(runId, statusA, statusB, configuredA, configuredB) {
  assert(statusA?.hosts && statusB?.hosts, 'Agent Address did not return the host lists.');

  const a = configuredA || 'relay-smoke-' + runId + '-a';
  const b = configuredB || 'relay-smoke-' + runId + '-b';
  const valid = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

  assert(valid.test(a) && valid.test(b), 'Host handles must be 1–63 letters, numbers, - or _.');
  assert(a !== b, 'Side A and Side B must use different Host names.');

  const hosts = {
    a: statusA.hosts.find((host) => host.path === a),
    b: statusB.hosts.find((host) => host.path === b),
  };

  return {
    a: { name: a, existed: Boolean(hosts.a), id: hosts.a?.id || null },
    b: { name: b, existed: Boolean(hosts.b), id: hosts.b?.id || null },
  };
}

async function chooseOrganization(runId) {
  const suggested = 'relay-smoke-' + runId;
  const configured = process.env.RELAY_SMOKE_ORG;

  if (configured) {
    assert(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(configured),
      'RELAY_SMOKE_ORG is not a valid organization slug.');
    assert(process.env.RELAY_SMOKE_CREATE_ORG === 'yes',
      'New Organizations are permanent. Set RELAY_SMOKE_CREATE_ORG=yes to approve creation.');

    return configured;
  }

  assert(process.stdin.isTTY,
    'No Organization yet. Set RELAY_SMOKE_ORG=<slug> and RELAY_SMOKE_CREATE_ORG=yes, ' +
    'or run setup interactively.');

  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('此帳號尚未有 Organization；第一次需要建立，Cleanup 不會刪除它。');
    const input = await prompt.question('新的 Organization slug [' + suggested + ']：');
    const slug = input.trim() || suggested;

    assert(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug), 'Invalid organization slug.');

    const confirm = await prompt.question('確認建立永久 Organization ' + slug + '？輸入 CREATE：');
    assert(confirm === 'CREATE', 'Organization creation cancelled.');

    return slug;
  } finally {
    prompt.close();
  }
}

export async function setupSmokeTest() {
  try {
    await access(statePath, constants.F_OK);
    throw new Error('Active smoke-test state exists at ' + statePath + '. Run cleanup before setup.');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const tokenA = await accessToken('a', addressOrigin);
  const tokenB = await accessToken('b', addressOrigin);

  // Verify access and organization boundaries before creating test resources.
  const health = await request(relayOrigin, '/health');
  assert(health.status === 'ok', 'Relay health check did not report ok.');

  let statusA = await request(addressOrigin, '/v1/account/status', tokenA);
  let statusB = await request(addressOrigin, '/v1/account/status', tokenB);
  const runId = createRunId();

  const hasOrgA = Boolean(statusA.organization?.id);
  const hasOrgB = Boolean(statusB.organization?.id);

  if (hasOrgA && hasOrgB) {
    assert(statusA.organization.id === statusB.organization.id,
      'Both OAuth sessions must be in the same Organization.');
  } else {
    assert(!hasOrgA && !hasOrgB && tokenA === tokenB,
      'Creating a new Organization requires both sides to use the same account.');
  }

  const organizationSlug = hasOrgA
    ? statusA.organization.slug
    : await chooseOrganization(runId);

  if (hasOrgA && process.env.RELAY_SMOKE_ORG) {
    assert(statusA.organization.slug === process.env.RELAY_SMOKE_ORG,
      'RELAY_SMOKE_ORG differs from your signed-in Organization.');
  }

  const hosts = planHosts(
    runId,
    statusA,
    statusB,
    process.env.RELAY_SMOKE_HOST_A,
    process.env.RELAY_SMOKE_HOST_B,
  );

  const state = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    addressUrl: addressOrigin,
    relayUrl: relayOrigin,
    organization: statusA.organization || null,
    sides: {},
    message: null,
    handoff: null,
  };

  console.log('Smoke run: ' + runId);
  console.log('Host A: ' + hosts.a.name + (hosts.a.existed ? ' (existing)' : ' (new, remains after cleanup)'));
  console.log('Host B: ' + hosts.b.name + (hosts.b.existed ? ' (existing)' : ' (new, remains after cleanup)'));

  for (const name of ['a', 'b']) {
    const host = hosts[name];
    const token = name === 'a' ? tokenA : tokenB;
    const body = {
      host: host.name,
      handle: 'relay-smoke-' + runId + '-' + name,
      displayName: 'Temporary Relay E2E ' + name.toUpperCase(),
    };

    if (!state.organization) {
      body.organization = organizationSlug;
      body.organizationDisplayName = 'Relay smoke test ' + runId;
    }

    const claim = await request(addressOrigin, '/v1/account/work', token, {
      method: 'POST',
      expected: [201],
      body,
    });

    const work = validateWork(claim.work, runId, name);
    assert(claim.host?.id && claim.host.path === host.name,
      'Claim created or selected an unexpected Host.');
    assert(work.parentAddressId === claim.host.id, 'Work address has an unexpected Host.');
    assert(claim.organization?.id, 'Work claim did not return an Organization.');

    if (state.organization) {
      assert(claim.organization.id === state.organization.id, 'Organization changed during setup.');
    }

    state.organization = claim.organization;
    state.sides[name] = {
      id: work.id,
      path: work.path,
      canonical: work.canonical,
      parentAddressId: work.parentAddressId,
      hostPath: claim.host.path,
      hostCanonical: claim.host.canonical,
      hostCreatedBySmoke: !host.existed,
      released: false,
    };

    // Persist immediately: the second side or mailbox provisioning may fail.
    await saveState(state);

    const mailbox = await request(
      relayOrigin, '/v1/hosts/provision?work_address_id=' + encodeURIComponent(work.id),
      token, { method: 'POST', expected: [201] },
    );

    assert(mailbox.mailboxId && mailbox.mailboxEmail, 'Mailbox provisioning returned incomplete data.');
    state.sides[name].mailboxEmail = mailbox.mailboxEmail;
    await saveState(state);

    console.log('Side ' + name.toUpperCase() + ': ' + work.canonical +
      ' — mailbox ' + mailbox.mailboxEmail);

    // A newly created organization is visible to both sides only after first claim.
    if (name === 'a') {
      statusA = await request(addressOrigin, '/v1/account/status', tokenA);
      statusB = await request(addressOrigin, '/v1/account/status', tokenB);

      assert(statusA.organization?.id === state.organization.id &&
        statusB.organization?.id === state.organization.id,
        'After first claim, Side B must see the same Organization.');
    }
  }

  console.log('\nSetup complete. State: ' + statePath + ' (no OAuth tokens).');
  console.log('Next: npm run smoke:a -- send');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await execute(setupSmokeTest);
}
