import type { Env } from './Env';
import { APIError } from './HTTP';
import { GatewayFirstContacts } from './GatewayFirstContacts';
import { SessionIdentityClient, type SessionIdentity } from './SessionIdentityClient';

export enum GatewayThreadMode {
  Explicit = 'explicit',
  Platform = 'platform',
}

export enum GatewayFirstContactMode {
  Manual = 'manual',
  Automatic = 'automatic',
}

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

  private async route(): Promise<GatewayRoute | null> {
    return this.env.DB.prepare(
      `SELECT recipient_bot_id AS recipientBotID, thread_mode AS threadMode,
              first_contact_mode AS firstContactMode,
              recipient_canonical_address AS recipientCanonicalAddress
         FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first<GatewayRoute>();
  }

  private firstContacts(): GatewayFirstContacts {
    return new GatewayFirstContacts(this.env, this.identity.organizationID, this.identity.sessionID);
  }

  async getRoute(): Promise<{
    recipientBotID: string;
    threadMode: GatewayThreadMode;
    firstContactMode: GatewayFirstContactMode;
  } | null> {
    const row = await this.route();

    return row ? {
      recipientBotID: row.recipientBotID,
      threadMode: row.threadMode,
      firstContactMode: row.firstContactMode,
    } : null;
  }

  async setRoute(
    recipientBotID: string, threadMode: GatewayThreadMode,
    firstContactMode: GatewayFirstContactMode = GatewayFirstContactMode.Manual,
  ) {
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
      this.identity.canonicalAddress, recipientBotID, threadMode, firstContactMode,
      new Date().toISOString()).run();

    return { recipientBotID, threadMode, firstContactMode };
  }

  async deleteRoute() {
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

    if ((await this.firstContacts().get(senderSessionID))?.status === 'pending') {
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

  async confirmFirstContact(senderSessionID: string, messageID: string, nativeThreadID: string) {
    GatewayBindings.identifier(nativeThreadID, 'nativeThreadID');
    const route = await this.route();

    if (!route || route.threadMode !== GatewayThreadMode.Explicit ||
        route.firstContactMode !== GatewayFirstContactMode.Automatic) {
      throw new APIError(409, 'gateway_first_contact_unavailable',
        'Automatic first contact requires an explicit-thread Gateway route.');
    }

    await this.validateSender(senderSessionID);

    return this.firstContacts().confirm(senderSessionID, messageID, nativeThreadID);
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
      recipientSessionID: message.recipientWakeSessionID,
    };

    if (message.recipientSessionID !== message.recipientWakeSessionID) {
      return minimal;
    }

    const route = await env.DB.prepare(
      `SELECT recipient_bot_id AS recipientBotID, thread_mode AS threadMode,
              first_contact_mode AS firstContactMode,
              recipient_canonical_address AS recipientCanonicalAddress
         FROM gateway_routes
        WHERE org_id = ? AND recipient_session_id = ? AND recipient_agent_id = ?`,
    ).bind(message.organizationID, message.recipientSessionID,
      message.recipientAgentID).first<GatewayRoute>();

    if (!route) {
      return minimal;
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

    if (route.threadMode === GatewayThreadMode.Platform) {
      return dispatch;
    }

    if (route.threadMode !== GatewayThreadMode.Explicit) {
      throw new APIError(500, 'gateway_route_invalid', 'Stored Gateway thread mode is invalid.');
    }

    const conversation = await env.DB.prepare(
      `SELECT native_thread_id AS nativeThreadID
         FROM gateway_conversations
        WHERE org_id = ? AND sender_session_id = ? AND recipient_session_id = ?`,
    ).bind(message.organizationID, message.senderSessionID, message.recipientSessionID)
      .first<NativeConversation>();

    if (!conversation) {
      if (route.firstContactMode !== GatewayFirstContactMode.Automatic) {
        throw new APIError(409, 'gateway_conversation_unbound',
          'No recipient-authorized native Thread binding exists for this sender.');
      }

      await GatewayFirstContacts.reserve(env, message.organizationID, message.senderSessionID,
        message.recipientWakeSessionID, message.id);

      return { ...dispatch, gatewayAction: 'create_native_thread' };
    }

    return { ...dispatch, recipientPlatformThreadID: conversation.nativeThreadID };
  }
}
