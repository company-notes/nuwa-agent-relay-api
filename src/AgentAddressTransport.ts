import type { Env } from './Env';

/** Private Worker-to-Worker transport shared by Relay identity and pairing. */
export class AgentAddressTransport {
  constructor(private readonly worker: Env['ADDRESS_WORKER']) {}

  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.worker.fetch(input, init);
  }
}
