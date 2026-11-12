import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration } from './V2Smoke.mjs';

const base = {
  NUWA_SMOKE_RELAY_URL: 'https://relay.example.com',
  NUWA_SMOKE_ADDRESS_URL: 'https://address.example.com',
  NUWA_SMOKE_OAUTH_A: 'oauth-a',
  NUWA_SMOKE_RUNTIME_A: 'runtime-a',
  NUWA_SMOKE_SESSION_A: 'session-a',
  NUWA_SMOKE_OAUTH_B: 'oauth-b',
  NUWA_SMOKE_RUNTIME_B: 'runtime-b',
  NUWA_SMOKE_SESSION_B: 'session-b',
  NUWA_SMOKE_AUTHORIZE_SEND: 'yes',
};

test('real V2 smoke requires explicitly authorized identities and send approval', () => {
  assert.deepEqual(configuration(base).sides.a.sessionID, 'session-a');
  assert.throws(() => configuration({ ...base, NUWA_SMOKE_AUTHORIZE_SEND: 'no' }),
    /authorize real mail/);
  assert.throws(() => configuration({ ...base, NUWA_SMOKE_OAUTH_B: '' }),
    /NUWA_SMOKE_OAUTH_B/);
});

test('real V2 smoke rejects unsafe or mixed URL origins without network calls', () => {
  assert.throws(() => configuration({ ...base, NUWA_SMOKE_RELAY_URL: 'http://relay.example.com' }));
  assert.throws(() => configuration({ ...base, NUWA_SMOKE_RELAY_URL:
    'https://relay.example.com/steal' }));
  assert.throws(() => configuration({ ...base, NUWA_SMOKE_ADDRESS_URL:
    'https://relay.example.com' }));
});
