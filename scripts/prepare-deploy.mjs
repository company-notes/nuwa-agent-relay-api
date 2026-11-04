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

    // MailTrigger publishes integer enum ranges but not their meanings.
    // Require an explicitly verified account-level routing profile.
    const profileText = this.required('MAILTRIGGER_ROUTE_PROFILE');
    let profile;

    try {
      profile = JSON.parse(profileText);
    } catch {
      throw new Error('MAILTRIGGER_ROUTE_PROFILE must be valid JSON');
    }

    const bounds = {
      senderTarget: 7,
      equalsRuleType: 6,
      filterOption: 3,
      ruleGroupId: Number.MAX_SAFE_INTEGER,
      smtpActionTemplateId: Number.MAX_SAFE_INTEGER,
    };

    for (const [key, upper] of Object.entries(bounds)) {
      if (!Number.isSafeInteger(profile?.[key]) || profile[key] < 1 ||
        profile[key] > upper) {
        throw new Error('MAILTRIGGER_ROUTE_PROFILE.' + key + ' must be a valid integer');
      }
    }

    config.vars.MAILTRIGGER_ROUTE_PROFILE = JSON.stringify(profile);
    config.vars.MAILTRIGGER_API_URL = this.optional('MAILTRIGGER_API_URL') || config.vars.MAILTRIGGER_API_URL;
    config.vars.WAKE_ALLOWED_HOSTS = this.optional('WAKE_ALLOWED_HOSTS');

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
