import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an interrupted mailbox setup resumes with the original Work and run ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-resume-'));
  const file = join(dir, 'session.json');
  const originalFetch = globalThis.fetch;

  const envNames = [
    'RELAY_SMOKE_STATE',
    'RELAY_SMOKE_TOKEN_A',
    'RELAY_SMOKE_TOKEN_B',
    'RELAY_SMOKE_HOST_A',
    'RELAY_SMOKE_HOST_B',
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  try {
    // Configure a private state path before dynamically importing the smoke modules.
    process.env.RELAY_SMOKE_STATE = file;
    process.env.RELAY_SMOKE_TOKEN_A = 'test-oauth-a';
    process.env.RELAY_SMOKE_TOKEN_B = 'test-oauth-a';
    process.env.RELAY_SMOKE_HOST_A = 'host-a';
    process.env.RELAY_SMOKE_HOST_B = 'host-b';

    const hosts = [
      { id: 'host-a', path: 'host-a', canonical: 'test/host-a' },
      { id: 'host-b', path: 'host-b', canonical: 'test/host-b' },
    ];
    const organization = { id: 'org-1', slug: 'test' };
    const works = new Map();
    let claims = 0;
    let attempts = 0;

    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      const json = (data, status = 200) => Response.json(
        { ok: status < 400, ...(status < 400 ? { data } : { error: data }) },
        { status },
      );

      if (url.pathname === '/health') {
        return json({ status: 'ok' });
      }

      if (url.pathname === '/v1/account/status') {
        const workId = url.searchParams.get('work_address_id');

        return json({
          organization,
          hosts,
          work: workId ? works.get(workId) ?? null : null,
        });
      }

      if (url.pathname === '/v1/account/work' && options.method === 'POST') {
        claims += 1;
        const body = JSON.parse(options.body);
        const host = hosts.find((item) => item.path === body.host);
        assert.ok(host);

        const work = {
          id: 'work-' + claims,
          path: host.path + '/' + body.handle,
          canonical: 'test/' + host.path + '/' + body.handle,
          parentAddressId: host.id,
        };
        works.set(work.id, work);

        return json({ organization, host, work }, 201);
      }

      if (url.pathname === '/v1/hosts/provision' && options.method === 'POST') {
        attempts += 1;

        if (attempts === 1) {
          return json(
            { code: 'managed_domain_not_found', message: 'No matching domain.' },
            503,
          );
        }

        const workId = url.searchParams.get('work_address_id');

        return json({
          mailboxId: 'mailbox-' + workId,
          mailboxEmail: 'mailbox-' + workId + '@test.example',
          created: true,
        }, 201);
      }

      throw new Error('Unexpected smoke request: ' + url.pathname);
    };

    const { setupSmokeTest } = await import('./setup.mjs');

    await assert.rejects(
      () => setupSmokeTest(),
      /managed_domain_not_found/,
    );

    const interrupted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(claims, 1, 'First attempt must claim only Side A.');
    assert.ok(interrupted.sides.a.id);
    assert.equal(interrupted.sides.b, undefined);
    assert.equal(interrupted.sides.a.mailboxEmail, undefined);

    await setupSmokeTest();

    const completed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(completed.runId, interrupted.runId, 'Must keep the interrupted run ID.');
    assert.equal(completed.sides.a.id, interrupted.sides.a.id, 'Must not create another Side A Work.');
    assert.equal(claims, 2, 'Exactly one Work per side must be claimed across both attempts.');
    assert.equal(attempts, 3, 'Retry only the previously failed mailbox and provision Side B.');
    assert.ok(completed.sides.a.mailboxEmail);
    assert.ok(completed.sides.b.mailboxEmail);

    // A forged state must never cause a Work claim or mailbox creation.
    const forged = structuredClone(completed);
    forged.sides.a.id = 'wrong-work-id';
    await writeFile(file, JSON.stringify(forged), { mode: 0o600 });

    await assert.rejects(() => setupSmokeTest(), /no longer matches Agent Address/);
    assert.equal(claims, 2);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;

    for (const name of envNames) {
      if (previousEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousEnv[name];
      }
    }

    await rm(dir, { recursive: true, force: true });
  }
});
