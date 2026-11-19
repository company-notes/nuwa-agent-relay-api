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

  private static shortNames(displayName: string): string[] {
    // Only structured personal-name components qualify: names before a role
    // separator, an optional parenthesized alternate name, and a Latin given name.
    const personal = RecipientDirectory.normalize(displayName).split(/[|·]/u, 1)[0].trim();
    const parts = personal.match(/^([^()]+?)(?:\s*\(([^()]+)\))?$/u);

    if (!parts) {
      return [];
    }

    const names = [parts[1], parts[2] ?? ''].map((part) => part.trim()).filter(Boolean);
    const givenNames = names.flatMap((part) => {
      const match = part.match(/^([\p{Script=Latin}]+)\s+[\p{Script=Latin}]+(?:\s+[\p{Script=Latin}]+)*$/u);

      return match ? [match[1]] : [];
    });

    return [...names, ...givenNames];
  }

  async resolve(
    name: string, { requireFresh = false, allowShortNames = false } = {},
  ): Promise<ResolvedSession> {
    if (!name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new APIError(400, 'invalid_recipient_name', 'Recipient name must be a single short line.');
    }

    const requested = RecipientDirectory.normalize(name);
    const scope = await this.address.directoryCacheScope(
      this.identity.organizationID, this.identity.organizationIdentityRevision,
    );
    const load = () => this.address.listAgents();
    const candidates = await AuthorizedAgentDirectoryCache.shared.read(scope, load, requireFresh);
    const findMatches = (directory: DirectoryAgent[]) => directory.filter((agent) =>
      RecipientDirectory.normalize(agent.displayName ?? '') === requested ||
      RecipientDirectory.normalize(agent.handle) === requested);

    let matches = findMatches(candidates);

    // The existing authorization carries the authoritative revision. A rename,
    // registration, archive or default change invalidates the directory key.
    // Exact and short names use the same complete snapshot, including unavailable Agents.
    if (allowShortNames && matches.length === 0) {
      matches = candidates.filter((agent) =>
        RecipientDirectory.shortNames(agent.displayName ?? '').includes(requested));
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
