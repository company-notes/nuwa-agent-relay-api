import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAuthorizationURL,
  checkCallback,
  listenForCallback,
  oauthChallenge,
} from './Auth.mjs';
import { planHosts } from './setup.mjs';

import {
  chooseHosts,
  loadState,
  moveCompletedState,
  request,
  saveState,
  validateWork,
} from './Shared.mjs';

const org = { id: 'org-1', slug: 'example' };
const a = { id: 'host-a', path: 'machine-a', canonical: 'example/machine-a' };
const b = { id: 'host-b', path: 'machine-b', canonical: 'example/machine-b' };

function sampleState() {
  return {
    version: 1,
    runId: 'aabbccddee',
    addressUrl: 'https://address.example.com',
    relayUrl: 'https://relay.example.com',
    organization: org,
    sides: {
      a: {
        id: 'work-a',
        path: 'machine-a/relay-smoke-aabbccddee-a',
        parentAddressId: 'host-a',
      },
    },
  };
}

test('host selection only accepts existing and distinct hosts in a shared organization', () => {
  const statusA = { organization: org, hosts: [a, b] };
  const statusB = { organization: org, hosts: [a, b] };

  assert.deepEqual(chooseHosts(statusA, statusB), { a, b });

  assert.throws(() => chooseHosts(statusA, statusB, 'machine-a', 'machine-a'), /Two different/);
  assert.throws(() => chooseHosts(statusA, statusB, 'unknown', 'machine-b'), /Two different/);
  assert.throws(
    () => chooseHosts(statusA, { organization: { id: 'other-org' }, hosts: [a, b] }),
    /same organization/,
  );
});

test('cleanup guard rejects unrelated work addresses even if their work ID exists', () => {
  const state = sampleState();

  assert.equal(validateWork(state.sides.a, state.runId, 'a').id, 'work-a');
  assert.throws(
    () => validateWork({ id: 'work-other', path: 'machine-a/production', parentAddressId: 'host-a' },
      state.runId, 'a'),
    /Refusing unrelated/,
  );
  assert.throws(
    () => validateWork({ id: 'host-a', path: 'relay-smoke-aabbccddee-a', parentAddressId: null },
      state.runId, 'a'),
    /no parent host/,
  );
});

test('state is private, validated and archiveable without any token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-check-'));
  const path = join(dir, 'session.json');
  const state = sampleState();

  try {
    await saveState(state, path);

    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o077, 0, 'Other users must not read smoke state.');

    const loaded = await loadState(path);
    assert.deepEqual(loaded, state);

    const contents = await readFile(path, 'utf8');
    assert.ok(!contents.includes('Bearer '), 'OAuth tokens must not be stored.');

    const archived = await moveCompletedState(state, path);
    assert.equal(archived, join(dir, 'completed-' + state.runId + '.json'));
    assert.deepEqual(JSON.parse(await readFile(archived, 'utf8')), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('request validates API error status and never sends auth outside its service origin', async () => {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: url.toString(), options });
    return Response.json({ ok: true, data: { status: 'ok' } });
  };

  try {
    const data = await request('https://relay.example.com', '/health', null);

    assert.equal(data.status, 'ok');
    assert.equal(calls.length, 1);
    assert.ok(!('authorization' in calls[0].options.headers));

    await assert.rejects(() => request('https://relay.example.com', 'https://other.example.com/health',
      'secret-value'), /stay on the configured/);
    assert.equal(calls.length, 1, 'A cross-origin request must never be made.');

    await assert.rejects(() => request('http://relay.example.com', '/health', 'secret-value'), /Only HTTPS/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('upstream non-success responses are rejected, not mistaken for successful submissions', async () => {
  const original = globalThis.fetch;

  globalThis.fetch = async () => Response.json(
    { ok: false, error: { code: 'mailtrigger_send_failed', message: 'Delivery rejected' } },
    { status: 502 },
  );

  try {
    await assert.rejects(
      () => request('https://relay.example.com', '/v1/messages', 'secret', {
        method: 'POST',
        expected: [201],
        body: { body: 'smoke test' },
      }),
      /HTTP 502.*mailtrigger_send_failed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});


test('PKCE challenge matches RFC 7636 and authorization carries state', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(oauthChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

  const url = new URL(buildAuthorizationURL(
    'https://address.example.com', 'local-public-client',
    'http://127.0.0.1:34343/oauth/callback', verifier, 'secure-state',
  ));

  assert.equal(url.origin, 'https://address.example.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'secure-state');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:34343/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge'), oauthChallenge(verifier));
});

test('OAuth callback rejects wrong, missing or duplicate state and code', () => {
  assert.equal(checkCallback('/oauth/callback?state=expected&code=abc', 'expected'), 'abc');
  assert.throws(() => checkCallback('/oauth/callback?state=forged&code=abc', 'expected'), /state mismatch/);
  assert.throws(() => checkCallback('/oauth/callback?code=abc', 'expected'), /Unexpected OAuth/);
  assert.throws(() => checkCallback('/oauth/callback?state=expected&state=expected&code=abc', 'expected'),
    /Unexpected OAuth/);
  assert.throws(() => checkCallback('/oauth/callback?state=expected&code=abc&code=other', 'expected'),
    /one authorization code/);
  assert.throws(() => checkCallback('/oauth/callback?state=expected&error=access_denied', 'expected'),
    /denied/);
});

test('OAuth loopback callback ignores forged state and accepts a valid callback', async () => {
  const receiver = await listenForCallback('correct-state', 5000);

  try {
    const bad = await fetch(receiver.redirectURI + '?state=bad-state&code=stolen');
    assert.equal(bad.status, 400);

    const good = await fetch(receiver.redirectURI + '?state=correct-state&code=good-code');
    assert.equal(good.status, 200);
    assert.equal(await receiver.received, 'good-code');
  } finally {
    await receiver.close();
  }
});

test('automatic setup plans distinct run-scoped hosts or uses explicit existing hosts', () => {
  const status = { organization: org, hosts: [a, b] };
  const planned = planHosts('aabbccddee', status, status);

  assert.deepEqual(planned.a, { name: 'relay-smoke-aabbccddee-a', existed: false, id: null });
  assert.deepEqual(planned.b, { name: 'relay-smoke-aabbccddee-b', existed: false, id: null });

  const existing = planHosts('aabbccddee', status, status, 'machine-a', 'machine-b');
  assert.deepEqual(existing.a, { name: 'machine-a', existed: true, id: 'host-a' });
  assert.deepEqual(existing.b, { name: 'machine-b', existed: true, id: 'host-b' });

  assert.throws(() => planHosts('aabbccddee', status, status, 'machine-a', 'machine-a'),
    /different Host/);
  assert.throws(() => planHosts('aabbccddee', status, status, 'bad\/name', 'machine-b'),
    /Host handles/);
});
