import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { accessToken, assert, execute, loadState, request, statePath, workQuery } from './Shared.mjs';

await execute(async () => {
  const callbackUrl = process.argv[2];
  assert(callbackUrl, 'Usage: npm run smoke:wake:register -- https://your-public-domain.example/wake');

  const state = await loadState();
  const token = await accessToken('b', state.addressUrl);
  const work = state.sides.b;
  assert(work && !work.released, 'Side B must be an active Work.');

  const subscription = await request(
    state.relayUrl, '/v1/wake-subscription' + workQuery(work),
    token,
    { method: 'POST', expected: [201], body: { callbackUrl } },
  );

  const file = join(dirname(statePath), 'wake-b.json');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });

  await writeFile(file, JSON.stringify({
    version: 1,
    workAddressId: work.id,
    callbackUrl: subscription.callbackUrl,
    signingSecret: subscription.signingSecret,
  }, null, 2) + '\n', { mode: 0o600 });

  console.log('Wake subscription registered for ' + work.canonical);
  console.log('Private signing secret stored locally in ' + file);
  console.log('Next: npm run smoke:wake:listen, then send from Side A.');
});
