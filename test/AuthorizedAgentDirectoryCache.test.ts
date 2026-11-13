import { describe, expect, it, vi } from 'vitest';

import { AuthorizedAgentDirectoryCache } from '../src/AuthorizedAgentDirectoryCache';

describe('Short-lived authorized directory caching', () => {
  it('reuses a warm directory, then checks fresh names after expiry', async () => {
    let now = 1000;
    const cache = new AuthorizedAgentDirectoryCache(() => now);
    const read = vi.fn()
      .mockResolvedValueOnce([{ id: 'bear', displayName: '大熊' }])
      .mockResolvedValueOnce([{ id: 'bear', displayName: '新大熊' }]);

    const first = await cache.read('grant-a', read);
    const warm = await cache.read('grant-a', read);

    expect(first).toEqual(warm);
    expect(read).toHaveBeenCalledTimes(1);

    now += 15_001;
    const refreshed = await cache.read('grant-a', read);

    expect(refreshed).toEqual([{ id: 'bear', displayName: '新大熊' }]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('isolates authorization scopes and coalesces parallel reads', async () => {
    const cache = new AuthorizedAgentDirectoryCache();
    const read = vi.fn(async () => []);

    const results = await Promise.all([
      cache.read('grant-a', read),
      cache.read('grant-a', read),
      cache.read('grant-b', read),
    ]);

    expect(results).toEqual([[], [], []]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never caches a rejected authorized directory request', async () => {
    const cache = new AuthorizedAgentDirectoryCache();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Agent Address unavailable'))
      .mockResolvedValueOnce([]);

    await expect(cache.read('grant-a', read)).rejects.toThrow('Agent Address unavailable');
    await expect(cache.read('grant-a', read)).resolves.toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
