import type { Env } from './Env';
import { APIError } from './HTTP';
import { Logger } from './Logger';

export type SessionIdentity = {
  organizationID: string;
  organizationSlug: string;
  organizationIdentityRevision: number;
  agentID: string;
  sessionID: string;
  canonicalAddress: string;
  agentDisplayName?: string | null;
};

export type ResolvedSession = {
  id: string;
  agentId: string;
  canonical: string;
  agentDisplayName?: string | null;
};

type OrganizationIdentity = { id: string; slug: string; identityRevision: number };

type AccountStatus = {
  organization: { id: string; slug: string } | null;
  grantFingerprint?: string;
};

export type SessionSelection = {
  organization: OrganizationIdentity;
  sessions: ResolvedSession[];
};

type Lease = {
  expiresAt: string;
  organization: OrganizationIdentity | null;
  session: ResolvedSession;
};

export type AuthorizedSession = SessionIdentity & { leaseExpiresAt: string };

export type DirectoryAgent = {
  id: string;
  handle: string;
  displayName: string | null;
  defaultSessionID: string | null;
  defaultSessionHandle: string | null;
  registrationID?: string | null;
};

export class SessionIdentityClient {
  private static readonly logger = Logger.forModule('relay.address');
  constructor(
    private readonly addressURL: Env['ADDRESS_API_URL'],
    private readonly authorization: string,
    private readonly requester: typeof fetch,
  ) {
    const origin = new URL(addressURL);

    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search ||
        origin.hash || origin.username || origin.password) {
      throw new APIError(503, 'address_configuration_invalid', 'Agent Address requires an HTTPS origin.');
    }
  }

  async grant(organizationID: string): Promise<string> {
    const account = await this.request<AccountStatus>('GET', '/v2/account/status?include_grant=1');

    if (account.organization?.id !== organizationID || !/^[a-f0-9]{64}$/.test(account.grantFingerprint ?? '')) {
      throw new APIError(403, 'grant_identity_required', 'Verified grant identity is required for collaboration.');
    }

    return account.grantFingerprint!;
  }

  private async request<T>(method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE', path: string, body?: Record<string, string>): Promise<T> {
    let response: Response;

    try {
      response = await this.requester(new URL(path, this.addressURL), {
        method,
        headers: {
          authorization: this.authorization,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // Do not log OAuth tokens, request URLs or upstream exception messages.
      SessionIdentityClient.logger.exception('transport_failed', error);

      throw new APIError(502, 'address_transport_failed',
        'Agent Address service request failed.');
    }

    if (response.status >= 300 && response.status < 400) {
      throw new APIError(502, 'address_unexpected_redirect', 'Agent Address unexpectedly redirected.');
    }

    if (!response.ok) {
      const status = [401, 403, 404, 409].includes(response.status) ? response.status : 502;
      throw new APIError(status, 'address_authorization_failed', 'Agent Address rejected the operation.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned invalid JSON.');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !('ok' in payload) || payload.ok !== true || !('data' in payload)) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned an invalid response.');
    }

    return payload.data as T;
  }

  private static requireSession(value: unknown): ResolvedSession {
    const session = value as ResolvedSession | null;

    if (!session || typeof session.id !== 'string' || !session.id ||
        typeof session.agentId !== 'string' || !session.agentId ||
        typeof session.canonical !== 'string' ||
        session.canonical.split('/').length !== 3 ||
        session.agentDisplayName != null && typeof session.agentDisplayName !== 'string') {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned an invalid Session.');
    }

    return session;
  }

  /** Cache identity is scoped to the OAuth bearer and verified Organization. */
  async directoryCacheScope(organizationID: string, identityRevision: number): Promise<string> {
    const credential = new TextEncoder().encode(this.authorization);
    const digest = await crypto.subtle.digest('SHA-256', credential);
    const fingerprint = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0')).join('');

    return this.addressURL + ':' + organizationID + ':' + identityRevision + ':' + fingerprint;
  }

  async listAgents(): Promise<DirectoryAgent[]> {
    const records = await this.request<unknown>('GET', '/v2/account/agents');

    if (!Array.isArray(records) || records.some((row) =>
      !row || typeof row !== 'object' || typeof row.id !== 'string' ||
      typeof row.handle !== 'string' || !row.handle ||
      row.displayName != null && typeof row.displayName !== 'string' ||
      row.registrationID != null && typeof row.registrationID !== 'string' ||
      row.defaultSessionID != null && typeof row.defaultSessionID !== 'string' ||
      row.defaultSessionHandle != null && typeof row.defaultSessionHandle !== 'string' ||
      Boolean(row.defaultSessionID) !== Boolean(row.defaultSessionHandle))) {
      throw new APIError(502, 'address_response_invalid',
        'Agent Address returned an invalid authorized directory.');
    }

    return records as DirectoryAgent[];
  }

  async listSessions(agentID: string): Promise<ResolvedSession[]> {
    const value = await this.request<unknown>(
      'GET', '/v2/account/agents/' + encodeURIComponent(agentID) + '/sessions',
    );

    if (!Array.isArray(value) || value.some((session) =>
      !session || typeof session !== 'object' || session.agentId !== agentID)) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned invalid Agent Sessions.');
    }

    return value.map(SessionIdentityClient.requireSession);
  }

  async purgeAgent(agentID: string): Promise<void> {
    const data = await this.request<{ id: string; purged: true }>(
      'DELETE', '/v2/account/agents/' + encodeURIComponent(agentID) + '/data',
      { confirmAgentID: agentID },
    );

    if (data.id !== agentID || data.purged !== true) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address did not confirm permanent cleanup.');
    }
  }

  async registerOfficeAgent(registrationID: string, agentDisplayName: string): Promise<ResolvedSession> {
    // A stable request ID is scoped by the OAuth Organization in Agent Address.
    // Its idempotent response contains only the public Session, never a Runtime credential.
    const registered = await this.request<{ session: unknown }>(
      'PUT', '/v2/account/agent-registrations/' + encodeURIComponent(registrationID),
      { agentDisplayName, sessionName: 'main' },
    );

    return SessionIdentityClient.requireSession(registered.session);
  }

  async renameAgent(agentID: string, displayName: string): Promise<void> {
    const updated = await this.request<{ id: string; displayName: string }>(
      'PATCH', '/v2/account/agents/' + encodeURIComponent(agentID),
      { agentDisplayName: displayName },
    );

    if (updated.id !== agentID || updated.displayName !== displayName) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address did not confirm the display name.');
    }
  }

  async status(): Promise<AccountStatus> {
    return this.request<AccountStatus>('GET', '/v2/account/status');
  }

  async session(sessionID: string): Promise<ResolvedSession> {
    return SessionIdentityClient.requireSession(await this.request<ResolvedSession>(
      'GET', '/v2/account/sessions/' + encodeURIComponent(sessionID),
    ));
  }

  async selectSessions(sessionIDs: string[]): Promise<SessionSelection> {
    const query = new URLSearchParams();
    for (const sessionID of sessionIDs) {
      query.append('session_id', sessionID);
    }

    const selection = await this.request<SessionSelection>(
      'GET', '/v2/account/sessions?' + query.toString(),
    );
    const organization = selection?.organization;

    if (!organization || typeof organization.id !== 'string' ||
        typeof organization.slug !== 'string' ||
        !Number.isSafeInteger(organization.identityRevision) || organization.identityRevision < 0 ||
        !Array.isArray(selection.sessions)) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned an invalid Session selection.');
    }

    const sessions = selection.sessions.map(SessionIdentityClient.requireSession);
    const selectedIDs = new Set(sessions.map((session) => session.id));

    if (selectedIDs.size !== sessions.length ||
        sessions.some((session) => !sessionIDs.includes(session.id))) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned unexpected Sessions.');
    }

    return { organization, sessions };
  }

  async resolve(address: string): Promise<ResolvedSession> {
    const session = await this.request<ResolvedSession>(
      'GET',
      '/v2/account/addresses?address=' + encodeURIComponent(address),
    );

    return SessionIdentityClient.requireSession(session);
  }

  async authorize(sessionID: string, runtimeToken: string): Promise<AuthorizedSession> {
    if (!sessionID || !runtimeToken) {
      throw new APIError(400, 'session_capability_required', 'Session ID and Runtime capability are required.');
    }

    const lease = await this.request<Lease>(
      'PATCH',
      '/v2/account/sessions/' + encodeURIComponent(sessionID) + '/runtime-lease?include_identity=1',
      { runtimeToken },
    );
    const organization = lease?.organization;
    const verifiedSession = SessionIdentityClient.requireSession(lease?.session);

    if (!organization || typeof organization.id !== 'string' ||
        typeof organization.slug !== 'string') {
      throw new APIError(403, 'organization_required', 'No authorized Organization is available.');
    }

    if (!Number.isSafeInteger(organization.identityRevision) || organization.identityRevision < 0) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address did not return an identity revision.');
    }

    if (verifiedSession.id !== sessionID ||
        verifiedSession.canonical.split('/')[0] !== organization.slug) {
      throw new APIError(502, 'address_response_invalid', 'Session identity does not match its Organization.');
    }

    if (!lease || typeof lease.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= Date.now()) {
      throw new APIError(502, 'address_response_invalid', 'Runtime lease was not renewed.');
    }

    return {
      organizationID: organization.id,
      organizationSlug: organization.slug,
      organizationIdentityRevision: organization.identityRevision,
      agentID: verifiedSession.agentId,
      sessionID: verifiedSession.id,
      canonicalAddress: verifiedSession.canonical,
      agentDisplayName: verifiedSession.agentDisplayName ?? null,
      leaseExpiresAt: lease.expiresAt,
    };
  }
}
