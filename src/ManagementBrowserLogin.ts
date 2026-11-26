import type { Env } from './Env';
import { APIError } from './HTTP';
import { CollaborationOwnerSession } from './CollaborationOwnerSession';
import { ManagementLocation } from './ManagementLocation';
import { WakePairingOAuth } from './WakePairingOAuth';
import { RelayManagementPage } from './RelayManagementPage';

type LoginFlow = {
  clientID: string;
  verifier: string;
  section: string;
  policyID: string | null;
};

export class ManagementBrowserLogin {
  private readonly oauth: WakePairingOAuth;
  private static readonly COOKIE_FLAGS = '; Path=/; Secure; HttpOnly; SameSite=Lax';

  constructor(private readonly env: Env) {
    this.oauth = new WakePairingOAuth(env);
  }

  private static random(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private static cookieName(state: string): string {
    return '__Host-nuwa_manage_' + state;
  }

  async begin(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const section = query.get('section') ?? 'wake';
    const policyID = query.get('collaboration');
    ManagementLocation.target(section, policyID);

    const state = ManagementBrowserLogin.random();
    const verifier = ManagementBrowserLogin.random();
    const clientID = await this.oauth.registerClient(ManagementLocation.callbackURI, 'Nuwa Relay Management');
    const flow: LoginFlow = { clientID, verifier, section, policyID };
    const destination = new URL(await this.oauth.authorizationURL(
      clientID, state, verifier, ManagementLocation.callbackURI,
    ));

    if (query.get('prompt') === 'login') {
      destination.searchParams.set('prompt', 'login');
    }

    return new Response(null, { status: 302, headers: {
      location: destination.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': ManagementBrowserLogin.cookieName(state) + '=' +
        encodeURIComponent(JSON.stringify(flow)) + ManagementBrowserLogin.COOKIE_FLAGS + '; Max-Age=600',
    } });
  }

  private static flow(request: Request, state: string): LoginFlow {
    const prefix = ManagementBrowserLogin.cookieName(state) + '=';
    const value = (request.headers.get('cookie') ?? '').split(';')
      .map((item) => item.trim()).find((item) => item.startsWith(prefix))?.slice(prefix.length);

    if (!value) {
      throw new APIError(403, 'management_state_mismatch', 'Open the management login again in this browser.');
    }

    let flow: LoginFlow;

    try {
      flow = JSON.parse(decodeURIComponent(value)) as LoginFlow;
    } catch {
      throw new APIError(400, 'management_flow_invalid', 'The login flow is invalid.');
    }

    if (!flow || typeof flow.clientID !== 'string' || !flow.clientID ||
        typeof flow.verifier !== 'string' || !/^[a-f0-9]{64}$/.test(flow.verifier)) {
      throw new APIError(400, 'management_flow_invalid', 'The login flow is invalid.');
    }

    return flow;
  }

  async complete(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const state = query.get('state');
    const code = query.get('code');

    if (!state || !/^[a-f0-9]{64}$/.test(state) || !code || code.length > 4096) {
      throw new APIError(400, 'management_oauth_invalid', 'The management authorization is incomplete.');
    }

    const flow = ManagementBrowserLogin.flow(request, state);
    const target = ManagementLocation.target(flow.section, flow.policyID);
    const token = await this.oauth.exchangeToken(flow.clientID, code, flow.verifier, ManagementLocation.callbackURI);
    const response = RelayManagementPage.callback(token, target);
    response.headers.append('set-cookie', await new CollaborationOwnerSession(this.env).issue(token));
    response.headers.append('set-cookie', ManagementBrowserLogin.cookieName(state) + '=' +
      ManagementBrowserLogin.COOKIE_FLAGS + '; Max-Age=0');

    return response;
  }
}
