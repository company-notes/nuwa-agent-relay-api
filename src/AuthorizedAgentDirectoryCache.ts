import type { DirectoryAgent } from './SessionIdentityClient';

/**
 * A short-lived, per-authorization directory snapshot for name-only routing.
 * The caller validates OAuth, Organization and Runtime on every Relay request
 * before reaching this cache. Never store bearer tokens or use an Organization
 * alone as a cache key.
 */
export class AuthorizedAgentDirectoryCache {
  static readonly shared = new AuthorizedAgentDirectoryCache();

  private static readonly ttlMS = 15_000;
  private static readonly maxEntries = 128;

  private readonly entries = new Map<string, {
    expiresAt: number;
    agents: DirectoryAgent[];
  }>();
  private readonly pending = new Map<string, Promise<DirectoryAgent[]>>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async read(
    scope: string, load: () => Promise<DirectoryAgent[]>,
  ): Promise<DirectoryAgent[]> {
    const now = this.clock();
    const cached = this.entries.get(scope);

    if (cached && cached.expiresAt > now) {
      // Reinsert on a hit so the oldest entry is evicted first.
      this.entries.delete(scope);
      this.entries.set(scope, cached);

      return cached.agents;
    }

    const inFlight = this.pending.get(scope);

    if (inFlight) {
      return inFlight;
    }

    const request = load().then((agents) => {
      this.entries.delete(scope);
      this.entries.set(scope, {
        expiresAt: this.clock() + AuthorizedAgentDirectoryCache.ttlMS,
        agents,
      });

      while (this.entries.size > AuthorizedAgentDirectoryCache.maxEntries) {
        const oldest = this.entries.keys().next().value;

        if (oldest === undefined) {
          break;
        }

        this.entries.delete(oldest);
      }

      return agents;
    }).finally(() => {
      this.pending.delete(scope);
    });

    this.pending.set(scope, request);

    return request;
  }

  /** Clear the isolated in-memory cache between Worker/D1 test scenarios. */
  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}
