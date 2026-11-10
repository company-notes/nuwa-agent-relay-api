#!/usr/bin/env node
// Generate a temporary Wrangler config from GitHub Actions variables.
// Never commit account-specific resource IDs or secrets.
import { readFile, writeFile } from 'node:fs/promises';

class DeploymentConfiguration {
  static d1UUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  static required(name) {
    const value = (process.env[name] || '').trim();

    if (!value) {
      throw new Error(name + ' must be configured');
    }

    return value;
  }

  static optional(name) {
    return (process.env[name] || '').trim();
  }

  static async build() {
    const databaseId = this.required('CLOUDFLARE_D1_DATABASE_ID');

    if (!this.d1UUIDPattern.test(databaseId)) {
      throw new Error('CLOUDFLARE_D1_DATABASE_ID must be an actual D1 UUID');
    }

    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));

    const db = config.d1_databases.find((database) => database.binding === 'DB');

    if (!db) {
      throw new Error('DB D1 binding is missing from Wrangler configuration');
    }

    db.database_id = databaseId;
    db.database_name = this.optional('CLOUDFLARE_D1_DATABASE_NAME') || db.database_name;

    const managedDomain = this.required('MAILTRIGGER_MANAGED_DOMAIN');

    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(managedDomain)) {
      throw new Error('MAILTRIGGER_MANAGED_DOMAIN must be a verified email domain');
    }

    config.vars.MAILTRIGGER_MANAGED_DOMAIN = managedDomain;

    config.vars.MAILTRIGGER_API_URL = this.optional('MAILTRIGGER_API_URL') || config.vars.MAILTRIGGER_API_URL;
    // Optional, explicit public callback URL for the *Relay* Worker. Never
    // infer it from MAILTRIGGER_API_URL (which is the *MailTrigger* server).
    const receiptURL = this.optional('MAILTRIGGER_RECEIPT_URL');

    if (receiptURL) {
      let parsed;

      try {
        parsed = new URL(receiptURL);
      } catch {
        throw new Error('MAILTRIGGER_RECEIPT_URL must be a valid public HTTPS URL');
      }

      if (parsed.protocol !== 'https:' || parsed.pathname !== '/v1/mailtrigger/receipt' ||
        parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error('MAILTRIGGER_RECEIPT_URL must be a clean HTTPS Relay receipt URL');
      }

      config.vars.MAILTRIGGER_RECEIPT_URL = parsed.toString();
    }

    const domain = this.optional('CLOUDFLARE_CUSTOM_DOMAIN') || 'agent-relay.company-notes.com';

    if (domain !== 'agent-relay.company-notes.com') {
      throw new Error('Production Custom Domain must be agent-relay.company-notes.com');
    }

    config.routes = [{ pattern: domain, custom_domain: true }];

    await writeFile('.wrangler.deploy.jsonc', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log('Prepared Nuwa Agent Relay API deployment for ' + domain);
  }
}

await DeploymentConfiguration.build();
