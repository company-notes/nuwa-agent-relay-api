import { APIError } from './HTTP';

/** Authoritative grammar for a native platform Bot's stable routing ID. */
export class PlatformBotIdentity {
  static requireID(value: string, label: string): void {
    if (!/^[A-Za-z0-9._:-]{1,192}$/.test(value)) {
      throw new APIError(400, 'invalid_gateway_binding',
        label + ' is not a valid platform identifier.');
    }
  }
}
