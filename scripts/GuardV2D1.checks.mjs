import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyDatabase, readTableNames, validateProductionBindings } from './GuardV2D1.mjs';

const v2 = [
  'agent_mailboxes', 'agent_aliases', 'threads', 'messages',
  'wake_subscriptions', 'wake_events', 'wake_registration_attempts',
  'message_read_receipts', 'wake_pairing_requests', 'wake_pairing_oauth_attempts',
];

const gateway = ['gateway_routes', 'gateway_conversations', 'gateway_first_contacts'];
const roster = ['gateway_teammates'];

test('accepts only a new empty or fully migrated V2 database', () => {
  assert.equal(classifyDatabase(['d1_migrations', '_cf_KV', '_cf_METADATA']), 'empty');
  assert.equal(classifyDatabase([...v2, 'd1_migrations', '_cf_KV']), 'v2');
  assert.equal(classifyDatabase([...v2, ...gateway]), 'v2');
  assert.equal(classifyDatabase([...v2, ...gateway, ...roster], true), 'v2');
  assert.throws(() => classifyDatabase([...v2, ...gateway], true), /Gateway roster migration/);
  assert.throws(() => classifyDatabase(v2, true), /Gateway V2 migration/);
});

test('blocks old production D1, mixed and partial schemas before migrate or deploy', () => {
  for (const names of [
    ['paired_hosts', 'threads', 'messages', 'agent_aliases'],
    [...v2, 'paired_hosts'],
    ['agent_mailboxes', 'messages'],
    ['secrets'],
    [...v2, gateway[0]],
    [...v2, gateway[0], gateway[1]],
    [...v2, ...roster],
    ['_cf_KV', 'paired_hosts'],
    ['_cf_UNKNOWN'],
  ]) {
    assert.throws(() => classifyDatabase(names));
  }

  assert.throws(() => classifyDatabase([], true), /partially migrated/);
});

test('fails closed on malformed Wrangler output instead of guessing about the D1 target', () => {
  assert.deepEqual(readTableNames(JSON.stringify([{
    success: true,
    results: [{ name: 'agent_mailboxes' }],
  }])), ['agent_mailboxes']);

  assert.throws(() => readTableNames('not JSON'));
  assert.throws(() => readTableNames(JSON.stringify([{ success: false, results: [] }])));
  assert.throws(() => readTableNames(JSON.stringify([{ success: true, results: [{}] }])));
});

test('guard, remote migration and deploy require the same private production config', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .scripts;
  const config = '--config .wrangler.deploy.jsonc';
  const guarded = 'node scripts/GuardV2D1.mjs --remote';

  assert.equal(scripts['db:migrate:remote'],
    guarded + ' && wrangler d1 migrations apply DB --remote ' + config);
  assert.equal(scripts.deploy,
    guarded + ' --require-migrated && wrangler deploy ' + config);

  const guard = readFileSync(new URL('./GuardV2D1.mjs', import.meta.url), 'utf8');

  assert.match(guard, /WranglerRunner\.execute/);
  assert.ok(guard.includes("'--config', '.wrangler.deploy.jsonc'"));
  assert.doesNotMatch(guard, /execFileSync\('npx'/);
});

test('requires canonical Agent Address binding before remote schema inspection or deploy', () => {
  const config = {
    name: 'nuwa-agent-relay-api',
    services: [{ binding: 'ADDRESS_WORKER', service: 'agent-address' }],
  };

  assert.doesNotThrow(() => validateProductionBindings(config));

  for (const missing of [
    { ...config, services: [] },
    { ...config, services: [{ binding: 'ADDRESS_WORKER', service: 'other-worker' }] },
    { ...config, services: [...config.services, ...config.services] },
    { ...config, name: 'other-worker' },
  ]) {
    assert.throws(() => validateProductionBindings(missing),
      /canonical Agent Address service binding/);
  }
});
