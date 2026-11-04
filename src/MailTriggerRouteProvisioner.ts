import { APIError } from './HTTP';
import type { ManagedMailbox } from './MailTriggerClient';

type Resource = Record<string, unknown>;

export type MailTriggerResources = {
  list(path: string, code: string): Promise<Resource[]>;
  delete(kind: 'rules' | 'actions' | 'routes', id: number): Promise<void>;
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
 * Source-confirmed constants: sender target 1, regex rule type 1 and
 * match-all-rules filter 1. The provider creates/overrides Rule Groups.
 * The RelaySMTP action-template ID is discovered in each environment.
 */
export class MailTriggerRouteProvisioner {
  constructor(private readonly resources: MailTriggerResources) {}

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

  private static senderRegex(value: string): string {
    return '^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  }

  private async named(
    kind: 'rules' | 'actions' | 'routes',
    field: 'note' | 'name',
    name: string,
  ): Promise<Resource | null> {
    const code = `mailtrigger_${kind === 'routes' ? 'route' : kind}_lookup_failed`;
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
  ): Promise<number> {
    const note = `NAR sender ${mailbox.mailboxId}`;
    const pattern = MailTriggerRouteProvisioner.senderRegex(mailbox.mailboxEmail);
    let rule = await this.named('rules', 'note', note);

    if (!rule) {
      rule = await this.resources.write('POST', '/api/v1/rules/', {
        note,
        user: ownerId,
        target: 1,
        ruleType: 1,
        value: pattern,
      }, 'mailtrigger_rule_failed');
    }

    if (rule.note !== note || rule.user !== ownerId ||
      rule.target !== 1 || rule.ruleType !== 1 ||
      rule.value !== pattern) {
      throw new APIError(502, 'mailtrigger_rule_mismatch',
        'The managed Rule does not match the sender mailbox and configured enum values.');
    }

    return MailTriggerRouteProvisioner.positiveId(rule.id);
  }

  private async relaySMTPTemplate(): Promise<number> {
    const rows = await this.resources.list(
      '/api/v1/action-templates/?page_size=1000',
      'mailtrigger_action_template_lookup_failed',
    );
    const templates = rows.filter((row) => row.actionName === 'RelaySMTP' &&
      row.isActive === true);

    if (templates.length !== 1) {
      throw new APIError(503, 'mailtrigger_smtp_template_invalid',
        'Expected exactly one active RelaySMTP action template in MailTrigger.');
    }

    return MailTriggerRouteProvisioner.positiveId(templates[0].id);
  }

  private async ensureSMTPAction(
    mailbox: ManagedMailbox,
    ownerId: number,
    templateId: number,
  ): Promise<number> {
    const name = `NAR SMTP ${mailbox.mailboxId}`;
    let action = await this.named('actions', 'name', name);

    if (!action) {
      action = await this.resources.write('POST', '/api/v1/actions/', {
        name,
        user: ownerId,
        action: templateId,
        attachResult: false,
      }, 'mailtrigger_action_failed');
    }

    if (action.name !== name || action.user !== ownerId ||
      action.action !== templateId) {
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
  ): void {
    if (MailTriggerRouteProvisioner.positiveId(route.mailbox) !== mailboxId ||
      route.filterOption !== 1 ||
      !MailTriggerRouteProvisioner.includesID(route.ruleConfigs, ruleId) ||
      !MailTriggerRouteProvisioner.includesID(route.actions, actionId)) {
      throw new APIError(502, 'mailtrigger_route_mismatch',
        'The managed Route does not link its mailbox, Rule, Action, and rule group.');
    }
  }

  /**
   * Delete only resources with deterministic NAR names and exact ownership.
   * The provider's internal mailbox user is deliberately not deleted: the
   * public API does not expose a safe ownership-checked user deletion method.
   */
  async cleanupForMailbox(mailbox: ManagedMailbox, ownerId: number): Promise<void> {
    const mailboxId = MailTriggerRouteProvisioner.positiveId(mailbox.mailboxId);
    const rule = await this.named('rules', 'note', 'NAR sender ' + mailbox.mailboxId);
    const action = await this.named('actions', 'name', 'NAR SMTP ' + mailbox.mailboxId);
    const route = await this.named('routes', 'name', 'NAR route ' + mailbox.mailboxId);

    if (!rule && !action && !route) {
      return;
    }

    const templateId = await this.relaySMTPTemplate();
    const pattern = MailTriggerRouteProvisioner.senderRegex(mailbox.mailboxEmail);

    if (rule && (rule.user !== ownerId || rule.target !== 1 ||
      rule.ruleType !== 1 || rule.value !== pattern)) {
      throw new APIError(409, 'mailtrigger_cleanup_rule_mismatch',
        'Refusing to remove a managed Rule with unexpected ownership or pattern.');
    }

    if (action && (action.user !== ownerId || action.action !== templateId)) {
      throw new APIError(409, 'mailtrigger_cleanup_action_mismatch',
        'Refusing to remove a managed Action that does not belong to this Host.');
    }

    const ruleId = rule ? MailTriggerRouteProvisioner.positiveId(rule.id) : null;
    const actionId = action ? MailTriggerRouteProvisioner.positiveId(action.id) : null;

    if (route) {
      if (ruleId === null || actionId === null) {
        throw new APIError(409, 'mailtrigger_cleanup_route_mismatch',
          'The managed Route references resources that cannot be verified.');
      }

      MailTriggerRouteProvisioner.validateRoute(route, mailboxId, ruleId, actionId);
    }

    // Rule/Action configs must not be removed while some other Route uses them.
    const allRoutes = await this.resources.list(
      '/api/v1/routes/?page_size=1000', 'mailtrigger_route_lookup_failed',
    );

    if (allRoutes.length >= 1000) {
      throw new APIError(502, 'mailtrigger_cleanup_incomplete',
        'The Route list may be truncated; refusing an unsafe cleanup.');
    }

    for (const candidate of allRoutes) {
      if (route && MailTriggerRouteProvisioner.positiveId(candidate.id) ===
        MailTriggerRouteProvisioner.positiveId(route.id)) {
        continue;
      }

      if ((ruleId !== null && MailTriggerRouteProvisioner.includesID(candidate.ruleConfigs, ruleId)) ||
        (actionId !== null && MailTriggerRouteProvisioner.includesID(candidate.actions, actionId))) {
        throw new APIError(409, 'mailtrigger_cleanup_shared_resource',
          'Another Route references the managed Rule or Action.');
      }
    }

    if (route) {
      await this.resources.delete('routes', MailTriggerRouteProvisioner.positiveId(route.id));
    }

    if (action) {
      await this.resources.delete('actions', actionId!);
    }

    if (rule) {
      await this.resources.delete('rules', ruleId!);
    }

    const remaining = await Promise.all([
      this.named('routes', 'name', 'NAR route ' + mailbox.mailboxId),
      this.named('actions', 'name', 'NAR SMTP ' + mailbox.mailboxId),
      this.named('rules', 'note', 'NAR sender ' + mailbox.mailboxId),
    ]);

    if (remaining.some((row) => row !== null)) {
      throw new APIError(502, 'mailtrigger_cleanup_incomplete',
        'Managed routing resources remain after deletion.');
    }
  }

  async ensureForMailbox(mailbox: ManagedMailbox, ownerId: number): Promise<void> {
    const mailboxId = MailTriggerRouteProvisioner.positiveId(mailbox.mailboxId);
    const templateId = await this.relaySMTPTemplate();
    const ruleId = await this.ensureSenderRule(mailbox, ownerId);
    const actionId = await this.ensureSMTPAction(mailbox, ownerId, templateId);
    const name = `NAR route ${mailbox.mailboxId}`;

    const existing = await this.named('routes', 'name', name);

    if (!existing) {
      await this.resources.write('POST', '/api/v1/routes/', {
        name,
        mailbox: mailboxId,
        ruleConfigs: [ruleId],
        actions: [actionId],
        filterOption: 1,
        isActive: true,
      }, 'mailtrigger_route_failed');
    } else {
      MailTriggerRouteProvisioner.validateRoute(existing, mailboxId, ruleId, actionId);

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

    MailTriggerRouteProvisioner.validateRoute(verified, mailboxId, ruleId, actionId);

    if (verified.isActive !== true) {
      throw new APIError(502, 'mailtrigger_route_unavailable',
        'The managed SMTP Route is inactive.');
    }
  }
}
