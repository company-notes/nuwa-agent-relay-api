import { describe, expect, it } from 'vitest';

import { AuthorizedAgentDirectoryCache } from '../src/AuthorizedAgentDirectoryCache';
import type { DirectoryAgent } from '../src/SessionIdentityClient';

describe('authorized directory cache lifecycle', () => {
  it('reuses a completed snapshot and replaces it on a fresh discovery or expiry', async () => {
    let now = 0;
    const cache = new AuthorizedAgentDirectoryCache(() => now);
    let calls = 0;
    let directory: DirectoryAgent[] = [{
      id: 'agent-a', handle: 'alice', displayName: 'Alice',
      defaultSessionID: 'session-a', defaultSessionHandle: 'main',
    }];
    const load = async () => {
      calls += 1;

      return directory;
    };

    await cache.read('grant-a', load);
    expect(await cache.read('grant-a', load)).toEqual(directory);
    expect(calls).toBe(1);

    directory = [...directory, {
      id: 'agent-b', handle: 'bob', displayName: 'Bob',
      defaultSessionID: 'session-b', defaultSessionHandle: 'main',
    }];
    expect(await cache.read('grant-a', load, true)).toHaveLength(2);
    expect(await cache.read('grant-a', load)).toHaveLength(2);
    expect(calls).toBe(2);

    await cache.read('grant-b', load);
    expect(calls).toBe(3);

    now += 15_001;
    await cache.read('grant-a', load);
    expect(calls).toBe(4);
  });

  it('does not share an unfinished directory request with another invocation', async () => {
    const cache = new AuthorizedAgentDirectoryCache();
    let complete!: (value: DirectoryAgent[]) => void;
    const pending = new Promise<DirectoryAgent[]>((resolve) => {
      complete = resolve;
    });
    const first = cache.read('grant-a', () => pending);

    let secondLoaded = false;
    const second = cache.read('grant-a', async () => {
      secondLoaded = true;

      return [];
    });

    try {
      expect(secondLoaded, 'A second invocation must own its request I/O').toBe(true);
      expect(await second).toEqual([]);
    } finally {
      complete([]);
      await Promise.all([first, second]);
    }
  });
});
