import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'agent_mailboxes',
  'agent_aliases',
  'threads',
  'messages',
  'wake_subscriptions',
  'wake_events',
  'wake_registration_attempts',
  'message_read_receipts',
  'wake_pairing_requests',
  'wake_pairing_oauth_attempts',
];

const KNOWN_INFRASTRUCTURE = new Set(['d1_migrations', 'sqlite_sequence']);

export function classifyDatabase(names, requireMigrated = false) {
  assert.ok(Array.isArray(names) && names.every((name) => typeof name === 'string'),
    'The D1 schema inspection returned invalid table names.');

  const tables = new Set(names.filter((name) =>
    !KNOWN_INFRASTRUCTURE.has(name) && !name.startsWith('sqlite_'),
  ));

  if (tables.has('paired_hosts') || tables.has('enrollments') ||
      tables.has('addresses') || tables.has('works') || tables.has('hosts')) {
    throw new Error('Refusing legacy Host/Work D1 database. Use a new isolated V2 D1.');
  }

  const unknown = [...tables].filter((name) => !REQUIRED.includes(name));

  if (unknown.length) {
    throw new Error('Refusing unrecognized D1 tables: ' + unknown.join(', '));
  }

  if (tables.size === 0 && !requireMigrated) {
    return 'empty';
  }

  if (REQUIRED.some((name) => !tables.has(name))) {
    throw new Error('Refusing empty or partially migrated V2 D1. Apply the V2 migration first.');
  }

  return 'v2';
}

export function readTableNames(output) {
  const parsed = JSON.parse(output);

  if (!Array.isArray(parsed) || parsed.length !== 1 ||
      parsed[0]?.success !== true || !Array.isArray(parsed[0]?.results)) {
    throw new Error('Unexpected Wrangler D1 JSON schema response; refusing to continue.');
  }

  const names = parsed[0].results.map((item) => item?.name);

  if (!names.every((name) => typeof name === 'string')) {
    throw new Error('Incomplete Wrangler D1 schema response; refusing to continue.');
  }

  return names;
}

export function guardRemoteDatabase(requireMigrated = false) {
  const query = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
  const output = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'DB', '--remote',
    '--command', query, '--json',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const classification = classifyDatabase(readTableNames(output), requireMigrated);
  process.stdout.write('Verified isolated Relay V2 D1: ' + classification + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argumentsValue = process.argv.slice(2);

  if (argumentsValue.some((arg) => !['--remote', '--require-migrated'].includes(arg)) ||
      !argumentsValue.includes('--remote')) {
    throw new Error('Usage: GuardV2D1.mjs --remote [--require-migrated]');
  }

  guardRemoteDatabase(argumentsValue.includes('--require-migrated'));
}
