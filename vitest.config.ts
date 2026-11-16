import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        // Keep Worker tests independent of the operator's production .dev.vars.
        wrangler: { configPath: './test/wrangler.jsonc' },
        miniflare: {
          compatibilityDate: '2026-08-01',
          serviceBindings: {
            ADDRESS_WORKER: async () => {
              throw new Error('Agent Address test transport must be supplied explicitly.');
            },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            MAILTRIGGER_API_TOKEN: 'test-mailtrigger-token',
            MAILTRIGGER_MANAGED_DOMAIN: 'relay-test.example',
            ALIAS_VERIFICATION_KEY: 'test-alias-verification-key',
            MAILTRIGGER_INBOUND_KEY: 'test-inbound-key',
            WAKE_CREDENTIALS_KEY: 'a'.repeat(64),
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/Setup.ts'],
    },
  };
});
