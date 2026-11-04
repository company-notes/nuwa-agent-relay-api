import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectConfig = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const deploymentScript = fileURLToPath(new URL('./prepare-deploy.mjs', import.meta.url));

test('production deployment ignores stale MailTrigger Tunnel override', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nuwa-deploy-test-'));

  try {
    await writeFile(join(cwd, 'wrangler.jsonc'), await readFile(projectConfig));

    const result = spawnSync(process.execPath, [deploymentScript], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLOUDFLARE_D1_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
        MAILTRIGGER_MANAGED_DOMAIN: 'example.org',
        MAILTRIGGER_API_URL: 'https://stale-tunnel.trycloudflare.com',
        CLOUDFLARE_CUSTOM_DOMAIN: 'agent-relay.company-notes.com',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const generated = JSON.parse(
      await readFile(join(cwd, '.wrangler.deploy.jsonc'), 'utf8'),
    );

    assert.equal(generated.vars.MAILTRIGGER_API_URL, 'https://app.mailtrigger.app');
    assert.equal(generated.vars.MAILTRIGGER_MANAGED_DOMAIN, 'example.org');
    assert.equal(generated.d1_databases[0].database_id,
      '11111111-2222-3333-4444-555555555555');
    assert.deepEqual(generated.routes,
      [{ pattern: 'agent-relay.company-notes.com', custom_domain: true }]);
    assert.ok(!result.stdout.includes('stale-tunnel.trycloudflare.com'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
