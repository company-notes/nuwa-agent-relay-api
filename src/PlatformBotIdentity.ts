import { APIError } from './HTTP';

/** Authoritative grammar for a native platform Bot's stable routing ID. */
export class PlatformBotIdentity {
  /** A native UUID is unambiguous; prefix other platform IDs with bot:. */
  static readSelector(value: string): string | null {
    const target = value.trim();

    if (target.startsWith('bot:')) {
      const botID = target.slice(4);
      PlatformBotIdentity.requireID(botID, 'Bot ID');

      return botID;
    }

    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(target)
      ? target : null;
  }

  static requireID(value: string, label: string): void {
    if (!/^[A-Za-z0-9._:-]{1,192}$/.test(value)) {
      throw new APIError(400, 'invalid_gateway_binding',
        label + ' is not a valid platform identifier.');
    }
  }
}
