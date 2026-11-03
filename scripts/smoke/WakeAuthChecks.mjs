import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyWakeSignature } from './WakeAuth.mjs';

test('wake listener authenticates HMAC body and rejects tampering', () => {
  const secret = '1234567890abcdef1234567890abcdef';
  const body = JSON.stringify({ event: 'nuwa.message.available', messageId: 'test' });
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyWakeSignature(secret, body, signature), true);
  assert.equal(verifyWakeSignature(secret, body + '!', signature), false);
  assert.equal(verifyWakeSignature(secret, body, 'sha256=deadbeef'), false);
  assert.equal(verifyWakeSignature('', body, signature), false);
});
