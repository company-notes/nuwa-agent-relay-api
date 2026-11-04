import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          compatibilityDate: '2026-08-01',
          bindings: {
            TEST_MIGRATIONS: migrations,
            MAILTRIGGER_API_TOKEN: 'test-mailtrigger-token',
            MAILTRIGGER_MANAGED_DOMAIN: 'relay-test.example',
            ALIAS_VERIFICATION_KEY: 'test-alias-verification-key',
            MAILTRIGGER_INBOUND_KEY: 'test-inbound-key',
            WAKE_ALLOWED_HOSTS: 'agent-hook.example.com',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/Setup.ts'],
    },
  };
});
