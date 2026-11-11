import type { Env } from './Env';
import { APIError } from './HTTP';
import { Logger } from './Logger';
import { WakePairingOAuth } from './WakePairingOAuth';
import { WakeRegistration } from './WakeRegistration';
import { WakeTarget } from './WakeTarget';

type WorkScope = { work: { id: string }; organization: { id: string } };

type PairingRow = {
  id: string;
  workAddressId: string;
  orgId: string;
  expiresAt: string;
  sessionDigest: string | null;
  sessionExpiresAt: string | null;
  consumedAt: string | null;
};

type OAuthAttemptRow = PairingRow & {
  oauthClientId: string;
  oauthStartedAt: string;
};

export class WakePairing {
  private static readonly logger = Logger.forModule('wake.pairing');
  private static readonly oauthCookie = '__Host-nuwa_pair_oauth';
  private static readonly sessionCookie = '__Host-nuwa_pair_session';
  private static readonly maxPairMs = 20 * 60_000;
  private static readonly maxOAuthMs = 10 * 60_000;
  private static readonly maxSessionMs = 10 * 60_000;

  constructor(private readonly env: Env) {}

  private static random(bytes = 32): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),
      (value) => value.toString(16).padStart(2, '0')).join('');
  }

  private static async digest(text: string): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buffer),
      (value) => value.toString(16).padStart(2, '0')).join('');
  }

  private static csrfToken(sessionCookie: string): Promise<string> {
    // The private browser session is a random 256-bit secret. Bind each form
    // to that specific session without storing another credential in D1.
    return this.digest('nuwa.wake.pair.csrf.v1:' + sessionCookie);
  }

  private static matchesCSRF(received: string, expected: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(received) || received.length !== expected.length) {
      return false;
    }

    let difference = 0;

    for (let index = 0; index < expected.length; index += 1) {
      difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
    }

    return difference === 0;
  }

  private static cookie(request: Request, name: string): string | null {
    const candidate = request.headers.get('cookie')?.split(';')
      .map((entry) => entry.trim()).find((entry) => entry.startsWith(name + '='));

    return candidate ? candidate.slice(name.length + 1) : null;
  }

  private static oauthCookieName(state: string): string {
    // Each OAuth flow needs its own cookie; a second browser tab must not
    // overwrite the first flow's PKCE verifier.
    return WakePairing.oauthCookie + '_' + state.split('.')[1];
  }

  private static secureCookie(name: string, value: string, ageSeconds: number): string {
    return name + '=' + value +
      '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + ageSeconds;
  }

  private static noCache(response: Response): Response {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  }

  private static redirect(path: string, cookies: string[] = []): Response {
    // Response.redirect creates immutable headers in Workers. Construct a
    // fresh response so secure cookie and no-store headers can be attached.
    const response = new Response(null, {
      status: 303,
      headers: { location: path },
    });

    for (const cookie of cookies) {
      response.headers.append('set-cookie', cookie);
    }

    return this.noCache(response);
  }

  private static escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private static page(title: string, content: string, status = 200): Response {
    const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${this.escape(title)} — Nuwa Wake Pairing</title>
<style>
:root { color-scheme: light dark; font-family: system-ui,sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(32rem, 92vw); padding: 1.5rem 0; }
h1 { font-size: 1.5rem; } p { line-height: 1.65; }
form { border: 1px solid color-mix(in srgb,CanvasText 25%,transparent); border-radius: .8rem; padding: 1.2rem; }
label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
input { width: 100%; box-sizing: border-box; padding: .7rem; font: inherit; }
button { font: inherit; padding: .75rem 1.2rem; margin-top: 1.25rem; cursor: pointer; }
small { opacity: .75; } code { overflow-wrap: anywhere; }
</style></head><body><main><h1>${this.escape(title)}</h1>${content}</main></body></html>`;

    return this.noCache(new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      },
    }));
  }

  private async byId(id: string): Promise<PairingRow | null> {
    return this.env.DB.prepare(
      `SELECT id, work_address_id AS workAddressId, org_id AS orgId,
              expires_at AS expiresAt, session_digest AS sessionDigest,
              session_expires_at AS sessionExpiresAt, consumed_at AS consumedAt
       FROM wake_pairing_requests WHERE id = ?`,
    ).bind(id).first<PairingRow>();
  }

  async create(scope: WorkScope): Promise<{
    status: string; workAddressId: string; pairingUrl: string; expiresAt: string;
  }> {
    const id = crypto.randomUUID();
    const secret = WakePairing.random();
    const digest = await WakePairing.digest(secret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + WakePairing.maxPairMs).toISOString();
    const cooldown = new Date(now.getTime() - 60_000).toISOString();
    const retentionCutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

    // Bound orphaned attempts when invitations are replaced or expire.
    await this.env.DB.prepare(
      'DELETE FROM wake_pairing_oauth_attempts WHERE started_at < ?',
    ).bind(retentionCutoff).run();

    const result = await this.env.DB.prepare(
      `INSERT INTO wake_pairing_requests
         (id, org_id, work_address_id, link_digest, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_address_id) DO UPDATE SET
         id = excluded.id,
         org_id = excluded.org_id,
         link_digest = excluded.link_digest,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         oauth_state_digest = NULL,
         oauth_client_id = NULL,
         oauth_started_at = NULL,
         session_digest = NULL,
         session_expires_at = NULL,
         consumed_at = NULL
       WHERE wake_pairing_requests.created_at < ?`,
    ).bind(id, scope.organization.id, scope.work.id, digest,
      now.toISOString(), expiresAt, cooldown).run();

    if (result.meta.changes !== 1) {
      throw new APIError(429, 'pairing_cooldown',
        'Wait 60 seconds before creating another pairing link for this Work.');
    }

    return {
      status: 'awaiting_user',
      workAddressId: scope.work.id,
      pairingUrl: WakePairingOAuth.origin + '/wake-pair/' + secret,
      expiresAt,
    };
  }

  private async startOAuth(link: string): Promise<Response> {
    if (!/^[a-f0-9]{64}$/.test(link)) {
      throw new APIError(404, 'pairing_not_found', 'Pairing link is invalid or expired.');
    }

    const digest = await WakePairing.digest(link);
    const row = await this.env.DB.prepare(
      `SELECT id, expires_at AS expiresAt, consumed_at AS consumedAt,
              session_digest AS sessionDigest
       FROM wake_pairing_requests WHERE link_digest = ?`,
    ).bind(digest).first<{
      id: string; expiresAt: string;
      consumedAt: string | null; sessionDigest: string | null;
    }>();

    if (!row || row.consumedAt || row.sessionDigest ||
      row.expiresAt <= new Date().toISOString()) {
      throw new APIError(404, 'pairing_not_found', 'Pairing link is invalid or expired.');
    }

    const oauth = new WakePairingOAuth(this.env);
    const clientId = await oauth.registerClient();
    const state = row.id + '.' + WakePairing.random(24);
    const verifier = WakePairing.random();
    const stateDigest = await WakePairing.digest(state);
    const now = new Date().toISOString();

    const created = await this.env.DB.prepare(
      `INSERT INTO wake_pairing_oauth_attempts
         (state_digest, pairing_id, oauth_client_id, started_at)
       SELECT ?, id, ?, ? FROM wake_pairing_requests
       WHERE id = ? AND expires_at > ? AND consumed_at IS NULL
         AND session_digest IS NULL`,
    ).bind(stateDigest, clientId, now, row.id, now).run();

    if (created.meta.changes !== 1) {
      throw new APIError(409, 'pairing_expired', 'Pairing link is no longer active.');
    }

    return WakePairing.redirect(await oauth.authorizationURL(clientId, state, verifier), [
      WakePairing.secureCookie(WakePairing.oauthCookieName(state),
        state + ':' + verifier, 600),
      WakePairing.secureCookie(WakePairing.sessionCookie, '', 0),
    ]);
  }

  private async oauthCallback(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;

    if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1) {
      throw new APIError(400, 'pairing_oauth_invalid', 'OAuth authorization was not completed.');
    }

    const state = params.get('state') ?? '';
    const code = params.get('code') ?? '';
    const match = state.match(/^([0-9a-f-]{36})\.([a-f0-9]{48})$/);
    const oauthCookieName = match ? WakePairing.oauthCookieName(state) : '';
    const cookie = match ? WakePairing.cookie(request, oauthCookieName) : null;
    const verifier = cookie?.startsWith(state + ':') ? cookie.slice(state.length + 1) : null;

    if (!match || !code || code.length > 4096 || !verifier || !/^[a-f0-9]{64}$/.test(verifier)) {
      throw new APIError(403, 'pairing_oauth_invalid', 'Pairing login was not initiated in this browser.');
    }

    const now = new Date();
    const digest = await WakePairing.digest(state);
    const row = await this.env.DB.prepare(
      `SELECT p.id, p.work_address_id AS workAddressId,
              p.org_id AS orgId, p.expires_at AS expiresAt,
              p.session_digest AS sessionDigest,
              p.session_expires_at AS sessionExpiresAt,
              p.consumed_at AS consumedAt,
              a.oauth_client_id AS oauthClientId,
              a.started_at AS oauthStartedAt
       FROM wake_pairing_oauth_attempts AS a
       JOIN wake_pairing_requests AS p ON p.id = a.pairing_id
       WHERE a.state_digest = ? AND a.pairing_id = ?`,
    ).bind(digest, match[1]).first<OAuthAttemptRow>();

    if (!row) {
      throw new APIError(403, 'pairing_oauth_unrecognized',
        'This OAuth login cannot be matched to the pairing link.');
    }

    if (row.sessionDigest || row.consumedAt) {
      throw new APIError(409, 'pairing_oauth_replayed',
        'This pairing has already been approved.');
    }

    if (row.expiresAt <= now.toISOString() ||
      Date.parse(row.oauthStartedAt) + WakePairing.maxOAuthMs <= now.getTime()) {
      throw new APIError(410, 'pairing_oauth_expired',
        'This pairing login has expired. Start again from a new pairing link.');
    }

    await new WakePairingOAuth(this.env).verifyWork(
      row.oauthClientId, code, verifier, row.workAddressId, row.orgId,
    );

    const sessionSecret = WakePairing.random();
    const sessionDigest = await WakePairing.digest(row.id + ':' + sessionSecret);
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(row.expiresAt), now.getTime() + WakePairing.maxSessionMs,
    )).toISOString();

    const consumedState = await this.env.DB.prepare(
      `UPDATE wake_pairing_requests
       SET session_digest = ?, session_expires_at = ?
       WHERE id = ? AND session_digest IS NULL AND consumed_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM wake_pairing_oauth_attempts
           WHERE state_digest = ?
             AND pairing_id = wake_pairing_requests.id
             AND started_at > ?
         )`,
    ).bind(sessionDigest, sessionExpiresAt, row.id, now.toISOString(), digest,
      new Date(now.getTime() - WakePairing.maxOAuthMs).toISOString()).run();

    if (consumedState.meta.changes !== 1) {
      throw new APIError(409, 'pairing_oauth_replayed', 'OAuth approval has already been used.');
    }

    return WakePairing.redirect(WakePairingOAuth.origin + '/wake-pair/complete', [
      WakePairing.secureCookie(oauthCookieName, '', 0),
      WakePairing.secureCookie(WakePairing.sessionCookie, row.id + '.' + sessionSecret, 600),
    ]);
  }

  private async session(request: Request): Promise<PairingRow> {
    const cookie = WakePairing.cookie(request, WakePairing.sessionCookie);
    const match = cookie?.match(/^([0-9a-f-]{36})\.([a-f0-9]{64})$/);
    if (!match) {
      throw new APIError(403, 'pairing_login_required', 'Sign in through the pairing link first.');
    }

    const row = await this.byId(match[1]);
    const digest = await WakePairing.digest(match[1] + ':' + match[2]);
    const now = new Date().toISOString();

    if (!row || row.sessionDigest !== digest || !row.sessionExpiresAt ||
      row.sessionExpiresAt <= now || row.expiresAt <= now || row.consumedAt) {
      throw new APIError(403, 'pairing_expired', 'Pairing session has expired or was already completed.');
    }

    return row;
  }

  private async showForm(request: Request): Promise<Response> {
    const row = await this.session(request);
    const safeWork = WakePairing.escape(row.workAddressId);
    const csrfToken = await WakePairing.csrfToken(
      WakePairing.cookie(request, WakePairing.sessionCookie)!,
    );

    const response = WakePairing.page('安全連接 Webhook', `
<p>已透過 Agent Address 驗證這個 Work 的管理權限。</p>
<p>Work ID：<code>${safeWork}</code></p>
<p>請從你的 Automation 設定複製 Webhook URL 與金鑰，直接貼到這個頁面。
金鑰只會傳給 Relay Worker，不需要讓助理讀取。</p>
<form method="post" action="/wake-pair/complete" autocomplete="off">
<input type="hidden" name="csrfToken" value="${csrfToken}">
<label for="url">Webhook HTTPS URL</label>
<input id="url" name="callbackUrl" type="url" inputmode="url" maxlength="2048"
 placeholder="https://api2.cursor.sh/..." required>
<label for="key">Webhook Key</label>
<input id="key" name="bearerToken" type="password" minlength="12" maxlength="2048"
 autocomplete="new-password" required>
<button type="submit">加密保存並發送一次驗證</button></form>
<p><small>這是一次性配對。之後的每則訊息不必重新輸入金鑰；金鑰不會進入 URL、
MCP 工具參數或 Agent 任務提示。</small></p>`);

    // For same-origin HTML form POST, no-referrer turns Origin into "null".
    // Override it only on the form; redirects and confirmation pages stay private.
    response.headers.set('referrer-policy', 'same-origin');

    return response;
  }

  private async submitForm(request: Request): Promise<Response> {
    // Fetch serializes Origin as "null" for form POSTs under "no-referrer".
    // Require a same-origin browser navigation for an opaque Origin. Older
    // clients omitting Origin still need a valid session-bound CSRF token.
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    const opaqueSameOrigin = origin === 'null' && fetchSite === 'same-origin';
    const crossSite = fetchSite !== null && fetchSite !== 'same-origin';

    if (crossSite || (origin !== null &&
      origin !== WakePairingOAuth.origin && !opaqueSameOrigin)) {
      WakePairing.logger.warning('form_source_rejected', {
        originKind: origin === null ? 'missing' : origin === 'null' ? 'opaque' : 'other',
        fetchSiteKind: fetchSite === null ? 'missing' :
          fetchSite === 'same-origin' ? 'same-origin' : 'not-same-origin',
      });

      throw new APIError(403, 'pairing_cross_origin', 'Pairing form must originate from Relay.');
    }

    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      throw new APIError(415, 'pairing_form_required', 'Use the secure pairing form.');
    }

    const row = await this.session(request);
    const declaredSize = Number(request.headers.get('content-length') ?? 0);
    if (!Number.isFinite(declaredSize) || declaredSize > 8192) {
      throw new APIError(413, 'pairing_form_too_large', 'Pairing form is too large.');
    }

    const body = await request.text();
    if (body.length > 8192) {
      throw new APIError(413, 'pairing_form_too_large', 'Pairing form is too large.');
    }

    const form = new URLSearchParams(body);
    const csrfValues = form.getAll('csrfToken');
    const sessionCookie = WakePairing.cookie(request, WakePairing.sessionCookie)!;
    const expectedCSRF = await WakePairing.csrfToken(sessionCookie);

    if (csrfValues.length !== 1 || !WakePairing.matchesCSRF(csrfValues[0], expectedCSRF)) {
      throw new APIError(403, 'pairing_csrf_invalid',
        'Pairing form expired or did not originate from this browser session.');
    }

    const callbackValues = form.getAll('callbackUrl');
    const credentialValues = form.getAll('bearerToken');

    if (callbackValues.length !== 1 || credentialValues.length !== 1) {
      throw new APIError(400, 'pairing_form_invalid', 'A Webhook URL and Key are required.');
    }

    // Validate before consuming the one-time authorization; never echo either field.
    WakeTarget.validateConfig(callbackValues[0], 'bearer', credentialValues[0]);

    const now = new Date().toISOString();
    const consumed = await this.env.DB.prepare(
      `UPDATE wake_pairing_requests SET consumed_at = ?
       WHERE id = ? AND session_digest = ? AND consumed_at IS NULL
         AND session_expires_at > ? AND expires_at > ?`,
    ).bind(now, row.id, row.sessionDigest, now, now).run();

    if (consumed.meta.changes !== 1) {
      throw new APIError(409, 'pairing_already_used', 'Pairing was already completed.');
    }

    // WakeRegistration owns encryption, the cooldown and the one-time challenge.
    // The OAuth browser proved ownership of this exact organization and Work.
    const scope: WorkScope = {
      organization: { id: row.orgId },
      work: { id: row.workAddressId },
    };

    try {
      const result = await new WakeRegistration(this.env, scope).begin(
        callbackValues[0], 'bearer', credentialValues[0],
      );

      return WakePairing.page('Webhook 已提交驗證', `
<p>Work ID：<code>${WakePairing.escape(row.workAddressId)}</code></p>
<p>${result.challengeDelivered
  ? '驗證事件已送達 Webhook。請讓已授權的 Agent 呼叫 relayVerifyWake 完成一次性驗證。'
  : 'Relay 尚未確認 Webhook 收到 Challenge，請檢查 Automation 執行紀錄後重新建立配對連結。'}</p>
<p>Key 已交由 Relay 加密管理，不會回傳給助理。這個配對連結無法再次使用。</p>`);
    } catch (error) {
      WakePairing.logger.exception('registration_failed', error);
      throw error;
    }
  }

  async handlePublic(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === '/wake-pair/oauth/callback' && request.method === 'GET') {
      return this.oauthCallback(request);
    }

    if (path === '/wake-pair/complete') {
      if (request.method === 'GET') {
        return this.showForm(request);
      }
      if (request.method === 'POST') {
        return this.submitForm(request);
      }
    }

    const token = path.match(/^\/wake-pair\/([a-f0-9]{64})$/)?.[1];
    if (token && request.method === 'GET') {
      return this.startOAuth(token);
    }

    throw new APIError(404, 'pairing_not_found', 'Pairing endpoint not found.');
  }
}
