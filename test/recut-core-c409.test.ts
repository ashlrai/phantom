import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRepo, readCache, summarize, type CockpitPr } from '../src/core/merge-cockpit.js';
import type { Gh } from '../src/core/autopilot/github.js';

const pr = (number: number, body: string, mergeable = 'MERGEABLE'): CockpitPr => ({
  number, title: 'work', body, mergeable, checks: 'SUCCESS', autoMerge: false,
});
const page = (nodes: unknown[], endCursor: string | null) => JSON.stringify({
  data: { rateLimit: { remaining: 10 }, repository: { pullRequests: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } },
});
const node = (number: number, body: string, mergeable = 'MERGEABLE') => ({
  number, title: 'work', body, mergeable, autoMergeRequest: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
});

describe('recut c409 merge cockpit evidence', () => {
  it('drops self-edges, keeps one edge per rework-original pair and honors case', () => {
    const snapshot = {
      repo: 'other/repo', observedAt: '2026-11-15T00:00:00Z',
      prs: [
        pr(10, 'reworks #10'), // self-edge never an edge
        pr(11, 'REWORKS #44'),
        pr(12, 'reworks #44'), // same original, different rework is a second edge
        pr(44, ''),
      ],
    };
    expect(summarize(snapshot)).toMatchObject({
      open: 4, conflicting: 0, held: [],
      edges: [
        { rework: 11, original: 44, originalHeld: false },
        { rework: 12, original: 44, originalHeld: false },
      ],
    });
  });

  it('rejects malformed PR nodes and a repeated cursor instead of reporting partial data', async () => {
    const gh: Gh = async () => page([{ number: 0, title: 'work', body: '', mergeable: 'MERGEABLE', autoMergeRequest: null, commits: { nodes: [] } }], null);
    await expect(fetchRepo('other/repo', gh)).rejects.toThrow('invalid PR');
    const stuck: Gh = async () => page([node(5, '')], 'same');
    await expect(fetchRepo('other/repo', stuck)).rejects.toThrow('invalid cursor');
  });

  it('returns an empty cache on corrupt data and drops malformed snapshots only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c409-cockpit-'));
    try {
      const path = join(dir, 'cache.json');
      await writeFile(path, '{broken');
      expect(await readCache(path)).toEqual({ version: 1, snapshots: [] });
      await writeFile(path, JSON.stringify({ version: 2, snapshots: [] }));
      expect((await readCache(path)).snapshots).toEqual([]);
      await writeFile(path, JSON.stringify({
        version: 1,
        snapshots: [
          { repo: 'a/b', observedAt: '2026-11-15T00:00:00Z', prs: [pr(1, 'reworks #2')] },
          { repo: 7, observedAt: 'x', prs: 'nope' },
          { repo: 'a/b', observedAt: '2026-11-15T01:00:00Z', prs: [{ number: 'x', title: 't', body: '' }] },
        ],
      }));
      expect((await readCache(path)).snapshots).toEqual([
        { repo: 'a/b', observedAt: '2026-11-15T00:00:00Z', prs: [{ number: 1, title: 'work', body: 'reworks #2', mergeable: 'MERGEABLE', checks: 'SUCCESS', autoMerge: false }] },
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
