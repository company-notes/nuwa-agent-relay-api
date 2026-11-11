import type { Env } from './Env';
import { APIError } from './HTTP';
import { Logger } from './Logger';

export type WakeAuthMode = 'hmac' | 'bearer' | 'capability';

export type WakeTargetConfig = {
  callbackURL: string;
  authMode: WakeAuthMode;
  bearerToken?: string;
  signingSecret: string;
};

/** Validates outbound callback destinations and owns private transport credentials. */
export class WakeTarget {
  private static readonly logger = Logger.forModule('wake.target');
  private static readonly blockedSuffixes = [
    '.localhost', '.local', '.internal', '.lan', '.home.arpa',
    '.test', '.invalid', '.example', '.onion', '.arpa',
  ];

  static validateURL(value: string): URL {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new APIError(400, 'invalid_callback_url', 'Wake callback must be a public HTTPS URL.');
    }

    const host = url.hostname.toLowerCase();

    if (url.protocol !== 'https:' || !host.includes('.') ||
      host.length > 253 || !/^[a-z0-9.-]+$/.test(host) ||
      host.startsWith('-') || host.endsWith('-') || host.endsWith('.') ||
      host.startsWith('.') || host.includes('..') ||
      host === 'localhost' || host === 'metadata.google.internal' ||
      this.blockedSuffixes.some((suffix) => host.endsWith(suffix)) ||
      /^[0-9.]+$/.test(host) || host.includes(':') ||
      url.username || url.password || url.hash || url.search ||
      (url.port && url.port !== '443') || value.length > 2048) {
      throw new APIError(400, 'callback_not_allowed',
        'Wake callback requires a public HTTPS DNS hostname without credentials, query or nonstandard port.');
    }

    return url;
  }

  static validateConfig(callbackURL: string, authMode: string, bearerToken?: string): WakeTargetConfig {
    const url = this.validateURL(callbackURL);

    if (authMode !== 'hmac' && authMode !== 'bearer' && authMode !== 'capability') {
      throw new APIError(400, 'invalid_wake_auth', 'authMode must be hmac, bearer or capability.');
    }

    if (authMode === 'bearer' && (!bearerToken || bearerToken.length < 12 || bearerToken.length > 2048 ||
      /[\r\n]/.test(bearerToken))) {
      throw new APIError(400, 'invalid_wake_auth', 'Bearer callback requires a nonempty secure credential.');
    }

    if (authMode !== 'bearer' && bearerToken) {
      throw new APIError(400, 'invalid_wake_auth', 'Bearer credential may only be used with bearer authMode.');
    }

    return {
      callbackURL: url.toString(),
      authMode,
      bearerToken,
      signingSecret: Array.from(crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }

  static publicURL(value: string): string {
    return this.validateURL(value).origin;
  }

  private static async key(env: Env): Promise<CryptoKey> {
    const raw = env.WAKE_CREDENTIALS_KEY;

    if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
      throw new APIError(503, 'wake_credentials_unconfigured',
        'A 32-byte WAKE_CREDENTIALS_KEY Worker secret must be configured to register Wake callbacks.');
    }

    const bytes = Uint8Array.from(raw.match(/../g)!, (item) => parseInt(item, 16));
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  static async encrypt(env: Env, config: WakeTargetConfig): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(config));
    const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
      await this.key(env), encoded);

    return 'v1:' + this.base64(iv) + ':' + this.base64(new Uint8Array(result));
  }

  static async decrypt(env: Env, encrypted: string): Promise<WakeTargetConfig> {
    const parts = encrypted.split(':');

    if (parts.length !== 3 || parts[0] !== 'v1') {
      throw new APIError(500, 'wake_target_invalid', 'Stored Wake target is invalid.');
    }

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(this.unbase64(parts[1])) },
      await this.key(env), Uint8Array.from(this.unbase64(parts[2])));

    return JSON.parse(new TextDecoder().decode(plaintext)) as WakeTargetConfig;
  }

  private static base64(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  }

  private static unbase64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }

  private static async signature(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));

    return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  static async send(config: WakeTargetConfig, data: Record<string, string>): Promise<boolean> {
    // Re-validate on *every* delivery, including persisted/legacy targets.
    const target = this.validateURL(config.callbackURL);
    const body = JSON.stringify(data);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-nuwa-wake-signature': 'sha256=' + await this.signature(config.signingSecret, body),
    };

    if (config.authMode === 'bearer') {
      headers.authorization = 'Bearer ' + config.bearerToken;
    }

    // The URL and secret are never sent to callers or logging. Redirects are forbidden.
    const response = await fetch(target.toString(), {
      method: 'POST',
      headers,
      body,
      // Workers supports 'manual', not 'error'; never follow redirects with
      // a private Bearer token or signed Wake body.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });

    // Non-2xx, including 3xx, never verifies a callback or marks Wake delivered.
    const delivered = response.status >= 200 && response.status < 300;
    if (!delivered) {
      WakeTarget.logger.warning('callback_http_rejected', { status: response.status });
    }

    return delivered;
  }
}
