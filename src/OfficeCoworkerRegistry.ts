export type OfficeReceivingState = {
  independentAt: string | null;
  directWakeSessionID: string | null;
  nativeRouteSessionID: string | null;
  activeGatewaySessionID: string | null;
};

/** Stable native identity and current receiving configuration. */
export class OfficeCoworkerRegistry {
  static readonly receivingColumns = `
    c.independent_at AS independentAt,
    w.session_id AS directWakeSessionID,
    r.recipient_session_id AS nativeRouteSessionID,
    g.gateway_session_id AS activeGatewaySessionID`;

  static readonly receivingJoins = `
    LEFT JOIN wake_subscriptions w
      ON w.org_id = c.org_id AND w.session_id = c.recipient_session_id
    LEFT JOIN gateway_routes r
      ON r.org_id = c.org_id AND r.recipient_session_id = c.recipient_session_id
    LEFT JOIN gateway_teammates g
      ON g.org_id = c.org_id AND g.recipient_session_id = c.recipient_session_id
      AND g.status = 'active'`;

  static async handleFor(organizationID: string, gatewaySessionID: string, botID: string) {
    const source = organizationID + ':' + gatewaySessionID + ':' + botID;
    const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));

    return 'office-' + Array.from(new Uint8Array(hashed).slice(0, 16),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static route(state: OfficeReceivingState): 'gateway' | 'direct' | 'inbox' | 'inactive' {
    if (state.activeGatewaySessionID) {
      return 'gateway';
    }

    if (state.directWakeSessionID) {
      return 'direct';
    }

    return state.independentAt || state.nativeRouteSessionID ? 'inbox' : 'inactive';
  }

  static hasConnection(state: OfficeReceivingState): boolean {
    return Boolean(state.activeGatewaySessionID || state.directWakeSessionID ||
      state.independentAt || state.nativeRouteSessionID);
  }
}
