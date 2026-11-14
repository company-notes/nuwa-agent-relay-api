import type { Env } from './Env';
import { APIError } from './HTTP';

export type SessionIdentity = {
  organizationID: string;
  organizationSlug: string;
  agentID: string;
  sessionID: string;
  canonicalAddress: string;
};

export type ResolvedSession = {
  id: string;
  agentId: string;
  canonical: string;
};

type AccountStatus = {
  organization: { id: string; slug: string } | null;
};

type Lease = { expiresAt: string };

export type DirectoryAgent = {
  id: string;
  handle: string;
  displayName: string | null;
  defaultSessionID: string | null;
  defaultSessionHandle: string | null;
};

export class SessionIdentityClient {
  constructor(
    private readonly addressURL: Env['ADDRESS_API_URL'],
    private readonly authorization: string,
    private readonly requester: typeof fetch = fetch,
  ) {
    const origin = new URL(addressURL);

    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search ||
        origin.hash || origin.username || origin.password) {
      throw new APIError(503, 'address_configuration_invalid', 'Agent Address requires an HTTPS origin.');
    }
  }

  private async request<T>(method: 'GET' | 'PATCH', path: string, body?: Record<string, string>): Promise<T> {
    const response = await this.requester(new URL(path, this.addressURL), {
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
        session.canonical.split('/').length !== 3) {
      throw new APIError(502, 'address_response_invalid', 'Agent Address returned an invalid Session.');
    }

    return session;
  }

  async status(): Promise<{ organization: { id: string; slug: string } | null }> {
    return this.request<AccountStatus>('GET', '/v2/account/status');
  }

  /** Cache identity is scoped to the OAuth bearer and verified Organization. */
  async directoryCacheScope(organizationID: string): Promise<string> {
    const credential = new TextEncoder().encode(this.authorization);
    const digest = await crypto.subtle.digest('SHA-256', credential);
    const fingerprint = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0')).join('');

    return this.addressURL + ':' + organizationID + ':' + fingerprint;
  }

  async listAgents(): Promise<DirectoryAgent[]> {
    const records = await this.request<unknown>('GET', '/v2/account/agents');

    if (!Array.isArray(records) || records.some((row) =>
      !row || typeof row !== 'object' || typeof row.id !== 'string' ||
      typeof row.handle !== 'string' || !row.handle ||
      row.displayName != null && typeof row.displayName !== 'string' ||
      row.defaultSessionID != null && typeof row.defaultSessionID !== 'string' ||
      row.defaultSessionHandle != null && typeof row.defaultSessionHandle !== 'string' ||
      Boolean(row.defaultSessionID) !== Boolean(row.defaultSessionHandle))) {
      throw new APIError(502, 'address_response_invalid',
        'Agent Address returned an invalid authorized directory.');
    }

    return records as DirectoryAgent[];
  }

  async session(sessionID: string): Promise<ResolvedSession> {
    return SessionIdentityClient.requireSession(await this.request<ResolvedSession>(
      'GET', '/v2/account/sessions/' + encodeURIComponent(sessionID),
    ));
  }

  async resolve(address: string): Promise<ResolvedSession> {
    const session = await this.request<ResolvedSession>(
      'GET',
      '/v2/account/addresses?address=' + encodeURIComponent(address),
    );

    return SessionIdentityClient.requireSession(session);
  }

  async authorize(sessionID: string, runtimeToken: string): Promise<SessionIdentity> {
    if (!sessionID || !runtimeToken) {
      throw new APIError(400, 'session_capability_required', 'Session ID and Runtime capability are required.');
    }

    // The two independent identity reads can run in parallel. Runtime
    // ownership is still checked after both authoritative results agree.
    const [status, verifiedSession] = await Promise.all([
      this.status(),
      this.session(sessionID),
    ]);
    const organization = status?.organization;

    if (!organization || typeof organization.id !== 'string' ||
        typeof organization.slug !== 'string') {
      throw new APIError(403, 'organization_required', 'No authorized Organization is available.');
    }

    if (verifiedSession.id !== sessionID ||
        verifiedSession.canonical.split('/')[0] !== organization.slug) {
      throw new APIError(502, 'address_response_invalid', 'Session identity does not match its Organization.');
    }

    // Heartbeat atomically proves current Runtime ownership and renews its lease.
    // OAuth membership and knowledge of a Session ID alone never grant execution rights.
    const lease = await this.request<Lease>(
      'PATCH',
      '/v2/account/sessions/' + encodeURIComponent(sessionID) + '/runtime-lease',
      { runtimeToken },
    );

    if (!lease || typeof lease.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= Date.now()) {
      throw new APIError(502, 'address_response_invalid', 'Runtime lease was not renewed.');
    }

    return {
      organizationID: organization.id,
      organizationSlug: organization.slug,
      agentID: verifiedSession.agentId,
      sessionID: verifiedSession.id,
      canonicalAddress: verifiedSession.canonical,
    };
  }
}
