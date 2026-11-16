import type { Env } from './Env';
import { APIError } from './HTTP';
import type { SessionIdentity } from './SessionIdentityClient';

export type StoredCoworkerPassphrase = {
  passphraseSalt: string | null;
  passphraseHash: string | null;
};

// Owns the office passphrase lifecycle; plaintext is never stored or returned.
export class CoworkerPassphrases {
  private static readonly ITERATIONS = 180_000;
  private static readonly SALT_BYTES = 16;

  constructor(
    private readonly env: Env,
    private readonly gateway: SessionIdentity,
  ) {}

  static validate(passphrase: string): void {
    if (passphrase.length < 16 || passphrase.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(passphrase)) {
      throw new APIError(400, 'invalid_coworker_passphrase',
        'A coworker passphrase must contain 16–128 characters and no control characters.');
    }
  }

  private static toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private static fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);

    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
  }

  private static async hash(passphrase: string, salt: Uint8Array): Promise<string> {
    const secret = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt).buffer,
      iterations: CoworkerPassphrases.ITERATIONS,
    }, secret, 256);

    return CoworkerPassphrases.toHex(new Uint8Array(bits));
  }

  static async verify(
    saved: StoredCoworkerPassphrase, submitted: string | undefined,
  ): Promise<boolean> {
    if (!saved.passphraseHash && !saved.passphraseSalt) {
      if (submitted !== undefined) {
        throw new APIError(403, 'coworker_passphrase_not_configured',
          'This coworker has not configured a passphrase.');
      }

      return false;
    }

    if (!saved.passphraseHash || !saved.passphraseSalt) {
      throw new APIError(409, 'coworker_passphrase_incomplete',
        'Coworker passphrase storage is incomplete.');
    }

    if (!submitted) {
      throw new APIError(403, 'coworker_passphrase_required',
        'This coworker requires a passphrase for delegated speaking.');
    }

    const actualHash = await CoworkerPassphrases.hash(
      submitted, CoworkerPassphrases.fromHex(saved.passphraseSalt),
    );
    const supplied = CoworkerPassphrases.fromHex(actualHash);
    const expected = CoworkerPassphrases.fromHex(saved.passphraseHash);
    let difference = supplied.length ^ expected.length;

    for (let index = 0; index < Math.min(supplied.length, expected.length); index += 1) {
      difference |= supplied[index] ^ expected[index];
    }

    if (difference !== 0) {
      throw new APIError(403, 'coworker_passphrase_invalid',
        'The coworker passphrase does not match.');
    }

    return true;
  }

  async set(recipientBotID: string, passphrase: string): Promise<{ configured: true }> {
    return this.store(recipientBotID, passphrase, true);
  }

  async setDuringEnrollment(recipientBotID: string, passphrase: string): Promise<void> {
    await this.store(recipientBotID, passphrase, false);
  }

  private async store(
    recipientBotID: string, passphrase: string, requireActive: boolean,
  ): Promise<{ configured: true }> {
    CoworkerPassphrases.validate(passphrase);

    const salt = crypto.getRandomValues(new Uint8Array(CoworkerPassphrases.SALT_BYTES));
    const hash = await CoworkerPassphrases.hash(passphrase, salt);
    const stored = await this.env.DB.prepare(
      'UPDATE gateway_office_coworkers SET passphrase_salt = ?, passphrase_hash = ? ' +
      'WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ? ' +
      'AND (? = 0 OR activated_at IS NOT NULL)',
    ).bind(CoworkerPassphrases.toHex(salt), hash, this.gateway.organizationID,
      this.gateway.sessionID, recipientBotID, requireActive ? 1 : 0).run();

    if (stored.meta.changes !== 1) {
      throw new APIError(404, 'office_coworker_not_found',
        'Only a registered coworker of this office may set a passphrase.');
    }

    return { configured: true };
  }

  async clear(recipientBotID: string): Promise<{ configured: false }> {
    const removed = await this.env.DB.prepare(
      'UPDATE gateway_office_coworkers SET passphrase_salt = NULL, passphrase_hash = NULL ' +
      'WHERE org_id = ? AND gateway_session_id = ? AND recipient_bot_id = ? ' +
      'AND activated_at IS NOT NULL',
    ).bind(this.gateway.organizationID, this.gateway.sessionID, recipientBotID).run();

    if (removed.meta.changes !== 1) {
      throw new APIError(404, 'office_coworker_not_found',
        'Only a registered coworker of this office may remove a passphrase.');
    }

    return { configured: false };
  }
}
