import type { AddressStatus } from './AddressClient';
import type { Env } from './Env';
import { APIError } from './HTTP';
import { IdentityContext } from './IdentityContext';
import { Logger } from './Logger';

export class WakePairingOAuth {
  private static readonly logger = Logger.forModule('wake.pairing.oauth');
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly callbackURL = WakePairingOAuth.origin + '/wake-pair/oauth/callback';

  constructor(private readonly env: Env) {}

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
    const response = await fetch(this.endpoint(path), {
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

  async registerClient(): Promise<string> {
    const response = await this.post('/register', {
      client_name: 'Nuwa Wake Pairing',
      redirect_uris: [WakePairingOAuth.callbackURL],
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

  async authorizationURL(clientId: string, state: string, verifier: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const url = new URL(this.endpoint('/authorize'));

    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', WakePairingOAuth.callbackURL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  async verifyWork(clientId: string, code: string, verifier: string,
                   workAddressID: string, orgID: string): Promise<void> {
    const tokenResponse = await this.post('/token', new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: WakePairingOAuth.callbackURL,
      code_verifier: verifier,
    }));
    const accessToken = tokenResponse.access_token;

    if (typeof accessToken !== 'string' || !accessToken ||
      accessToken.length > 4096 || /[\r\n\t ]/.test(accessToken)) {
      throw new APIError(502, 'pairing_oauth_invalid', 'OAuth did not issue an access token.');
    }

    const url = new URL(this.endpoint('/v1/account/status'));
    url.searchParams.set('work_address_id', workAddressID);

    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok || response.status >= 300) {
      throw new APIError(403, 'pairing_work_not_owned',
        'The signed-in Agent Address account cannot manage this Work.');
    }

    let payload: { ok?: boolean; data?: AddressStatus };
    try {
      payload = await response.json() as typeof payload;
    } catch (error) {
      WakePairingOAuth.logger.exception('invalid_work_status_json', error);
      throw new APIError(502, 'pairing_oauth_invalid', 'Agent Address status is invalid.');
    }

    if (!payload.ok || !payload.data) {
      throw new APIError(403, 'pairing_work_not_owned',
        'The signed-in Agent Address account cannot manage this Work.');
    }

    const identity = new IdentityContext(payload.data);

    if (identity.work.id !== workAddressID || identity.organization.id !== orgID) {
      throw new APIError(403, 'pairing_work_not_owned',
        'The signed-in Agent Address account cannot manage this Work.');
    }
  }
}
