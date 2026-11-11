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
  constructor(
    private readonly resources: MailTriggerResources,
    private readonly receipt?: { url: string; key: string },
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

  private async ensureRecipientRule(
    mailbox: ManagedMailbox, ownerId: number,
  ): Promise<number> {
    const note = `NAR recipient ${mailbox.mailboxId}`;
    const pattern = MailTriggerRouteProvisioner.senderRegex(mailbox.mailboxEmail);
    let rule = await this.named('rules', 'note', note);

    if (!rule) {
      // MailTrigger target 2 is the recipient address. This is deliberately
      // NOT an All Emails route: outgoing mail from the same mailbox must
      // never generate a false recipient-side delivery receipt.
      rule = await this.resources.write('POST', '/api/v1/rules/', {
        note,
        user: ownerId,
        target: 2,
        ruleType: 1,
        value: pattern,
      }, 'mailtrigger_recipient_rule_failed');
    }

    if (rule.note !== note || rule.user !== ownerId ||
      rule.target !== 2 || rule.ruleType !== 1 ||
      rule.value !== pattern) {
      throw new APIError(409, 'mailtrigger_recipient_rule_mismatch',
        'The recipient Rule must match exactly the receiving mailbox email.');
    }

    return MailTriggerRouteProvisioner.positiveId(rule.id);
  }

  private async webhookTemplate(): Promise<number> {
    const templates = await this.resources.list(
      '/api/v1/action-templates/?page_size=1000',
      'mailtrigger_action_template_lookup_failed',
    );
    // Do not assume an environment-specific template numeric ID.
    const matched = templates.filter((row) => row.isActive === true &&
      (row.displayName === 'Webhook (API)' ||
        row.actionName === 'WebhookAPI' || row.actionName === 'Webhook'));

    if (matched.length !== 1) {
      throw new APIError(503, 'mailtrigger_webhook_template_invalid',
        'Expected exactly one active Webhook (API) Action template.');
    }

    return MailTriggerRouteProvisioner.positiveId(matched[0].id);
  }

  private static receiptWebhookURL(value: string): string {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new APIError(503, 'mailtrigger_receipt_url_invalid',
        'MAILTRIGGER_RECEIPT_URL must be a full public HTTPS receipt endpoint.');
    }

    if (url.protocol !== 'https:' || url.pathname !== '/v1/mailtrigger/receipt' ||
      url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443')) {
      throw new APIError(503, 'mailtrigger_receipt_url_invalid',
        'MAILTRIGGER_RECEIPT_URL must be an HTTPS URL ending in /v1/mailtrigger/receipt.');
    }

    return url.toString();
  }

  private async actionParameters(actionId: number): Promise<Resource[]> {
    return this.resources.list(
      `/api/v1/actions/${actionId}/parameters/`,
      'mailtrigger_webhook_parameters_failed',
    );
  }

  private static parameterName(row: Resource): string | null {
    if (typeof row.name === 'string') {
      return row.name;
    }
    if (typeof row.parameterName === 'string') {
      return row.parameterName;
    }
    if (typeof row.fieldName === 'string') {
      return row.fieldName;
    }
    if (row.field && typeof row.field === 'object' && !Array.isArray(row.field) &&
      'name' in row.field && typeof row.field.name === 'string') {
      return row.field.name;
    }
    return null;
  }

  private async ensureWebhookParameters(actionId: number, url: string, key: string): Promise<void> {
    // These parameter names and MailTrigger inline substitutions are documented.
    // Actual instance serializers are checked by reading values back.
    const desired: Record<string, string> = {
      method: 'POST',
      webhook_url: url,
      headers: JSON.stringify({
        'Content-Type': 'application/json',
        'X-Relay-Inbound-Key': key,
      }),
      data: JSON.stringify({
        from: '$SENDER',
        receiver: '$RECEIVERS',
        subject: '$SUBJECT',
      }),
    };

    const rows = await this.actionParameters(actionId);

    for (const [name, value] of Object.entries(desired)) {
      const matches = rows.filter((row) => MailTriggerRouteProvisioner.parameterName(row) === name);

      if (matches.length !== 1) {
        throw new APIError(502, 'mailtrigger_webhook_parameters_invalid',
          'Webhook Action must expose one configurable parameter for each required field.');
      }

      const parameter = matches[0];

      if (parameter.value !== value) {
        await this.resources.write(
          'PATCH',
          `/api/v1/actions/${actionId}/parameters/${MailTriggerRouteProvisioner.positiveId(parameter.id)}/`,
          { value },
          'mailtrigger_webhook_parameters_failed',
        );
      }
    }

    const verified = await this.actionParameters(actionId);

    for (const [name, value] of Object.entries(desired)) {
      const matches = verified.filter((row) =>
        MailTriggerRouteProvisioner.parameterName(row) === name);

      if (matches.length !== 1 || matches[0].value !== value) {
        throw new APIError(502, 'mailtrigger_webhook_parameters_invalid',
          'MailTrigger did not persist the expected Webhook Action settings.');
      }
    }
  }

  private static validateReceiptRoute(
    route: Resource, mailboxId: number, ruleId: number, actionId: number,
  ): void {
    MailTriggerRouteProvisioner.positiveId(route.ruleGroup);

    if (MailTriggerRouteProvisioner.positiveId(route.mailbox) !== mailboxId ||
      route.filterOption !== 1 ||
      !Array.isArray(route.ruleConfigs) || route.ruleConfigs.length !== 1 ||
      !MailTriggerRouteProvisioner.includesID(route.ruleConfigs, ruleId) ||
      !Array.isArray(route.actions) || route.actions.length !== 1 ||
      !MailTriggerRouteProvisioner.includesID(route.actions, actionId)) {
      throw new APIError(409, 'mailtrigger_receipt_route_mismatch',
        'Receipt Webhook Route must target exactly this mailbox and its own action.');
    }
  }

  private async ensureReceiptRoute(
    mailbox: ManagedMailbox, ownerId: number,
    senderRuleId: number, senderActionId: number, senderRouteId: number,
  ): Promise<void> {
    if (!this.receipt) {
      // Backward-compatible transport: enable Receipt Webhooks only after the
      // endpoint and inbound secret are explicitly configured for this Worker.
      return;
    }

    if (!this.receipt.key) {
      throw new APIError(503, 'mailtrigger_receipt_unconfigured',
        'MAILTRIGGER_INBOUND_KEY is required when MAILTRIGGER_RECEIPT_URL is set.');
    }

    const url = MailTriggerRouteProvisioner.receiptWebhookURL(this.receipt.url);
    const templateId = await this.webhookTemplate();
    const mailboxId = MailTriggerRouteProvisioner.positiveId(mailbox.mailboxId);
    const ruleId = await this.ensureRecipientRule(mailbox, ownerId);
    const actionName = `NAR receipt webhook ${mailbox.mailboxId}`;
    let action = await this.named('actions', 'name', actionName);

    if (!action) {
      action = await this.resources.write('POST', '/api/v1/actions/', {
        name: actionName,
        user: ownerId,
        action: templateId,
        attachResult: false,
      }, 'mailtrigger_receipt_action_failed');
    }

    if (action.name !== actionName || action.user !== ownerId || action.action !== templateId) {
      throw new APIError(409, 'mailtrigger_receipt_action_mismatch',
        'Receipt Webhook Action has unexpected ownership or template.');
    }

    const actionId = MailTriggerRouteProvisioner.positiveId(action.id);

    // Configured values must be verified BEFORE activating the incoming route.
    await this.ensureWebhookParameters(actionId, url, this.receipt.key);

    const routeName = `NAR receipt ${mailbox.mailboxId}`;
    const existing = await this.named('routes', 'name', routeName);

    if (!existing) {
      await this.resources.write('POST', '/api/v1/routes/', {
        name: routeName,
        mailbox: mailboxId,
        filterOption: 1,
        ruleConfigs: [ruleId],
        actions: [actionId],
        passToNextRouter: true,
        isActive: true,
      }, 'mailtrigger_receipt_route_failed');
    } else {
      MailTriggerRouteProvisioner.validateReceiptRoute(existing, mailboxId, ruleId, actionId);

      if (existing.isActive !== true) {
        await this.resources.write('PATCH',
          `/api/v1/routes/${MailTriggerRouteProvisioner.positiveId(existing.id)}/`,
          { isActive: true }, 'mailtrigger_receipt_route_failed');
      }
    }

    const verified = await this.named('routes', 'name', routeName);

    if (!verified) {
      throw new APIError(502, 'mailtrigger_receipt_route_missing',
        'MailTrigger did not return the recipient Webhook Route.');
    }

    MailTriggerRouteProvisioner.validateReceiptRoute(verified, mailboxId, ruleId, actionId);

    if (verified.isActive !== true) {
      throw new APIError(502, 'mailtrigger_receipt_route_inactive',
        'The recipient Webhook Route is inactive.');
    }

    // Retire the provider's inbound SMTP fallback only after the receipt
    // Webhook Route has been read back and verified active. Never do this
    // when receipt configuration is missing or parameter setup failed.
    await this.removeDefaultRelayToOrigin(
      mailboxId,
      [ruleId, senderRuleId],
      [actionId, senderActionId],
      [MailTriggerRouteProvisioner.positiveId(verified.id), senderRouteId],
    );
  }

  private static includesID(values: unknown, expected: number): boolean {
    if (!Array.isArray(values)) {
      return false;
    }

    // A malformed provider link is a consistency failure, not a missing
    // reference. Let positiveId reject it before any destructive cleanup.
    return values.some((value: unknown) =>
      MailTriggerRouteProvisioner.positiveId(value) === expected);
  }

  private static validateRoute(
    route: Resource,
    mailboxId: number,
    ruleId: number,
    actionId: number,
  ): void {
    // The provider determines the Rule Group. Verify it exists, not a fixed ID.
    MailTriggerRouteProvisioner.positiveId(route.ruleGroup);

    if (MailTriggerRouteProvisioner.positiveId(route.mailbox) !== mailboxId ||
      route.filterOption !== 1 ||
      !Array.isArray(route.ruleConfigs) || route.ruleConfigs.length !== 1 ||
      !MailTriggerRouteProvisioner.includesID(route.ruleConfigs, ruleId) ||
      !Array.isArray(route.actions) || route.actions.length !== 1 ||
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
    const receiptAction = await this.named('actions', 'name', 'NAR receipt webhook ' + mailbox.mailboxId);
    const receiptRoute = await this.named('routes', 'name', 'NAR receipt ' + mailbox.mailboxId);
    const receiptRule = await this.named('rules', 'note', 'NAR recipient ' + mailbox.mailboxId);

    if (!rule && !action && !route && !receiptAction && !receiptRoute && !receiptRule) {
      return;
    }

    const pattern = MailTriggerRouteProvisioner.senderRegex(mailbox.mailboxEmail);
    const templateId = action ? await this.relaySMTPTemplate() : null;
    const webhookTemplateId = receiptAction ? await this.webhookTemplate() : null;

    if (rule && (rule.user !== ownerId || rule.target !== 1 ||
      rule.ruleType !== 1 || rule.value !== pattern)) {
      throw new APIError(409, 'mailtrigger_cleanup_rule_mismatch',
        'Refusing to remove a managed Rule with unexpected ownership or pattern.');
    }

    if (receiptRule && (receiptRule.user !== ownerId || receiptRule.target !== 2 ||
      receiptRule.ruleType !== 1 || receiptRule.value !== pattern)) {
      throw new APIError(409, 'mailtrigger_cleanup_rule_mismatch',
        'Refusing to remove a Recipient Rule with unexpected ownership or pattern.');
    }

    if (action && (action.user !== ownerId || action.action !== templateId)) {
      throw new APIError(409, 'mailtrigger_cleanup_action_mismatch',
        'Refusing to remove a managed Action that does not belong to this Host.');
    }

    if (receiptAction && (receiptAction.user !== ownerId ||
      receiptAction.action !== webhookTemplateId)) {
      throw new APIError(409, 'mailtrigger_cleanup_action_mismatch',
        'Refusing to remove a Receipt Action with unexpected ownership or template.');
    }

    const ruleId = rule ? MailTriggerRouteProvisioner.positiveId(rule.id) : null;
    const receiptRuleId = receiptRule
      ? MailTriggerRouteProvisioner.positiveId(receiptRule.id) : null;
    const actionId = action ? MailTriggerRouteProvisioner.positiveId(action.id) : null;
    const receiptActionId = receiptAction
      ? MailTriggerRouteProvisioner.positiveId(receiptAction.id) : null;

    if (route) {
      if (ruleId === null || actionId === null) {
        throw new APIError(409, 'mailtrigger_cleanup_route_mismatch',
          'The managed Route references resources that cannot be verified.');
      }
      MailTriggerRouteProvisioner.validateRoute(route, mailboxId, ruleId, actionId);
    }

    if (receiptRoute) {
      if (receiptActionId === null || receiptRuleId === null) {
        throw new APIError(409, 'mailtrigger_cleanup_route_mismatch',
          'The Receipt Route references a Rule or Action that cannot be verified.');
      }
      MailTriggerRouteProvisioner.validateReceiptRoute(
        receiptRoute, mailboxId, receiptRuleId, receiptActionId,
      );
    }

    const allRoutes = await this.resources.list(
      '/api/v1/routes/?page_size=1000', 'mailtrigger_route_lookup_failed',
    );

    if (allRoutes.length >= 1000) {
      throw new APIError(502, 'mailtrigger_cleanup_incomplete',
        'The Route list may be truncated; refusing an unsafe cleanup.');
    }

    for (const candidate of allRoutes) {
      const candidateId = MailTriggerRouteProvisioner.positiveId(candidate.id);

      if ((route && candidateId === MailTriggerRouteProvisioner.positiveId(route.id)) ||
        (receiptRoute && candidateId === MailTriggerRouteProvisioner.positiveId(receiptRoute.id))) {
        continue;
      }

      if ((ruleId !== null && MailTriggerRouteProvisioner.includesID(candidate.ruleConfigs, ruleId)) ||
        (receiptRuleId !== null &&
          MailTriggerRouteProvisioner.includesID(candidate.ruleConfigs, receiptRuleId)) ||
        (actionId !== null && MailTriggerRouteProvisioner.includesID(candidate.actions, actionId)) ||
        (receiptActionId !== null &&
          MailTriggerRouteProvisioner.includesID(candidate.actions, receiptActionId))) {
        throw new APIError(409, 'mailtrigger_cleanup_shared_resource',
          'Another Route references a managed Rule or Action.');
      }
    }

    // Delete routes before their linked Actions and Rules. This order makes
    // failed/interrupted cleanup resumable on the next smoke-cleanup request.
    if (receiptRoute) {
      await this.resources.delete('routes',
        MailTriggerRouteProvisioner.positiveId(receiptRoute.id));
    }

    if (route) {
      await this.resources.delete('routes', MailTriggerRouteProvisioner.positiveId(route.id));
    }

    if (receiptActionId !== null) {
      await this.resources.delete('actions', receiptActionId);
    }

    if (actionId !== null) {
      await this.resources.delete('actions', actionId);
    }

    if (ruleId !== null) {
      await this.resources.delete('rules', ruleId);
    }

    if (receiptRuleId !== null) {
      await this.resources.delete('rules', receiptRuleId);
    }

    const remaining = await Promise.all([
      this.named('routes', 'name', 'NAR route ' + mailbox.mailboxId),
      this.named('actions', 'name', 'NAR SMTP ' + mailbox.mailboxId),
      this.named('rules', 'note', 'NAR sender ' + mailbox.mailboxId),
      this.named('routes', 'name', 'NAR receipt ' + mailbox.mailboxId),
      this.named('actions', 'name', 'NAR receipt webhook ' + mailbox.mailboxId),
      this.named('rules', 'note', 'NAR recipient ' + mailbox.mailboxId),
    ]);

    if (remaining.some((row) => row !== null)) {
      throw new APIError(502, 'mailtrigger_cleanup_incomplete',
        'Managed routing resources remain after deletion.');
    }
  }

  /**
   * The provider may create an external SMTP-to-Origin route alongside its
   * mailbox. It is unsuitable for a fully MailTrigger-managed domain.
   *
   * Delete only the exactly named provider default attached to THIS mailbox.
   * Never touch "Relay to Origin", user-named routes, or routes referencing
   * Nuwa's own Rule/Action. Fail closed on duplicates/truncated lists.
   */
  // MailTrigger currently uses "SMTP to Origin Router". Older provider
  // versions use "SMTP to Origin"; require one of these exact names.
  private static isDefaultSMTPToOriginName(value: unknown): boolean {
    return value === 'SMTP to Origin Router' || value === 'SMTP to Origin';
  }

  private async removeDefaultSMTPToOrigin(
    mailboxId: number,
    ruleId: number,
    actionId: number,
    managedRouteId: number,
  ): Promise<void> {
    const path = '/api/v1/routes/?page_size=1000';
    const code = 'mailtrigger_origin_route_lookup_failed';
    const rows = await this.resources.list(path, code);

    if (rows.length >= 1000) {
      throw new APIError(502, 'mailtrigger_origin_route_ambiguous',
        'MailTrigger route listing may be truncated; cannot safely remove an origin route.');
    }

    const matches = rows.filter((route) => MailTriggerRouteProvisioner.isDefaultSMTPToOriginName(route.name) &&
      MailTriggerRouteProvisioner.positiveId(route.mailbox) === mailboxId);

    if (matches.length > 1) {
      throw new APIError(502, 'mailtrigger_origin_route_ambiguous',
        'Multiple SMTP to Origin routes belong to this mailbox; refusing ambiguous deletion.');
    }

    if (matches.length === 0) {
      return;
    }

    const defaultRoute = matches[0];
    const defaultId = MailTriggerRouteProvisioner.positiveId(defaultRoute.id);

    if (defaultId === managedRouteId ||
      MailTriggerRouteProvisioner.includesID(defaultRoute.ruleConfigs, ruleId) ||
      MailTriggerRouteProvisioner.includesID(defaultRoute.actions, actionId)) {
      throw new APIError(409, 'mailtrigger_origin_route_conflict',
        'SMTP to Origin route refers to Nuwa-managed resources; refusing to delete it.');
    }

    await this.resources.delete('routes', defaultId);

    // A DELETE 204/404 is not sufficient proof that the default route is gone.
    const after = await this.resources.list(path, code);

    if (after.length >= 1000 || after.some((route) => MailTriggerRouteProvisioner.isDefaultSMTPToOriginName(route.name) &&
      MailTriggerRouteProvisioner.positiveId(route.mailbox) === mailboxId)) {
      throw new APIError(502, 'mailtrigger_origin_route_not_removed',
        'The default SMTP to Origin route still exists after deletion.');
    }
  }

  /**
   * Unlike the outbound SMTP-to-Origin default, MailTrigger's exact inbound
   * "Relay to Origin Route" remains until the NAR recipient Webhook is active.
   * The legacy "Relay to Origin" route and user-named variants are untouched.
   */
  private async removeDefaultRelayToOrigin(
    mailboxId: number,
    protectedRuleIds: number[],
    protectedActionIds: number[],
    protectedRouteIds: number[],
  ): Promise<void> {
    const path = '/api/v1/routes/?page_size=1000';
    const code = 'mailtrigger_relay_origin_lookup_failed';
    const rows = await this.resources.list(path, code);

    if (rows.length >= 1000) {
      throw new APIError(502, 'mailtrigger_relay_origin_ambiguous',
        'MailTrigger route listing may be truncated; refusing inbound origin route removal.');
    }

    const isTarget = (route: Resource): boolean =>
      route.name === 'Relay to Origin Route' &&
      MailTriggerRouteProvisioner.positiveId(route.mailbox) === mailboxId;

    const matches = rows.filter(isTarget);
    if (matches.length > 1) {
      throw new APIError(502, 'mailtrigger_relay_origin_ambiguous',
        'Multiple Relay to Origin Route entries belong to this mailbox; refusing deletion.');
    }

    if (matches.length === 0) {
      return;
    }

    const fallback = matches[0];
    const fallbackId = MailTriggerRouteProvisioner.positiveId(fallback.id);
    if (protectedRouteIds.includes(fallbackId) ||
      protectedRuleIds.some((id) => MailTriggerRouteProvisioner.includesID(fallback.ruleConfigs, id)) ||
      protectedActionIds.some((id) => MailTriggerRouteProvisioner.includesID(fallback.actions, id))) {
      throw new APIError(409, 'mailtrigger_relay_origin_conflict',
        'Inbound origin route references Nuwa-managed resources; refusing deletion.');
    }

    await this.resources.delete('routes', fallbackId);

    // Confirm actual removal; DELETE 204 alone does not prove it is gone.
    const after = await this.resources.list(path, code);
    if (after.length >= 1000 || after.some(isTarget)) {
      throw new APIError(502, 'mailtrigger_relay_origin_not_removed',
        'The inbound Relay to Origin Route remains after deletion.');
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

    // Ready only when the built-in SMTP path is verified and the conflicting
    // external-origin default for this same mailbox has been removed.
    await this.removeDefaultSMTPToOrigin(
      mailboxId, ruleId, actionId, MailTriggerRouteProvisioner.positiveId(verified.id),
    );

    // This is a separate recipient-side route; never attach an arrival Webhook
    // to the sender-side RelaySMTP route (which runs before delivery to B).
    await this.ensureReceiptRoute(
      mailbox, ownerId, ruleId, actionId, MailTriggerRouteProvisioner.positiveId(verified.id),
    );
  }
}
