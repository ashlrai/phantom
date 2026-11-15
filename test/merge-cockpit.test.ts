import { describe, expect, it } from 'vitest';
import { fetchRepo, readCache, summarize, writeCache } from '../src/core/merge-cockpit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pr = (number: number, body = '') => ({ number, title: 'work', body, mergeable: 'CONFLICTING', autoMergeRequest: {}, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } });
describe('merge cockpit', () => {
  it('paginates, counts observations and maps held originals once', async () => {
    const calls: string[][] = [];
    const result = await fetchRepo('ashlrai/phantom', async args => {
      calls.push(args);
      return JSON.stringify({ data: { rateLimit: { remaining: 20 }, repository: { pullRequests: { nodes: calls.length === 1 ? [pr(197), pr(200, 'reworks #197\nReworks #197')] : [pr(201)], pageInfo: { hasNextPage: calls.length === 1, endCursor: 'next' } } } } });
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('cursor=next');
    expect(summarize(result)).toMatchObject({ open: 3, conflicting: 3, green: 3, autoMerge: 3, held: [197], edges: [{ rework: 200, original: 197, originalHeld: true }] });
  });
  it('rejects incomplete pages rather than reporting partial counts', async () => {
    await expect(fetchRepo('ashlrai/phantom', async () => JSON.stringify({ data: { rateLimit: { remaining: 0 }, repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'a' } } } } }))).rejects.toThrow('rate limit');
  });
  it('round trips a private cache and tolerates missing data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cockpit-'));
    try {
      const path = join(dir, 'cache.json');
      expect((await readCache(path)).snapshots).toEqual([]);
      await writeCache(path, { version: 1, snapshots: [{ repo: 'ashlrai/phantom', observedAt: '2026-01-01T00:00:00Z', prs: [] }] });
      expect((await readCache(path)).snapshots).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
