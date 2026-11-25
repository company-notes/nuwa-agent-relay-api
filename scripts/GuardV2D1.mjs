import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WranglerRunner } from './WranglerRunner.mjs';
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

const GATEWAY_TABLES = [
  'gateway_routes',
  'gateway_conversations',
  'gateway_first_contacts',
];

const ROSTER_TABLES = ['gateway_teammates'];

const OFFICE_TABLES = ['gateway_office_coworkers'];
const DELEGATION_TABLES = ['gateway_office_delegation'];
const RESET_TABLES = ['management_agent_resets'];
const INBOX_TABLES = ['inbox_events'];

const KNOWN_INFRASTRUCTURE = new Set(['d1_migrations', 'sqlite_sequence', '_cf_KV', '_cf_METADATA']);

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

  const unknown = [...tables].filter((name) => !REQUIRED.includes(name) && !GATEWAY_TABLES.includes(name) && !ROSTER_TABLES.includes(name) && !OFFICE_TABLES.includes(name) && !DELEGATION_TABLES.includes(name) &&
    !RESET_TABLES.includes(name) && !INBOX_TABLES.includes(name));

  if (unknown.length) {
    throw new Error('Refusing unrecognized D1 tables: ' + unknown.join(', '));
  }

  if (tables.size === 0 && !requireMigrated) {
    return 'empty';
  }

  if (REQUIRED.some((name) => !tables.has(name))) {
    throw new Error('Refusing empty or partially migrated V2 D1. Apply the V2 migration first.');
  }

  const gatewayTables = GATEWAY_TABLES.filter((name) => tables.has(name));

  if (gatewayTables.length > 0 && gatewayTables.length !== GATEWAY_TABLES.length) {
    throw new Error('Refusing partially migrated Gateway V2 D1.');
  }

  if (requireMigrated && gatewayTables.length !== GATEWAY_TABLES.length) {
    throw new Error('Gateway V2 migration is not applied.');
  }

  const rosterTables = ROSTER_TABLES.filter((name) => tables.has(name));

  if (rosterTables.length > 0 && gatewayTables.length !== GATEWAY_TABLES.length) {
    throw new Error('Refusing Gateway roster without its base V2 tables.');
  }

  if (requireMigrated && rosterTables.length !== ROSTER_TABLES.length) {
    throw new Error('Gateway roster migration is not applied.');
  }

  const officeTables = OFFICE_TABLES.filter((name) => tables.has(name));

  if (officeTables.length > 0 && rosterTables.length !== ROSTER_TABLES.length) {
    throw new Error('Refusing office Gateway registration without the authorized roster.');
  }

  if (requireMigrated && officeTables.length !== OFFICE_TABLES.length) {
    throw new Error('Office Gateway registration migration is not applied.');
  }

  const delegationTables = DELEGATION_TABLES.filter((name) => tables.has(name));

  if (delegationTables.length > 0 && officeTables.length !== OFFICE_TABLES.length) {
    throw new Error('Refusing office delegation without registered office tables.');
  }

  if (requireMigrated && delegationTables.length !== DELEGATION_TABLES.length) {
    throw new Error('Office delegation migration is not applied.');
  }

  if (tables.has('management_agent_resets') &&
      DELEGATION_TABLES.some((name) => !tables.has(name))) {
    throw new Error('Agent reset migration requires complete Gateway office delegation.');
  }

  if (requireMigrated && RESET_TABLES.some((name) => !tables.has(name))) {
    throw new Error('Agent management reset migration (0010) is not applied.');
  }

  if (tables.has('inbox_events') && RESET_TABLES.some((name) => !tables.has(name))) {
    throw new Error('Inbox events require the agent management reset migration.');
  }

  if (requireMigrated && INBOX_TABLES.some((name) => !tables.has(name))) {
    throw new Error('Inbox events migration (0011) is not applied.');
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

export function validateProductionBindings(config) {
  const bindings = config.services?.filter((item) => item.binding === 'ADDRESS_WORKER') ?? [];

  const mcpBindings = config.services?.filter((item) => item.binding === 'MCP_WORKER') ?? [];

  if (config.name !== 'nuwa-agent-relay-api' ||
      bindings.length !== 1 || bindings[0].service !== 'agent-address' ||
      mcpBindings.length !== 1 || mcpBindings[0].service !== 'nuwa-agent-relay-mcp') {
    throw new Error('Refusing Relay deployment without canonical Agent Address and MCP service bindings.');
  }
}

export function requireOfficeConnectionColumn(names) {
  if (!names.includes('independent_at')) {
    throw new Error('Office independent connection migration (0008) is not applied.');
  }
}

export function requireOfficeIdentityColumns(names) {
  if (!names.includes('identity_revision') || !names.includes('identity_available')) {
    throw new Error('Office identity projection migration (0009) is not applied.');
  }
}

function inspectNames(query) {
  const output = WranglerRunner.execute([
    'd1', 'execute', 'DB', '--remote',
    '--config', '.wrangler.deploy.jsonc', '--command', query, '--json',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return readTableNames(output);
}

export function guardRemoteDatabase(requireMigrated = false) {
  const config = JSON.parse(readFileSync('.wrangler.deploy.jsonc', 'utf8'));
  validateProductionBindings(config);

  const tables = inspectNames("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const classification = classifyDatabase(tables, requireMigrated);

  if (requireMigrated) {
    const columns = inspectNames(
      "SELECT name FROM pragma_table_info('gateway_office_coworkers') ORDER BY name",
    );
    requireOfficeConnectionColumn(columns);
    requireOfficeIdentityColumns(columns);
  }

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
