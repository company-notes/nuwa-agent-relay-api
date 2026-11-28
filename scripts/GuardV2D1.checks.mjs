import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyDatabase, readTableNames, requireOfficeConnectionColumn, requireOfficeIdentityColumns, requireOfficeRemovalColumn, requireOfficeWakeColumns, validateProductionBindings } from './GuardV2D1.mjs';

const v2 = [
  'agent_mailboxes', 'agent_aliases', 'threads', 'messages',
  'wake_subscriptions', 'wake_events', 'wake_registration_attempts',
  'message_read_receipts', 'wake_pairing_requests', 'wake_pairing_oauth_attempts',
];

const gateway = ['gateway_routes', 'gateway_conversations', 'gateway_first_contacts'];
const roster = ['gateway_teammates'];
const office = ['gateway_office_coworkers'];
const delegation = ['gateway_office_delegation'];
const reset = ['management_agent_resets'];
const inbox = ['inbox_events'];
const collaboration = ['collaboration_policies', 'collaboration_owner_sessions'];
const submissions = ['message_submissions'];

test('accepts only a new empty or fully migrated V2 database', () => {
  assert.equal(classifyDatabase(['d1_migrations', '_cf_KV', '_cf_METADATA']), 'empty');
  assert.equal(classifyDatabase([...v2, 'd1_migrations', '_cf_KV']), 'v2');
  assert.equal(classifyDatabase([...v2, ...gateway]), 'v2');
  assert.equal(classifyDatabase([...v2, ...gateway, ...roster, ...office, ...delegation, ...reset, ...inbox, ...collaboration, ...submissions], true), 'v2');
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster, ...office, ...delegation, ...reset, ...inbox, ...collaboration], true), /Message submissions migration/);
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster, ...office, ...delegation, ...reset, ...inbox], true), /Collaboration policy migration/);
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster, ...office, ...delegation, ...reset], true),
    /Inbox events migration/);
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster, ...office, ...delegation], true),
    /management reset migration/);
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster, ...office], true),
    /Office delegation migration/);
  assert.throws(() => classifyDatabase([...v2, ...gateway, ...roster], true),
    /Office Gateway registration migration/);
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
    [...v2, ...gateway, ...office],
    [...v2, ...gateway, ...roster, ...delegation],
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
    services: [
      { binding: 'ADDRESS_WORKER', service: 'agent-address' },
      { binding: 'MCP_WORKER', service: 'nuwa-agent-relay-mcp' },
    ],
  };

  assert.doesNotThrow(() => validateProductionBindings(config));

  for (const missing of [
    { ...config, services: [] },
    { ...config, services: [{ binding: 'ADDRESS_WORKER', service: 'other-worker' }] },
    { ...config, services: [...config.services, ...config.services] },
    { ...config, services: config.services.slice(0, 1) },
    { ...config, services: [config.services[0], { binding: 'MCP_WORKER', service: 'untrusted' }] },
    { ...config, name: 'other-worker' },
  ]) {
    assert.throws(() => validateProductionBindings(missing),
      /canonical Agent Address and MCP service bindings/);
  }
});

test('requires the independent connection column before deployment', () => {
  assert.throws(() => requireOfficeConnectionColumn(['activated_at']), /migration \(0008\)/);
  assert.doesNotThrow(() => requireOfficeConnectionColumn(['activated_at', 'independent_at']));
});

test('requires the identity projection columns before deployment', () => {
  assert.throws(() => requireOfficeIdentityColumns(['identity_revision']), /migration \(0009\)/);
  assert.doesNotThrow(() => requireOfficeIdentityColumns(['identity_revision', 'identity_available']));
});

test('requires the office removal column before deployment', () => {
  assert.throws(() => requireOfficeRemovalColumn(['activated_at']), /migration \(0014\)/);
  assert.doesNotThrow(() => requireOfficeRemovalColumn(['activated_at', 'removed_at']));
});

test('requires the targeted office Wake columns before deployment', () => {
  assert.throws(() => requireOfficeWakeColumns(['office_gateway_session_id']), /migration \(0015\)/);
  assert.doesNotThrow(() => requireOfficeWakeColumns(['office_gateway_session_id', 'office_approved_at']));
});
