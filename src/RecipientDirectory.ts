import { APIError } from './HTTP';
import {
  SessionIdentityClient, type ResolvedSession, type SessionIdentity,
} from './SessionIdentityClient';

/** Deterministic name-to-recipient mapping inside Relay, never a Gateway LLM decision. */
export class RecipientDirectory {
  constructor(
    private readonly identity: SessionIdentity,
    private readonly address: SessionIdentityClient,
  ) {}

  private static normalize(value: string): string {
    return value.trim().normalize('NFKC').toLowerCase();
  }

  async resolve(name: string): Promise<ResolvedSession> {
    if (!name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new APIError(400, 'invalid_recipient_name', 'Recipient name must be a single short line.');
    }

    const requested = RecipientDirectory.normalize(name);
    const candidates = await this.address.listAgents();
    const matches = candidates.filter((agent) =>
      RecipientDirectory.normalize(agent.displayName ?? '') === requested ||
      RecipientDirectory.normalize(agent.handle) === requested);

    if (matches.length === 0) {
      throw new APIError(404, 'recipient_name_not_found',
        'No registered colleague matches that visible name. Ask the user to check the Bot.');
    }

    if (matches.length > 1) {
      throw new APIError(409, 'recipient_name_ambiguous',
        'Several colleagues share that name. Ask which Bot is intended.');
    }

    const [agent] = matches;

    if (!agent.defaultSessionHandle) {
      throw new APIError(409, 'recipient_name_not_ready',
        'The named colleague does not have an available default Session.');
    }

    // Resolve through Agent Address's authorized directory to avoid trusting
    // display names as routes or recreating canonical Session identity here.
    const session = await this.address.resolve(
      this.identity.organizationSlug + '/' + agent.handle,
    );

    if (session.agentId !== agent.id ||
        session.canonical.split('/')[0] !== this.identity.organizationSlug) {
      throw new APIError(409, 'recipient_name_identity_mismatch',
        'The named coworker changed identity while the recipient was being resolved.');
    }

    return session;
  }
}
