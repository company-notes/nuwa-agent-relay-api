import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
