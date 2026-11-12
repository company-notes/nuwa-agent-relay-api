#!/usr/bin/env node
// Use the original GitHub Actions deployment configuration, but resolve the D1
// resource by its exact canonical Cloudflare name after a clean schema cutover.
import { appendFile } from 'node:fs/promises';

class RelayDatabaseResolver {
  static async resolve() {
    const accountID = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
    const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
    const configuredName = (process.env.CLOUDFLARE_D1_DATABASE_NAME || '').trim();
    const envFile = process.env.GITHUB_ENV;

    if (!accountID || !apiToken || !envFile) {
      throw new Error('Cloudflare credentials or GITHUB_ENV missing.');
    }

    if (configuredName && configuredName !== 'nuwa-agent-relay-api') {
      throw new Error('Unexpected configured Relay D1 database name.');
    }

    const url = 'https://api.cloudflare.com/client/v4/accounts/' +
      encodeURIComponent(accountID) + '/d1/database?per_page=1000&page=1&name=nuwa-agent-relay-api';
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + apiToken, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error('Cloudflare D1 lookup failed: HTTP ' + response.status);
    }

    const payload = await response.json();

    if (payload?.success !== true || !Array.isArray(payload.result) ||
        (payload.result_info?.total_count ?? payload.result.length) > payload.result.length) {
      throw new Error('Cloudflare D1 lookup returned incomplete or paginated results.');
    }

    const matches = payload.result.filter((item) =>
      item?.name === 'nuwa-agent-relay-api' &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(item.uuid ?? ''),
    );

    if (matches.length !== 1) {
      throw new Error('Expected exactly one canonical nuwa-agent-relay-api D1 database.');
    }

    await appendFile(envFile, [
      'CLOUDFLARE_D1_DATABASE_ID=' + matches[0].uuid,
      'CLOUDFLARE_D1_DATABASE_NAME=nuwa-agent-relay-api',
      '',
    ].join('\n'));

    console.log('Verified canonical Relay D1 by exact Cloudflare name.');
  }
}

await RelayDatabaseResolver.resolve();
