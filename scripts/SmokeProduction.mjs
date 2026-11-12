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

  const protectedPaths = ['/v2/inbox', '/v2/agent-inbox', '/v2/agents/mailbox'];

  for (const path of protectedPaths) {
    const response = await request(origin, path);
    assert.equal(response.status, 401, 'Missing OAuth must deny ' + path);
  }

  const receipt = await request(origin, '/v1/mailtrigger/receipt', 'POST');
  assert.equal(receipt.status, 401,
    'Legacy external MailTrigger receipt URL must remain available but reject unsigned callers');
}

console.log('PASS: official Relay API, V2 authorization boundaries and original MailTrigger webhook.');
