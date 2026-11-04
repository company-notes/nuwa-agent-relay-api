import { APIError } from './HTTP';
import type { ManagedMailbox } from './MailTriggerClient';

type Resource = Record<string, unknown>;

type RouteProfile = {
  senderTarget: number;
  equalsRuleType: number;
  filterOption: number;
  ruleGroupId: number;
  smtpActionTemplateId: number;
};

export type MailTriggerResources = {
  list(path: string, code: string): Promise<Resource[]>;
  write(
    method: 'POST' | 'PATCH',
    path: string,
    body: Resource,
    code: string,
  ): Promise<Resource>;
};

/**
 * Route and serializer fields follow the MailTrigger Swagger 2.0 contract.
 *
 * The Swagger lists numeric rule/filter choices but not their semantic labels,
 * and exposes no API to create a Route ruleGroup. Those five account-level
 * values therefore require an explicitly validated routing profile.
 */
export class MailTriggerRouteProvisioner {
  constructor(
    private readonly resources: MailTriggerResources,
    private readonly profileJSON?: string,
  ) {}

  private static positiveId(value: unknown): number {
    const id = typeof value === 'object' && value && 'id' in value
      ? (value as { id: unknown }).id
      : value;
    const normalized = typeof id === 'string' && /^\d+$/.test(id)
      ? Number(id)
      : id;

    if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new APIError(502, 'mailtrigger_resource_invalid', 'MailTrigger returned an invalid resource ID.');
    }

    return normalized;
  }

  private static profile(raw?: string): RouteProfile {
    let parsed: unknown;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new APIError(503, 'mailtrigger_route_profile_invalid',
        'MAILTRIGGER_ROUTE_PROFILE must contain valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new APIError(503, 'mailtrigger_route_profile_required',
        'Configure one account-level MailTrigger routing profile before provisioning Hosts.');
    }

    const config = parsed as Record<string, unknown>;
    const limits = {
      senderTarget: 7,
      equalsRuleType: 6,
      filterOption: 3,
      ruleGroupId: Number.MAX_SAFE_INTEGER,
      smtpActionTemplateId: Number.MAX_SAFE_INTEGER,
    } as const;

    for (const [key, upper] of Object.entries(limits)) {
      const value = config[key];

      if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < 1 || value > upper) {
        throw new APIError(503, 'mailtrigger_route_profile_invalid',
          `MAILTRIGGER_ROUTE_PROFILE.${key} must be a valid provider integer ID or enum.`);
      }
    }

    return config as RouteProfile;
  }

  private async named(
    kind: 'rules' | 'actions' | 'routes',
    field: 'note' | 'name',
    name: string,
  ): Promise<Resource | null> {
    const code = `mailtrigger_${kind}_lookup_failed`;
    const rows = await this.resources.list(`/api/v1/${kind}/?page_size=1000`, code);
    const matches = rows.filter((row) => row[field] === name);

    if (matches.length > 1) {
      throw new APIError(502, code, `Duplicate managed ${kind} named ${name}.`);
    }

    return matches[0] ?? null;
  }

  private async ensureSenderRule(
    mailbox: ManagedMailbox,
    ownerId: number,
    config: RouteProfile,
  ): Promise<number> {
    const note = `NAR sender ${mailbox.mailboxId}`;
    let rule = await this.named('rules', 'note', note);

    if (!rule) {
      rule = await this.resources.write('POST', '/api/v1/rules/', {
        note,
        user: ownerId,
        target: config.senderTarget,
        ruleType: config.equalsRuleType,
        value: mailbox.mailboxEmail,
      }, 'mailtrigger_rule_failed');
    }

    if (rule.note !== note || rule.user !== ownerId ||
      rule.target !== config.senderTarget || rule.ruleType !== config.equalsRuleType ||
      rule.value !== mailbox.mailboxEmail) {
      throw new APIError(502, 'mailtrigger_rule_mismatch',
        'The managed Rule does not match the sender mailbox and configured enum values.');
    }

    return MailTriggerRouteProvisioner.positiveId(rule.id);
  }

  private async confirmSMTPTemplate(config: RouteProfile): Promise<void> {
    const rows = await this.resources.list(
      '/api/v1/action-templates/?page_size=1000',
      'mailtrigger_action_template_lookup_failed',
    );
    const template = rows.find((row) => row.id === config.smtpActionTemplateId);
    const label = String(template?.displayName ?? '') + ' ' + String(template?.actionName ?? '');

    if (!template || !/mail\s*trigger[\s_-]*smtp/i.test(label) || template.isActive === false) {
      throw new APIError(503, 'mailtrigger_smtp_template_invalid',
        'The configured action template must identify an active MailTrigger SMTP action.');
    }
  }

  private async ensureSMTPAction(
    mailbox: ManagedMailbox,
    ownerId: number,
    config: RouteProfile,
  ): Promise<number> {
    const name = `NAR SMTP ${mailbox.mailboxId}`;
    let action = await this.named('actions', 'name', name);

    if (!action) {
      action = await this.resources.write('POST', '/api/v1/actions/', {
        name,
        user: ownerId,
        action: config.smtpActionTemplateId,
        attachResult: false,
      }, 'mailtrigger_action_failed');
    }

    if (action.name !== name || action.user !== ownerId ||
      action.action !== config.smtpActionTemplateId) {
      throw new APIError(502, 'mailtrigger_action_mismatch',
        'The managed Action does not reference the configured SMTP template.');
    }

    return MailTriggerRouteProvisioner.positiveId(action.id);
  }

  private static includesID(values: unknown, expected: number): boolean {
    return Array.isArray(values) &&
      values.some((value: unknown) => {
        try {
          return MailTriggerRouteProvisioner.positiveId(value) === expected;
        } catch {
          return false;
        }
      });
  }

  private static validateRoute(
    route: Resource,
    mailboxId: number,
    ruleId: number,
    actionId: number,
    config: RouteProfile,
  ): void {
    if (MailTriggerRouteProvisioner.positiveId(route.mailbox) !== mailboxId ||
      MailTriggerRouteProvisioner.positiveId(route.ruleGroup) !== config.ruleGroupId ||
      route.filterOption !== config.filterOption ||
      !MailTriggerRouteProvisioner.includesID(route.ruleConfigs, ruleId) ||
      !MailTriggerRouteProvisioner.includesID(route.actions, actionId)) {
      throw new APIError(502, 'mailtrigger_route_mismatch',
        'The managed Route does not link its mailbox, Rule, Action, and rule group.');
    }
  }

  async ensureForMailbox(mailbox: ManagedMailbox, ownerId: number): Promise<void> {
    const config = MailTriggerRouteProvisioner.profile(this.profileJSON);
    const mailboxId = MailTriggerRouteProvisioner.positiveId(mailbox.mailboxId);

    await this.confirmSMTPTemplate(config);

    const ruleId = await this.ensureSenderRule(mailbox, ownerId, config);
    const actionId = await this.ensureSMTPAction(mailbox, ownerId, config);
    const name = `NAR route ${mailbox.mailboxId}`;

    const existing = await this.named('routes', 'name', name);

    if (!existing) {
      await this.resources.write('POST', '/api/v1/routes/', {
        name,
        mailbox: mailboxId,
        ruleGroup: config.ruleGroupId,
        ruleConfigs: [ruleId],
        actions: [actionId],
        filterOption: config.filterOption,
        isActive: true,
      }, 'mailtrigger_route_failed');
    } else {
      MailTriggerRouteProvisioner.validateRoute(existing, mailboxId, ruleId, actionId, config);

      if (existing.isActive !== true) {
        await this.resources.write(
          'PATCH',
          `/api/v1/routes/${MailTriggerRouteProvisioner.positiveId(existing.id)}/`,
          { isActive: true },
          'mailtrigger_route_failed',
        );
      }
    }

    // Do not report readiness merely because the provider accepted a write.
    const verified = await this.named('routes', 'name', name);

    if (!verified) {
      throw new APIError(502, 'mailtrigger_route_unavailable',
        'MailTrigger did not return the managed Route after provisioning.');
    }

    MailTriggerRouteProvisioner.validateRoute(verified, mailboxId, ruleId, actionId, config);

    if (verified.isActive !== true) {
      throw new APIError(502, 'mailtrigger_route_unavailable',
        'The managed SMTP Route is inactive.');
    }
  }
}
