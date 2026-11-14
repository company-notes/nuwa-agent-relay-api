#!/usr/bin/env node

/**
 * Trusted staging operator helper. This is intentionally NOT an Agent tool:
 * OAuth and Runtime capabilities stay in this process, never in the model.
 *
 * Required environment:
 *   NUWA_GATEWAY_OAUTH_TOKEN
 *   NUWA_GATEWAY_RUNTIME_TOKEN
 *   NUWA_GATEWAY_RECIPIENT_SESSION_ID
 *   NUWA_GATEWAY_SESSION_ID          optional office Gateway Session ID when acting for an approved coworker
 *   NUWA_GATEWAY_RELAY_ORIGIN        trusted staging Relay HTTPS origin
 *
 * Usage:
 * node scripts/GatewayFirstContactConfirm.mjs --sender-session-id <uuid> --message-id <uuid> --native-thread-id <OpenMausBot-thread>
 *   --authorize-staging-confirmation
 *
 * Direct mode requires the recipient Runtime. For an approved shared office
 * Gateway, set NUWA_GATEWAY_SESSION_ID and supply that Gateway's OAuth/Runtime
 * credentials; Relay verifies the recipient's active teammate approval.
 */
const OPTIONS = new Map([
  ['--sender-session-id', 'senderSessionID'],
  ['--message-id', 'messageID'],
  ['--native-thread-id', 'nativeThreadID'],
]);

function parse(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];

    if (key === '--help' || key === '-h') {
      console.log('Usage: node scripts/GatewayFirstContactConfirm.mjs ' +
        '--sender-session-id <ID> ' +
        '--message-id <ID> --native-thread-id <ID> --authorize-staging-confirmation');
      process.exit(0);
    }

    if (key === '--authorize-staging-confirmation') {
      args.authorized = true;
      continue;
    }

    const property = OPTIONS.get(key);
    const value = argv[++index];

    if (!property || !value || value.startsWith('--') || args[property]) {
      throw Error('Unexpected, missing or repeated CLI option.');
    }

    args[property] = value;
  }

  if (!args.authorized || [...OPTIONS.values()].some((field) => !args[field])) {
    throw Error('Missing parameters or explicit --authorize-staging-confirmation.');
  }

  if (!/^[A-Za-z0-9._:-]{1,192}$/.test(args.senderSessionID) ||
      !/^[0-9a-f-]{36}$/i.test(args.messageID) ||
      !/^[A-Za-z0-9._:-]{1,192}$/.test(args.nativeThreadID)) {
    throw Error('Invalid sender Session, Relay Message or native Thread identifier.');
  }

  return args;
}

async function run() {
  const args = parse(process.argv.slice(2));
  const oauth = process.env.NUWA_GATEWAY_OAUTH_TOKEN;
  const runtime = process.env.NUWA_GATEWAY_RUNTIME_TOKEN;
  const recipient = process.env.NUWA_GATEWAY_RECIPIENT_SESSION_ID;
  const gateway = process.env.NUWA_GATEWAY_SESSION_ID;
  const origin = process.env.NUWA_GATEWAY_RELAY_ORIGIN;

  if (!oauth || !runtime || !recipient || !origin) {
    throw Error('Required private OAuth/Runtime/recipient Session/Relay origin is not configured.');
  }

  // The destination comes from trusted process configuration, never a model
  // tool argument, untrusted Webhook event or optional CLI flag.
  const configured = new URL(origin);

  if (configured.protocol !== 'https:' || !configured.hostname.includes('.') ||
      configured.username || configured.password || configured.search ||
      configured.hash || configured.pathname !== '/') {
    throw Error('NUWA_GATEWAY_RELAY_ORIGIN must be a clean trusted HTTPS staging origin.');
  }

  const identifier = /^[A-Za-z0-9._:-]{1,192}$/;

  if (!identifier.test(recipient) || gateway && (!identifier.test(gateway) || gateway === recipient)) {
    throw Error('Invalid trusted recipient or office Gateway Session configuration.');
  }

  const path = gateway
    ? '/v2/gateway-teammates/' + encodeURIComponent(recipient) +
        '/first-contacts/' + encodeURIComponent(args.senderSessionID)
    : '/v2/gateway-first-contacts/' + encodeURIComponent(args.senderSessionID);
  const url = new URL(path, configured.origin);
  url.searchParams.set('session_id', gateway ?? recipient);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer ' + oauth,
      'x-nuwa-runtime-token': runtime,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messageID: args.messageID,
      nativeThreadID: args.nativeThreadID,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw Error('Confirmation was rejected (HTTP ' + response.status +
      '). Inspect the recipient Session route and pending first contact.');
  }

  const receipt = await response.json();

  if (!receipt.ok || receipt.data?.nativeThreadID !== args.nativeThreadID) {
    throw Error('Relay returned an unexpected native conversation confirmation.');
  }

  console.log('First-contact confirmation accepted for the selected sender Session.');
  console.log('Already confirmed: ' + Boolean(receipt.data.alreadyConfirmed));
  console.log('No authorization credentials have been printed.');
}

run().catch((error) => {
  console.error('Gateway confirmation failed:', error.message);
  process.exitCode = 1;
});
