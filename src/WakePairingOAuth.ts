import { AgentAddressTransport } from './AgentAddressTransport';
import { SessionIdentityClient } from './SessionIdentityClient';
import type { Env } from './Env';
import { APIError } from './HTTP';
import { Logger } from './Logger';

export class WakePairingOAuth {
  private static readonly logger = Logger.forModule('wake.pairing.oauth');
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly callbackURL = WakePairingOAuth.origin + '/wake-pair/oauth/callback';

  private readonly transport: AgentAddressTransport;

  constructor(private readonly env: Env) {
    this.transport = new AgentAddressTransport(env.ADDRESS_WORKER);
  }

  private endpoint(path: string): string {
    const origin = new URL(this.env.ADDRESS_API_URL);

    if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
      throw new APIError(503, 'pairing_oauth_configuration', 'OAuth origin is not configured safely.');
    }

    return new URL(path, origin).toString();
  }

  private async post(path: string, data: URLSearchParams | Record<string, unknown>): Promise<Record<string, unknown>> {
    const json = !(data instanceof URLSearchParams);
    const response = await this.transport.request(this.endpoint(path), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body: json ? JSON.stringify(data) : data.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok || response.status >= 300) {
      throw new APIError(502, 'pairing_oauth_unavailable', 'Agent Address OAuth exchange failed.');
    }

    try {
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('OAuth payload is not an object.');
      }

      return payload as Record<string, unknown>;
    } catch (error) {
      // Never include OAuth token responses or callback codes in an exception.
      WakePairingOAuth.logger.exception('invalid_provider_json', error);
      throw new APIError(502, 'pairing_oauth_invalid', 'Agent Address returned an invalid OAuth response.');
    }
  }

  async registerClient(
    redirectURI = WakePairingOAuth.callbackURL,
    clientName = 'Nuwa Wake Pairing',
  ): Promise<string> {
    const response = await this.post('/register', {
      client_name: clientName,
      redirect_uris: [redirectURI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    if (typeof response.client_id !== 'string' ||
      response.client_id.length < 1 || response.client_id.length > 512) {
      throw new APIError(502, 'pairing_oauth_invalid', 'OAuth registration did not return a client ID.');
    }

    return response.client_id;
  }

  async authorizationURL(
    clientId: string, state: string, verifier: string,
    redirectURI = WakePairingOAuth.callbackURL,
  ): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const url = new URL(this.endpoint('/authorize'));

    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectURI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  async exchangeToken(
    clientID: string, code: string, verifier: string,
    redirectURI = WakePairingOAuth.callbackURL,
  ): Promise<string> {
    const tokenResponse = await this.post('/token', new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientID,
      code,
      redirect_uri: redirectURI,
      code_verifier: verifier,
    }));
    const token = tokenResponse.access_token;

    if (typeof token !== 'string' || !token || token.length > 4096 ||
      /[\r\n\t ]/.test(token)) {
      throw new APIError(502, 'pairing_oauth_invalid', 'OAuth did not issue an access token.');
    }

    return token;
  }

  async verifySession(
    clientID: string,
    code: string,
    verifier: string,
    sessionID: string,
    organizationID: string,
  ): Promise<void> {
    const token = await this.exchangeToken(clientID, code, verifier);

    const identity = new SessionIdentityClient(
      this.env.ADDRESS_API_URL, 'Bearer ' + token,
      this.transport.request.bind(this.transport),
    );
    const status = await identity.status();

    if (!status.organization || status.organization.id !== organizationID) {
      throw new APIError(403, 'pairing_session_not_owned',
        'Account has no permission to manage this Session.');
    }

    const session = await identity.session(sessionID);

    if (session.id !== sessionID ||
        session.canonical.split('/')[0] !== status.organization.slug) {
      throw new APIError(403, 'pairing_session_not_owned',
        'Account has no permission to manage this Session.');
    }
  }
}
