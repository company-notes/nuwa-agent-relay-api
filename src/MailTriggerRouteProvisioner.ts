import { APIError } from './HTTP';
import type { ManagedMailbox } from './MailTriggerClient';

type Resource = Record<string, unknown>;
type ResourceID = string | number;

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
 * Configures sender-scoped delivery using the provider's built-in SMTP action.
 * A default SMTP-to-Origin route is not suitable for a managed-only domain.
 */
export class MailTriggerRouteProvisioner {
  constructor(private readonly resources: MailTriggerResources) {}

  private static id(value: unknown): string | null {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }

    if (value && typeof value === 'object' && 'id' in value) {
      return MailTriggerRouteProvisioner.id((value as { id: unknown }).id);
    }

    return null;
  }

  private static links(values: unknown, id: ResourceID): boolean {
    return Array.isArray(values) &&
      values.some((value: unknown) => MailTriggerRouteProvisioner.id(value) === String(id));
  }

  private static requiredID(row: Resource, kind: string): ResourceID {
    const id = MailTriggerRouteProvisioner.id(row.id);

    if (id === null) {
      throw new APIError(502, 'mailtrigger_route_invalid', `Missing managed ${kind} ID.`);
    }

    return id;
  }

  private async named(
    kind: 'rules' | 'actions' | 'routes',
    name: string,
    code: string,
  ): Promise<Resource | null> {
    const rows = await this.resources.list(`/api/v1/${kind}/?page_size=1000`, code);
    const matched = rows.filter((row) => row.name === name);

    if (matched.length > 1) {
      throw new APIError(502, code, `Duplicate managed ${kind} named ${name}.`);
    }

    return matched[0] ?? null;
  }

  private async ensureNamed(
    kind: 'rules' | 'actions',
    name: string,
    body: Resource,
  ): Promise<Resource> {
    const previous = await this.named(kind, name, `mailtrigger_${kind}_lookup_failed`);

    if (previous) {
      return previous;
    }

    return this.resources.write(
      'POST', `/api/v1/${kind}/`, { name, ...body }, `mailtrigger_${kind}_failed`,
    );
  }

  private async senderRule(mailbox: ManagedMailbox): Promise<ResourceID> {
    const rule = await this.ensureNamed('rules', `NAR sender ${mailbox.mailboxId}`, {
      target: 'sender',
      ruleType: 'equals',
      value: mailbox.mailboxEmail,
    });

    if (rule.target !== 'sender' || rule.ruleType !== 'equals' ||
      rule.value !== mailbox.mailboxEmail) {
      throw new APIError(502, 'mailtrigger_rule_mismatch',
        'The managed sender rule does not match this mailbox.');
    }

    return MailTriggerRouteProvisioner.requiredID(rule, 'rule');
  }

  private async smtpAction(mailbox: ManagedMailbox): Promise<ResourceID> {
    const action = await this.ensureNamed('actions', `NAR SMTP ${mailbox.mailboxId}`, {
      actionType: 'mailtrigger_smtp',
      parameters: { timeout: 30 },
    });

    if (action.actionType !== 'mailtrigger_smtp') {
      throw new APIError(502, 'mailtrigger_action_mismatch',
        'The managed action is not a built-in MailTrigger SMTP action.');
    }

    return MailTriggerRouteProvisioner.requiredID(action, 'action');
  }

  private static validateLinks(
    route: Resource,
    mailbox: ManagedMailbox,
    ruleID: ResourceID,
    actionID: ResourceID,
  ): void {
    if (MailTriggerRouteProvisioner.id(route.mailbox) !== mailbox.mailboxId ||
      !MailTriggerRouteProvisioner.links(route.rules, ruleID) ||
      !MailTriggerRouteProvisioner.links(route.actions, actionID) ||
      route.mailFilterOption !== 'all' ||
      route.executionMechanism !== 'sequential') {
      throw new APIError(502, 'mailtrigger_route_mismatch',
        'The managed route does not link this mailbox, sender rule, and SMTP action.');
    }
  }

  async ensureForMailbox(mailbox: ManagedMailbox): Promise<void> {
    const ruleID = await this.senderRule(mailbox);
    const actionID = await this.smtpAction(mailbox);
    const name = `NAR route ${mailbox.mailboxId}`;

    const existing = await this.named('routes', name, 'mailtrigger_route_lookup_failed');

    if (!existing) {
      await this.resources.write('POST', '/api/v1/routes/', {
        name,
        mailbox: mailbox.mailboxId,
        rules: [ruleID],
        actions: [actionID],
        mailFilterOption: 'all',
        executionMechanism: 'sequential',
        passToNextRoute: true,
        isEnabled: true,
      }, 'mailtrigger_route_failed');
    } else {
      MailTriggerRouteProvisioner.validateLinks(existing, mailbox, ruleID, actionID);

      if (existing.isEnabled !== true) {
        const id = MailTriggerRouteProvisioner.requiredID(existing, 'route');

        await this.resources.write(
          'PATCH',
          `/api/v1/routes/${encodeURIComponent(id)}/`,
          { isEnabled: true },
          'mailtrigger_route_failed',
        );
      }
    }

    // An accepted write is not proof of a usable route. Read it back.
    const verified = await this.named('routes', name, 'mailtrigger_route_lookup_failed');

    if (!verified) {
      throw new APIError(502, 'mailtrigger_route_unavailable',
        'The managed SMTP route cannot be found after provisioning.');
    }

    MailTriggerRouteProvisioner.validateLinks(verified, mailbox, ruleID, actionID);

    if (verified.isEnabled !== true) {
      throw new APIError(502, 'mailtrigger_route_unavailable',
        'The managed SMTP route is not enabled.');
    }
  }
}
