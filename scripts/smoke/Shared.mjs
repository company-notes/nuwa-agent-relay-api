import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { addressOrigin, relayOrigin, statePath, assert } from './SmokeConfig.mjs';
import { readSavedToken } from './AuthStore.mjs';
import { SmokeLogger } from './Logger.mjs';

export { addressOrigin, relayOrigin, statePath, assert } from './SmokeConfig.mjs';

const logger = new SmokeLogger('smoke.command');

export async function accessToken(side, expectedOrigin = addressOrigin) {
  const value = process.env['RELAY_SMOKE_TOKEN_' + side.toUpperCase()];

  if (value) {
    return value;
  }

  return readSavedToken(side, expectedOrigin);
}

export function createRunId() {
  return randomBytes(5).toString('hex');
}

export async function request(origin, path, token, options = {}) {
  const base = new URL(origin);

  assert(base.protocol === 'https:', 'Only HTTPS service origins are accepted.');
  assert(!base.username && !base.password && !base.search && !base.hash, 'Invalid service origin.');

  const url = new URL(path, base);
  assert(url.origin === base.origin, 'Request must stay on the configured service origin.');

  const headers = { accept: 'application/json' };

  if (token) {
    headers.authorization = 'Bearer ' + token;
  }

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });

  // Never follow a redirect while carrying an OAuth Bearer credential.
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Service returned an unexpected redirect (HTTP ' + response.status + ').');
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error('HTTP ' + response.status + ' from ' + url.pathname + ': invalid JSON response.');
  }

  const expected = options.expected ?? [200];

  if (!expected.includes(response.status) || !payload?.ok) {
    const reason = payload?.error?.code || 'unexpected_response';
    const detail = payload?.error?.message || 'No error description';

    throw new Error('HTTP ' + response.status + ' at ' + url.pathname + ': ' + reason + ' — ' + detail);
  }

  return payload.data;
}

export function validateWork(work, runId, side) {
  const expected = 'relay-smoke-' + runId + '-' + side;

  assert(typeof work?.id === 'string' && work.id.length > 0, 'Missing work address ID.');
  assert(work.path?.split('/').at(-1) === expected, 'Refusing unrelated work identity: ' + String(work.path));
  assert(typeof work.parentAddressId === 'string', 'Work address has no parent host.');

  return work;
}

export function chooseHosts(statusA, statusB, configuredA, configuredB) {
  assert(statusA?.organization?.id && statusB?.organization?.id, 'Both accounts need existing organizations.');
  assert(
    statusA.organization.id === statusB.organization.id,
    'Both OAuth tokens must belong to the same organization.',
  );

  const hostsA = statusA.hosts || [];
  const hostsB = statusB.hosts || [];
  const candidates = hostsA
    .filter((host) => hostsB.some((other) => other.id === host.id))
    .sort((a, b) => a.path.localeCompare(b.path));

  const a = configuredA
    ? candidates.find((host) => host.path === configuredA || host.address === '@' + configuredA)
    : candidates[0];

  const b = configuredB
    ? candidates.find((host) => host.path === configuredB || host.address === '@' + configuredB)
    : candidates.find((host) => host.id !== a?.id);

  assert(a && b && a.id !== b.id,
    'Two different existing hosts are required. Set RELAY_SMOKE_HOST_A and RELAY_SMOKE_HOST_B ' +
    'to registered host handles; this script never creates permanent hosts.');

  return { a, b };
}

export async function loadState(file = statePath) {
  const state = JSON.parse(await readFile(file, 'utf8'));

  assert(state?.version === 1 && /^[a-f0-9]{10}$/.test(state.runId), 'Invalid smoke-test state.');
  assert(state.addressUrl && state.relayUrl && state.organization?.id, 'Incomplete smoke-test state.');

  for (const side of ['a', 'b']) {
    if (state.sides?.[side]) {
      validateWork(state.sides[side], state.runId, side);
    }
  }

  return state;
}

export async function saveState(state, file = statePath) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}

export async function moveCompletedState(state, file = statePath) {
  const destination = resolve(dirname(file), 'completed-' + state.runId + '.json');
  await rename(file, destination);

  return destination;
}

export function workQuery(side) {
  return '?work_address_id=' + encodeURIComponent(side.id);
}

export async function askConfirmation(runId) {
  const expected = process.env.RELAY_SMOKE_CONFIRM;

  if (expected === runId) {
    return;
  }

  assert(process.stdin.isTTY, 'Set RELAY_SMOKE_CONFIRM=' + runId + ' to authorize cleanup.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await prompt.question('Type run ID ' + runId + ' to release only these test works: ');
    assert(answer.trim() === runId, 'Cleanup cancelled.');
  } finally {
    prompt.close();
  }
}

export async function execute(fn) {
  try {
    await fn();
  } catch (error) {
    // Provider errors and network exceptions may contain private URLs or tokens.
    logger.exception('command_failed', error);
    console.error('Smoke test failed. Check the sanitized error type above.');
    process.exitCode = 1;
  }
}
