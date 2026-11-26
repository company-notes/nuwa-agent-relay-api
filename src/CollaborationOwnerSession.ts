import type { Env } from './Env';

export class CollaborationOwnerSession {
  constructor(private readonly env: Env) {}

  private static async digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private static name(digest: string): string {
    return '__Host-nuwa_owner_' + digest.slice(0, 16);
  }

  async issue(token: string): Promise<string> {
    const tokenDigest = await CollaborationOwnerSession.digest(token);
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const cookieDigest = await CollaborationOwnerSession.digest(secret);
    const now = Date.now();

    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM collaboration_owner_sessions WHERE expires_at <= ?').bind(now),
      this.env.DB.prepare(
        'INSERT OR REPLACE INTO collaboration_owner_sessions (token_digest, cookie_digest, expires_at) VALUES (?, ?, ?)',
      ).bind(tokenDigest, cookieDigest, now + 30 * 60_000),
    ]);

    return CollaborationOwnerSession.name(tokenDigest) + '=' + secret +
      '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800';
  }

  async canEdit(request: Request, authorization: string): Promise<boolean> {
    const tokenDigest = await CollaborationOwnerSession.digest(authorization.replace(/^Bearer\s+/i, ''));
    const prefix = CollaborationOwnerSession.name(tokenDigest) + '=';
    const secret = (request.headers.get('cookie') ?? '').split(';').map((item) => item.trim())
      .find((item) => item.startsWith(prefix))?.slice(prefix.length);

    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) {
      return false;
    }

    const row = await this.env.DB.prepare(
      'SELECT token_digest FROM collaboration_owner_sessions WHERE token_digest = ? AND cookie_digest = ? AND expires_at > ?',
    ).bind(tokenDigest, await CollaborationOwnerSession.digest(secret), Date.now()).first();

    return row !== null;
  }
}
