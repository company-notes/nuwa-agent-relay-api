import type { Env } from './Env';
import { APIError } from './HTTP';
import { SessionIdentityClient, type SessionIdentity } from './SessionIdentityClient';

export enum GatewayThreadMode {
  Explicit = 'explicit',
  Platform = 'platform',
}

type GatewayRoute = {
  recipientBotID: string;
  recipientCanonicalAddress: string;
  threadMode: GatewayThreadMode;
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
              recipient_canonical_address AS recipientCanonicalAddress
         FROM gateway_routes WHERE org_id = ? AND recipient_session_id = ?`,
    ).bind(this.identity.organizationID, this.identity.sessionID).first<GatewayRoute>();
  }

  async getRoute(): Promise<{ recipientBotID: string; threadMode: GatewayThreadMode } | null> {
    const row = await this.route();
    return row ? { recipientBotID: row.recipientBotID, threadMode: row.threadMode } : null;
  }

  async setRoute(recipientBotID: string, threadMode: GatewayThreadMode) {
    GatewayBindings.identifier(recipientBotID, 'recipientBotID');

    if (!Object.values(GatewayThreadMode).includes(threadMode)) {
      throw new APIError(400, 'invalid_gateway_mode', 'Unsupported Gateway thread mode.');
    }

    const existing = await this.route();

    if (existing && (existing.recipientBotID !== recipientBotID || existing.threadMode !== threadMode)) {
      const active = await this.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM gateway_conversations
          WHERE org_id = ? AND recipient_session_id = ?`,
      ).bind(this.identity.organizationID, this.identity.sessionID).first<{ count: number }>();

      if (active && active.count > 0) {
        throw new APIError(409, 'gateway_route_in_use',
          'Remove existing conversation bindings before replacing the recipient Bot or mode.');
      }
    }

    await this.env.DB.prepare(
      `INSERT INTO gateway_routes
         (org_id, recipient_agent_id, recipient_session_id, recipient_canonical_address,
          recipient_bot_id, thread_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, recipient_session_id) DO UPDATE SET
         recipient_canonical_address = excluded.recipient_canonical_address,
         recipient_bot_id = excluded.recipient_bot_id,
         thread_mode = excluded.thread_mode`,
    ).bind(this.identity.organizationID, this.identity.agentID, this.identity.sessionID,
      this.identity.canonicalAddress, recipientBotID, threadMode, new Date().toISOString()).run();

    return { recipientBotID, threadMode };
  }

  async deleteRoute() {
    await this.env.DB.batch([
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
    await this.env.DB.prepare(
      `INSERT INTO gateway_conversations
         (org_id, sender_session_id, recipient_session_id, native_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, sender_session_id, recipient_session_id) DO UPDATE SET
         native_thread_id = excluded.native_thread_id`,
    ).bind(this.identity.organizationID, senderSessionID, this.identity.sessionID,
      nativeThreadID, new Date().toISOString()).run();

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

  async deleteConversation(senderSessionID: string) {
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
      throw new APIError(409, 'gateway_conversation_unbound',
        'No recipient-authorized native Thread binding exists for this sender.');
    }

    return { ...dispatch, recipientPlatformThreadID: conversation.nativeThreadID };
  }
}
