import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { SmokeLogger } from './Logger.mjs';

test('smoke diagnostics record only error type and not credential-bearing exception messages', () => {
  const original = console.warn;
  const observed = [];
  console.warn = (...args) => {
    observed.push(args);
  };

  try {
    const logger = new SmokeLogger('smoke.oauth');
    logger.exception('callback_rejected', new Error(
      'private-token and https://api2.cursor.sh/webhook/secret',
    ));

    assert.deepEqual(observed, [[
      'smoke.oauth.callback_rejected',
      { errorType: 'Error' },
    ]]);
    assert.equal(JSON.stringify(observed).includes('private-token'), false);
    assert.equal(JSON.stringify(observed).includes('/webhook/secret'), false);
  } finally {
    console.warn = original;
  }
});
