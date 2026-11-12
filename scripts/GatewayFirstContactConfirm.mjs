#!/usr/bin/env node

/**
 * Trusted staging operator helper. This is intentionally NOT an Agent tool:
 * OAuth and Runtime capabilities stay in this process, never in the model.
 *
 * Required environment:
 *   NUWA_GATEWAY_OAUTH_TOKEN
 *   NUWA_GATEWAY_RUNTIME_TOKEN
 *   NUWA_GATEWAY_RECIPIENT_SESSION_ID
 *
 * Usage:
 * node scripts/GatewayFirstContactConfirm.mjs --relay-url https://relay-staging.example.org
 *   --sender-session-id <uuid> --message-id <uuid> --native-thread-id <OpenMausBot-thread>
 *   --authorize-staging-confirmation
 *
 * The receiving Runtime must be the authorized owner of the receiving Session.
 */
const OPTIONS = new Map([
  ['--relay-url', 'relayURL'],
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
        '--relay-url <HTTPS staging origin> --sender-session-id <ID> ' +
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

  const uri = new URL(args.relayURL);

  if (uri.protocol !== 'https:' || !uri.hostname.includes('.') ||
      uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '/') {
    throw Error('Use a clean HTTPS staging origin without credentials or query parameters.');
  }

  if (!/^[A-Za-z0-9._:-]{1,192}$/.test(args.senderSessionID) ||
      !/^[0-9a-f-]{36}$/i.test(args.messageID) ||
      !/^[A-Za-z0-9._:-]{1,192}$/.test(args.nativeThreadID)) {
    throw Error('Invalid sender Session, Relay Message or native Thread identifier.');
  }

  return { ...args, relayURL: uri.origin };
}

async function run() {
  const args = parse(process.argv.slice(2));
  const oauth = process.env.NUWA_GATEWAY_OAUTH_TOKEN;
  const runtime = process.env.NUWA_GATEWAY_RUNTIME_TOKEN;
  const recipient = process.env.NUWA_GATEWAY_RECIPIENT_SESSION_ID;

  if (!oauth || !runtime || !recipient) {
    throw Error('Required OAuth/Runtime/recipient Session private environment is not configured.');
  }

  const url = new URL('/v2/gateway-first-contacts/' +
    encodeURIComponent(args.senderSessionID), args.relayURL);
  url.searchParams.set('session_id', recipient);

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
