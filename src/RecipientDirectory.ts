import { AuthorizedAgentDirectoryCache } from './AuthorizedAgentDirectoryCache';
import { APIError } from './HTTP';
import {
  SessionIdentityClient, type DirectoryAgent, type ResolvedSession, type SessionIdentity,
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

  async resolve(name: string, requireFresh = false): Promise<ResolvedSession> {
    if (!name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new APIError(400, 'invalid_recipient_name', 'Recipient name must be a single short line.');
    }

    const requested = RecipientDirectory.normalize(name);
    const candidates = requireFresh
      ? await this.address.listAgents()
      : await AuthorizedAgentDirectoryCache.shared.read(
        await this.address.directoryCacheScope(this.identity.organizationID),
        () => this.address.listAgents(),
      );
    const findMatches = (directory: DirectoryAgent[]) => directory.filter((agent) =>
      RecipientDirectory.normalize(agent.displayName ?? '') === requested ||
      RecipientDirectory.normalize(agent.handle) === requested);

    let matches = findMatches(candidates);

    // A newly enrolled office Agent may be absent from another isolate's
    // 15-second OAuth-scoped snapshot. Refresh a miss before returning 404.
    if (!requireFresh && matches.length === 0) {
      matches = findMatches(await this.address.listAgents());
    }

    if (matches.length === 0) {
      throw new APIError(404, 'recipient_name_not_found',
        'No registered colleague matches that visible name. Ask the user to check the Bot.');
    }

    if (matches.length > 1) {
      throw new APIError(409, 'recipient_name_ambiguous',
        'Several colleagues share that name. Ask which Bot is intended.');
    }

    const [agent] = matches;

    if (!agent.defaultSessionID || !agent.defaultSessionHandle) {
      throw new APIError(409, 'recipient_name_not_ready',
        'The named colleague does not have an available default Session.');
    }

    // Agent Address returns the verified default Session together with its
    // Organization-scoped Agent record. One directory call resolves the full
    // target deterministically; no second lookup or Gateway LLM turn.
    return {
      id: agent.defaultSessionID,
      agentId: agent.id,
      canonical: [
        this.identity.organizationSlug,
        agent.handle,
        agent.defaultSessionHandle,
      ].join('/'),
    };
  }
}
