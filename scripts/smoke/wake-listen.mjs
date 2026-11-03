import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { accessToken, assert, execute, loadState, request, statePath, workQuery } from './Shared.mjs';
import { verifyWakeSignature } from './WakeAuth.mjs';

await execute(async () => {
  const state = await loadState();
  const work = state.sides.b;
  assert(work && !work.released, 'Side B must be active.');

  const secretPath = join(dirname(statePath), 'wake-b.json');
  const registered = JSON.parse(await readFile(secretPath, 'utf8'));
  assert(registered.workAddressId === work.id,
    'Saved wake subscription does not belong to Side B.');

  const port = Number(process.env.RELAY_SMOKE_WAKE_PORT || '8765');
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid wake port.');
  const seen = new Set();

  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST' || req.url !== '/wake') {
      reply(404, { ok: false });
      return;
    }

    let body = '';

    for await (const part of req) {
      body += part;
      if (body.length > 4096) {
        reply(413, { ok: false });
        return;
      }
    }

    if (!verifyWakeSignature(
      registered.signingSecret, body, req.headers['x-nuwa-wake-signature'],
    )) {
      reply(401, { ok: false });
      return;
    }

    let event;

    try {
      event = JSON.parse(body);
    } catch {
      reply(400, { ok: false });
      return;
    }

    if (event?.event !== 'nuwa.message.available' ||
      event.workAddressId !== work.id ||
      typeof event.messageId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(event.messageId)) {
      reply(400, { ok: false });
      return;
    }

    if (seen.has(event.messageId)) {
      reply(200, { ok: true, duplicate: true });
      return;
    }

    try {
      const token = await accessToken('b', state.addressUrl);
      const message = await request(
        state.relayUrl,
        '/v1/messages/' + encodeURIComponent(event.messageId) + workQuery(work),
        token,
      );

      seen.add(event.messageId);
      console.log('Agent B awakened for message ' + event.messageId);
      console.log(JSON.stringify(message, null, 2));
      // This is the integration point for the actual local Agent runtime.
      reply(200, { ok: true });
    } catch {
      // Do not acknowledge failed OAuth fetches; the Worker will retry.
      reply(503, { ok: false });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('Signed wake listener on http://127.0.0.1:' + port + '/wake');
    console.log('Expose via a separately configured HTTPS ingress; do not expose this HTTP port publicly.');
  });
});
