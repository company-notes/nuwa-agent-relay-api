import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'NUWA_SMOKE_RELAY_URL', 'NUWA_SMOKE_ADDRESS_URL',
  'NUWA_SMOKE_OAUTH_A', 'NUWA_SMOKE_RUNTIME_A', 'NUWA_SMOKE_SESSION_A',
  'NUWA_SMOKE_OAUTH_B', 'NUWA_SMOKE_RUNTIME_B', 'NUWA_SMOKE_SESSION_B',
];

export function configuration(environment = process.env) {
  const missing = REQUIRED.filter((name) => !environment[name]);

  if (missing.length) {
    throw new Error('Missing explicit V2 smoke configuration: ' + missing.join(', '));
  }

  if (environment.NUWA_SMOKE_AUTHORIZE_SEND !== 'yes') {
    throw new Error('Set NUWA_SMOKE_AUTHORIZE_SEND=yes to authorize real mail submissions.');
  }

  const relay = new URL(environment.NUWA_SMOKE_RELAY_URL);
  const address = new URL(environment.NUWA_SMOKE_ADDRESS_URL);

  for (const url of [relay, address]) {
    if (url.protocol !== 'https:' || url.pathname !== '/' ||
        url.search || url.hash || url.username || url.password) {
      throw new Error('Smoke origins must be clean HTTPS origins.');
    }
  }

  if (relay.origin === address.origin) {
    throw new Error('Relay and Agent Address must have separate origins.');
  }

  return {
    relay: relay.origin,
    address: address.origin,
    sides: {
      a: {
        oauth: environment.NUWA_SMOKE_OAUTH_A,
        runtime: environment.NUWA_SMOKE_RUNTIME_A,
        sessionID: environment.NUWA_SMOKE_SESSION_A,
      },
      b: {
        oauth: environment.NUWA_SMOKE_OAUTH_B,
        runtime: environment.NUWA_SMOKE_RUNTIME_B,
        sessionID: environment.NUWA_SMOKE_SESSION_B,
      },
    },
  };
}

async function call(origin, side, path, { method = 'GET', body, relay = true } = {}) {
  const url = new URL(path, origin);

  if (url.origin !== origin) {
    throw new Error('Smoke request path escaped the configured origin.');
  }

  if (relay) {
    url.searchParams.set('session_id', side.sessionID);
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: 'Bearer ' + side.oauth,
      accept: 'application/json',
      ...(relay ? { 'x-nuwa-runtime-token': side.runtime } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok || response.status >= 300 && response.status < 400) {
    // Never stringify a response or an upstream URL which might contain secrets.
    throw new Error('V2 smoke API rejected request: status=' + response.status +
      ', operation=' + method + ' ' + url.pathname);
  }

  const envelope = await response.json();

  if (envelope?.ok !== true || !('data' in envelope)) {
    throw new Error('V2 smoke API returned an invalid response envelope.');
  }

  return envelope.data;
}

async function addressSession(config, side) {
  const status = await call(config.address, side, '/v2/account/status', { relay: false });
  const session = await call(config.address, side,
    '/v2/account/sessions/' + encodeURIComponent(side.sessionID), { relay: false });

  if (!status.organization?.id || session.id !== side.sessionID ||
      session.canonical.split('/')[0] !== status.organization.slug) {
    throw new Error('Smoke Session is not authorized in the expected Organization.');
  }

  await call(config.address, side,
    '/v2/account/sessions/' + encodeURIComponent(side.sessionID) + '/heartbeat',
    { method: 'POST', body: { runtimeToken: side.runtime }, relay: false });

  return { orgID: status.organization.id, session };
}

async function requireArrival(config, side, messageID) {
  const until = Date.now() + 60_000;

  while (Date.now() < until) {
    const receipt = await call(config.relay, side,
      '/v2/messages/' + encodeURIComponent(messageID) + '/receipt');

    if (receipt.arrivedInMailTrigger && receipt.receiptSource === 'webhook') {
      return receipt;
    }

    await setTimeout(1200);
  }

  throw new Error('No independently confirmed MailTrigger receipt for ' + messageID);
}

export async function runSmoke(config = configuration()) {
  const { a, b } = config.sides;
  const [sender, recipient] = await Promise.all([
    addressSession(config, a), addressSession(config, b),
  ]);

  if (sender.orgID !== recipient.orgID || a.sessionID === b.sessionID ||
      sender.session.agentId === recipient.session.agentId) {
    throw new Error('Use two distinct Agents with active Sessions in the same Organization.');
  }

  const probe = randomUUID();
  const message = await call(config.relay, a, '/v2/messages', {
    method: 'POST',
    body: {
      to: recipient.session.canonical,
      subject: 'Relay V2 staging E2E ' + probe,
      body: 'Staging Session A-to-B message ' + probe,
    },
  });

  await requireArrival(config, a, message.id);
  const inbox = await call(config.relay, b, '/v2/inbox');

  if (!inbox.some((item) => item.id === message.id)) {
    throw new Error('Recipient Session inbox did not contain the verified message.');
  }

  const read = await call(config.relay, b, '/v2/messages/' + message.id + '/read', {
    method: 'POST',
  });

  if (read.sessionID !== b.sessionID || !read.readAt) {
    throw new Error('Recipient Session read acknowledgement is incomplete.');
  }

  const reply = await call(config.relay, b, '/v2/threads/' + message.threadId + '/messages', {
    method: 'POST',
    body: { body: 'Staging Session B-to-A reply ' + probe },
  });

  await requireArrival(config, b, reply.id);
  const history = await call(config.relay, a, '/v2/threads/' + message.threadId);

  if (!history.some((item) => item.body === 'Staging Session B-to-A reply ' + probe)) {
    throw new Error('Sender cannot read the B-to-A reply in the original Thread.');
  }

  const agent = recipient.session.canonical.split('/').slice(0, 2).join('/');
  const handoff = await call(config.relay, a, '/v2/handoffs', {
    method: 'POST',
    body: { to: agent, subject: 'Staging Handoff ' + probe,
      body: 'Please accept this staged Agent delegation.' },
  });

  await requireArrival(config, a, handoff.id);
  const pending = await call(config.relay, b, '/v2/agent-inbox');

  if (!pending.some((item) => item.id === handoff.id)) {
    throw new Error('Agent inbox did not contain the verified Handoff.');
  }

  const acceptance = await call(config.relay, b, '/v2/handoffs/' + handoff.id + '/accept', {
    method: 'POST',
  });
  await requireArrival(config, b, acceptance.id);
  const handoffReply = await call(config.relay, b, '/v2/handoffs/' + handoff.id + '/reply', {
    method: 'POST',
    body: { body: 'Staging Handoff accepted by B ' + probe },
  });

  await requireArrival(config, b, handoffReply.id);
  const acceptedHistory = await call(config.relay, a, '/v2/threads/' + handoff.threadId);

  if (!acceptedHistory.some((item) => item.body === 'Staging Handoff accepted by B ' + probe)) {
    throw new Error('Sender did not observe accepted Handoff reply.');
  }

  return { messageID: message.id, messageThreadID: message.threadId,
    handoffID: handoff.id, handoffThreadID: handoff.threadId,
    verification: 'MailTrigger webhook receipt and Relay A-B-A Thread closure' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke().then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch((error) => {
    process.stderr.write(error instanceof Error ? error.message + '\n' : 'Smoke failed.\n');
    process.exitCode = 1;
  });
}
