import type { Env } from './Env';
import { APIError } from './HTTP';
import { GatewayFirstContacts } from './GatewayFirstContacts';
import { GatewayRoster } from './GatewayRoster';
import { GatewayFirstContactMode, GatewayFirstContactStatus, GatewayModeCodec, GatewayThreadMode } from './GatewayModeCodec';
import { SessionIdentityClient, type SessionIdentity } from './SessionIdentityClient';

type GatewayRouteRow = {
  recipientBotID: string;
  recipientCanonicalAddress: string;
  threadMode: string;
  firstContactMode: string;
};

type GatewayRoute = {
  recipientBotID: string;
  recipientCanonicalAddress: string;
  threadMode: GatewayThreadMode;
  firstContactMode: GatewayFirstContactMode;
};

type NativeConversation = {
  nativeThreadID: string;
};

/** Owns recipient-authorized, sender-specific platform conversation routes. */
export class GatewayBindings {
  constructor(
    private readonly env: Env,
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  private static identifier(value: string, name: string): string {
    if (!/^[A-Za-z0-9._:-]{1,192}$/.test(value)) {
      throw new APIError(400, 'invalid_gateway_binding', `${name} is not a valid platform identifier.`);
    }

    return value;
  }

  private static readRoute(row: GatewayRouteRow): GatewayRoute {
    return {
      recipientBotID: row.recipientBotID,
      recipientCanonicalAddress: row.recipientCanonicalAddress,
      threadMode: GatewayModeCodec.readThreadMode(row.threadMode),
      firstContactMode: GatewayModeCodec.readFirstContactMode(row.firstContactMode),
    };
  }

  private async route(): Promise<GatewayRoute | null> {
    const row = await this.env.DB.prepare(
      `SELECT recipient_bot_id AS recipientBotID, thread_mode AS threadMode,
              first_contact_mode AS firstContactMode,
              recipient_canonical_address AS recipientCanonicalAddress
         FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first<GatewayRouteRow>();

    return row ? GatewayBindings.readRoute(row) : null;
  }

  private firstContacts(): GatewayFirstContacts {
    return new GatewayFirstContacts(this.env, this.identity.organizationID, this.identity.sessionID);
  }

  async getRoute(): Promise<{
    recipientBotID: string;
    threadMode: string;
    firstContactMode: string;
  } | null> {
    const row = await this.route();

    return row ? {
      recipientBotID: row.recipientBotID,
      threadMode: GatewayModeCodec.writeThreadMode(row.threadMode),
      firstContactMode: GatewayModeCodec.writeFirstContactMode(row.firstContactMode),
    } : null;
  }

  async setRoute(
    recipientBotID: string, threadMode: GatewayThreadMode,
    firstContactMode: GatewayFirstContactMode = GatewayFirstContactMode.Manual,
  ) {
    await GatewayRoster.requireIndependentRoute(
      this.env, this.identity.organizationID, this.identity.sessionID,
    );

    GatewayBindings.identifier(recipientBotID, 'recipientBotID');

    if (!Object.values(GatewayThreadMode).includes(threadMode)) {
      throw new APIError(400, 'invalid_gateway_mode', 'Unsupported Gateway thread mode.');
    }

    if (!Object.values(GatewayFirstContactMode).includes(firstContactMode) ||
        (threadMode === GatewayThreadMode.Platform &&
          firstContactMode !== GatewayFirstContactMode.Manual)) {
      throw new APIError(400, 'invalid_gateway_first_contact',
        'Automatic first contact is only supported by explicit-thread Gateways.');
    }

    const existing = await this.route();

    if (existing && (existing.recipientBotID !== recipientBotID ||
        existing.threadMode !== threadMode || existing.firstContactMode !== firstContactMode)) {
      const pending = await this.firstContacts().pending();

      if (pending.length > 0) {
        throw new APIError(409, 'gateway_route_in_use',
          'Complete or cancel pending first contacts before changing the Gateway route.');
      }

      if (existing.recipientBotID !== recipientBotID || existing.threadMode !== threadMode) {
        const active = await this.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM gateway_conversations
            WHERE org_id = ? AND recipient_session_id = ?`,
        ).bind(this.identity.organizationID, this.identity.sessionID).first<{ count: number }>();

        if (active && active.count > 0) {
          throw new APIError(409, 'gateway_route_in_use',
            'Remove existing conversation bindings before changing the Bot or thread mode.');
        }
      }
    }

    await this.env.DB.prepare(
      `INSERT INTO gateway_routes
         (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
          recipient_bot_id, thread_mode, first_contact_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, recipient_session_id) DO UPDATE SET
         recipient_canonical_address = excluded.recipient_canonical_address,
         recipient_bot_id = excluded.recipient_bot_id,
         thread_mode = excluded.thread_mode,
         first_contact_mode = excluded.first_contact_mode`,
    ).bind(this.identity.organizationID, this.identity.agentID, this.identity.sessionID,
      this.identity.canonicalAddress, recipientBotID,
      GatewayModeCodec.writeThreadMode(threadMode),
      GatewayModeCodec.writeFirstContactMode(firstContactMode),
      new Date().toISOString()).run();

    return {
      recipientBotID,
      threadMode: GatewayModeCodec.writeThreadMode(threadMode),
      firstContactMode: GatewayModeCodec.writeFirstContactMode(firstContactMode),
    };
  }

  async deleteRoute() {
    await GatewayRoster.requireIndependentRoute(
      this.env, this.identity.organizationID, this.identity.sessionID,
    );

    await this.env.DB.batch([
      this.env.DB.prepare(
        'DELETE FROM gateway_first_contacts WHERE org_id = ? AND recipient_session_id = ?',
      ).bind(this.identity.organizationID, this.identity.sessionID),
      this.env.DB.prepare(
        'DELETE FROM gateway_conversations WHERE org_id = ? AND recipient_session_id = ?',
      ).bind(this.identity.organizationID, this.identity.sessionID),
      this.env.DB.prepare(
        'DELETE FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?',
      ).bind(this.identity.organizationID, this.identity.sessionID),
    ]);

    return { removed: true };
  }

  private async validateSender(senderSessionID: string) {
    if (senderSessionID === this.identity.sessionID) {
      throw new APIError(400, 'invalid_gateway_sender', 'Sender and recipient Sessions must differ.');
    }

    const sender = await this.address.session(senderSessionID);

    if (sender.id !== senderSessionID ||
        sender.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(403, 'gateway_sender_forbidden',
        'Sender Session must belong to the recipient Organization.');
    }
  }

  async setConversation(senderSessionID: string, nativeThreadID: string) {
    GatewayBindings.identifier(nativeThreadID, 'nativeThreadID');

    const route = await this.route();

    if (!route || route.threadMode !== GatewayThreadMode.Explicit) {
      throw new APIError(409, 'gateway_route_required',
        'Explicit native Thread bindings require an explicit-thread Gateway route.');
    }

    await this.validateSender(senderSessionID);

    if ((await this.firstContacts().get(senderSessionID))?.status === GatewayFirstContactStatus.Pending) {
      throw new APIError(409, 'gateway_first_contact_pending',
        'Complete or cancel the first-contact reservation before manually binding a Thread.');
    }

    await this.env.DB.prepare(
      `INSERT INTO gateway_conversations
         (org_id, sender_session_id, recipient_session_id, native_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, sender_session_id, recipient_session_id) DO UPDATE SET
         native_thread_id = excluded.native_thread_id`,
    ).bind(this.identity.organizationID, senderSessionID, this.identity.sessionID,
      nativeThreadID, new Date().toISOString()).run();

    // A manual rebind supersedes the old bootstrap completion receipt.
    await this.firstContacts().clear(senderSessionID);

    return { senderSessionID, recipientSessionID: this.identity.sessionID, nativeThreadID };
  }

  async getConversations() {
    const result = await this.env.DB.prepare(
      `SELECT sender_session_id AS senderSessionID, native_thread_id AS nativeThreadID
         FROM gateway_conversations
        WHERE org_id = ? AND recipient_session_id = ? ORDER BY sender_session_id`,
    ).bind(this.identity.organizationID, this.identity.sessionID)
      .all<{ senderSessionID: string; nativeThreadID: string }>();

    return result.results;
  }

  async getFirstContacts() {
    return this.firstContacts().pending();
  }

  private static requireAutomaticFirstContact(
    route: Pick<GatewayRoute, 'threadMode' | 'firstContactMode'> | null,
  ): void {
    if (!route || route.threadMode !== GatewayThreadMode.Explicit ||
        route.firstContactMode !== GatewayFirstContactMode.Automatic) {
      throw new APIError(409, 'gateway_first_contact_unavailable',
        'Automatic first contact requires an explicit-thread Gateway route.');
    }
  }

  async confirmFirstContact(senderSessionID: string, messageID: string, nativeThreadID: string) {
    GatewayBindings.identifier(nativeThreadID, 'nativeThreadID');
    GatewayBindings.requireAutomaticFirstContact(await this.route());
    await this.validateSender(senderSessionID);

    return this.firstContacts().confirm(senderSessionID, messageID, nativeThreadID);
  }

  /**
   * An approved office Gateway may submit a native tool receipt for a teammate
   * without possessing that teammate's OAuth or Runtime capability.
   */
  async confirmTeammateFirstContact(
    recipientSessionID: string, senderSessionID: string,
    messageID: string, nativeThreadID: string,
  ) {
    GatewayBindings.identifier(nativeThreadID, 'nativeThreadID');

    if (recipientSessionID === this.identity.sessionID ||
        senderSessionID === recipientSessionID) {
      throw new APIError(403, 'gateway_teammate_forbidden',
        'A shared Gateway can only confirm another approved recipient.');
    }

    const route = await this.env.DB.prepare(
      `SELECT r.recipient_bot_id AS recipientBotID,
              r.recipient_canonical_address AS recipientCanonicalAddress,
              r.thread_mode AS threadMode,
              r.first_contact_mode AS firstContactMode
         FROM gateway_teammates t
         JOIN gateway_routes r ON r.org_id = t.org_id
           AND r.recipient_session_id = t.recipient_session_id
           AND r.recipient_agent_id = t.recipient_agent_id
           AND r.recipient_bot_id = t.recipient_bot_id
           AND r.thread_mode = t.thread_mode
           AND r.first_contact_mode = t.first_contact_mode
         WHERE t.org_id = ? AND t.gateway_session_id = ?
           AND t.recipient_session_id = ? AND t.status = 'active'`,
    ).bind(this.identity.organizationID, this.identity.sessionID, recipientSessionID)
      .first<GatewayRouteRow>();

    if (!route) {
      throw new APIError(403, 'gateway_teammate_forbidden',
        'Only an approved Gateway can confirm this recipient native Thread.');
    }

    GatewayBindings.requireAutomaticFirstContact(GatewayBindings.readRoute(route));
    await this.validateSender(senderSessionID);

    return new GatewayFirstContacts(this.env, this.identity.organizationID,
      recipientSessionID).confirm(senderSessionID, messageID, nativeThreadID);
  }

  async cancelFirstContact(senderSessionID: string) {
    await this.validateSender(senderSessionID);

    return this.firstContacts().cancel(senderSessionID);
  }

  async deleteConversation(senderSessionID: string) {
    await this.firstContacts().clear(senderSessionID);
    const deleted = await this.env.DB.prepare(
      `DELETE FROM gateway_conversations
        WHERE org_id = ? AND recipient_session_id = ? AND sender_session_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID, senderSessionID).run();

    return { removed: deleted.meta.changes === 1 };
  }

  /** No untrusted message may select or replace a platform recipient. */
  static async dispatch(
    env: Env,
    message: {
      id: string;
      threadID: string;
      senderSessionID: string;
      senderCanonicalAddress: string;
      recipientAgentID: string;
      recipientSessionID: string | null;
      recipientWakeSessionID: string;
      organizationID: string;
      body: string;
    },
  ): Promise<Record<string, unknown>> {
    const minimal = {
      event: 'nuwa.message.available',
      eventVersion: 2,
      messageID: message.id,
      recipientSessionID: message.recipientSessionID ?? message.recipientWakeSessionID,
    };

    if (!message.recipientSessionID) {
      return minimal;
    }

    if (message.recipientSessionID !== message.recipientWakeSessionID) {
      const membership = await env.DB.prepare(
        `SELECT recipient_session_id FROM gateway_teammates
         WHERE org_id = ? AND recipient_session_id = ? AND gateway_session_id = ?
           AND status = 'active'`,
      ).bind(message.organizationID, message.recipientSessionID, message.recipientWakeSessionID)
        .first();

      if (!membership) {
        return minimal;
      }
    }

    const route = await env.DB.prepare(
      `SELECT recipient_bot_id AS recipientBotID, thread_mode AS threadMode,
              first_contact_mode AS firstContactMode,
              recipient_canonical_address AS recipientCanonicalAddress
         FROM gateway_routes
        WHERE org_id = ? AND recipient_session_id = ? AND recipient_agent_id = ?`,
    ).bind(message.organizationID, message.recipientSessionID,
      message.recipientAgentID).first<GatewayRouteRow>();

    if (!route) {
      return minimal;
    }

    const storedRoute = GatewayBindings.readRoute(route);

    if (!message.senderCanonicalAddress) {
      throw new APIError(409, 'gateway_sender_identity_unavailable',
        'Historical Message predates verified canonical sender storage.');
    }

    const dispatch: Record<string, unknown> = {
      ...minimal,
      relayThreadID: message.threadID,
      senderSessionID: message.senderSessionID,
      senderCanonicalAddress: message.senderCanonicalAddress,
      recipientAgentID: message.recipientAgentID,
      recipientCanonicalAddress: route.recipientCanonicalAddress,
      recipientBotID: route.recipientBotID,
      body: message.body,
    };

    if (storedRoute.threadMode === GatewayThreadMode.Platform) {
      return dispatch;
    }

    if (storedRoute.threadMode !== GatewayThreadMode.Explicit) {
      throw new APIError(500, 'gateway_route_invalid', 'Stored Gateway thread mode is invalid.');
    }

    const conversation = await env.DB.prepare(
      `SELECT native_thread_id AS nativeThreadID
         FROM gateway_conversations
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?`,
    ).bind(message.organizationID, message.senderSessionID, message.recipientSessionID)
      .first<NativeConversation>();

    if (!conversation) {
      if (storedRoute.firstContactMode !== GatewayFirstContactMode.Automatic) {
        throw new APIError(409, 'gateway_conversation_unbound',
          'No recipient-authorized native Thread binding exists for this sender.');
      }

      await GatewayFirstContacts.reserve(env, message.organizationID, message.senderSessionID,
        message.recipientSessionID, message.id);

      // A null native Thread indicates a reserved explicit first contact.
      // Omission means the platform manages its own Thread (e.g. GrokBot).
      // The existing V2 Studio Wake Receiver permits this optional field.
      return { ...dispatch, recipientPlatformThreadID: null };
    }

    return { ...dispatch, recipientPlatformThreadID: conversation.nativeThreadID };
  }
}
