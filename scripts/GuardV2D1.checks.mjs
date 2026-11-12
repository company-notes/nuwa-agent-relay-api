import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDatabase, readTableNames } from './GuardV2D1.mjs';

const v2 = [
  'agent_mailboxes', 'agent_aliases', 'threads', 'messages',
  'wake_subscriptions', 'wake_events', 'wake_registration_attempts',
  'message_read_receipts', 'wake_pairing_requests', 'wake_pairing_oauth_attempts',
];

const gateway = ['gateway_routes', 'gateway_conversations', 'gateway_first_contacts'];

test('accepts only a new empty or fully migrated V2 database', () => {
  assert.equal(classifyDatabase(['d1_migrations', '_cf_KV', '_cf_METADATA']), 'empty');
  assert.equal(classifyDatabase([...v2, 'd1_migrations', '_cf_KV']), 'v2');
  assert.equal(classifyDatabase([...v2, ...gateway], true), 'v2');
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
