#!/usr/bin/env node
// Real read-only public smoke; the unauthenticated MailTrigger POST must NOT
// modify D1, and this script never sends email or enrolls Agents.
import assert from 'node:assert/strict';

const origins = [
  'https://agent-relay.company-notes.com',
  'https://nuwa-agent-relay-api.nuwainfo.workers.dev',
];

async function request(origin, path, method = 'GET') {
  const response = await fetch(origin + path, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...(method === 'POST' ? {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    } : {}),
  });

  console.log(origin + path + ': HTTP ' + response.status);

  return response;
}

for (const origin of origins) {
  const health = await request(origin, '/health');
  assert.equal(health.status, 200, 'Relay health endpoint must be available');
  const payload = await health.json();
  assert.equal(payload?.data?.service, 'nuwa-agent-relay-api');
  assert.equal(payload?.data?.status, 'ok');

  const protectedPaths = ['/v2/inbox', '/v2/agent-inbox', '/v2/agent-mailboxes'];

  for (const path of protectedPaths) {
    const response = await request(origin, path);
    assert.equal(response.status, 401, 'Missing OAuth must deny ' + path);
  }

  const receipt = await request(origin, '/v1/mailtrigger/receipt', 'POST');
  assert.equal(receipt.status, 401,
    'Legacy external MailTrigger receipt URL must remain available but reject unsigned callers');
}

for (const [path, contentType, marker] of [
  ['/', 'text/html', 'Nuwa Relay'],
  ['/start', 'text/html', 'Nuwa Relay'],
  ['/start.css', 'text/css', '.diagram-pagination'],
  ['/start.js', 'text/javascript', 'gatewaySetup'],
]) {
  const response = await request(origins[0], path);
  assert.equal(response.status, 200, 'Canonical website must serve ' + path);
  assert.ok(response.headers.get('content-type')?.includes(contentType));
  assert.ok((await response.text()).includes(marker));
}

console.log('PASS: official Relay API, public website, V2 authorization boundaries and original MailTrigger webhook.');
