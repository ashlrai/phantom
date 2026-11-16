import { describe, expect, it } from 'vitest';
import { fetchRepo, summarize } from '../src/core/merge-cockpit.js';
import type { Gh } from '../src/core/autopilot/github.js';

const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null, remaining = 10) => JSON.stringify({
  data: { rateLimit: { remaining }, repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } },
});
const pr = (number: number, body: string, mergeable: string, checks: string | null) => ({
  number, title: 'work', body, mergeable, autoMergeRequest: null,
  commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] },
});

describe('recovered merge cockpit evidence', () => {
  it('summarizes all fetched pages with original identity, holds and unknowns', async () => {
    const calls: string[][] = [];
    const gh: Gh = async args => {
      calls.push(args);
      return calls.length === 1
        ? page([pr(197, '', 'UNKNOWN', null)], true, 'next')
        : page([pr(500, 'Reworks #197', 'MERGEABLE', 'SUCCESS')], false, null);
    };
    const snapshot = await fetchRepo('ashlrai/phantom', gh, new Date('2026-11-05T00:00:00Z'));
    expect(snapshot.observedAt).toBe('2026-11-05T00:00:00.000Z');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('cursor=next');
    expect(calls.every(args => args[0] === 'api' && args[1] === 'graphql')).toBe(true);
    expect(summarize(snapshot)).toMatchObject({ open: 2, unknownMergeable: 1, unknownChecks: 1, held: [197], edges: [{ original: 197, rework: 500, originalHeld: true }] });
  });

  it('rejects incomplete, rate-limited and bounded-out snapshots', async () => {
    await expect(fetchRepo('ashlrai/phantom', async () => JSON.stringify({ errors: [{ message: 'partial' }], data: {} }))).rejects.toThrow('incomplete');
    await expect(fetchRepo('ashlrai/phantom', async () => page([], true, 'next', 0))).rejects.toThrow('rate limit');
    let count = 0;
    await expect(fetchRepo('ashlrai/phantom', async () => page([], true, String(++count)))).rejects.toThrow('page limit');
    expect(count).toBe(20);
  });

  it('keeps missing check and mergeable data unknown and rejects malformed pages', async () => {
    const bare = { number: 9, title: 't', body: '', mergeable: 'UNKNOWN', autoMergeRequest: null, commits: { nodes: [] } };
    const snapshot = await fetchRepo('ashlrai/phantom', async () => page([bare], false, null));
    expect(snapshot.prs[0]).toMatchObject({ checks: null, autoMerge: false });
    expect(summarize(snapshot)).toMatchObject({ open: 1, green: 0, conflicting: 0, unknownMergeable: 1, unknownChecks: 1, held: [], edges: [] });
    await expect(fetchRepo('ashlrai/phantom', async () => JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }))).rejects.toThrow('incomplete');
    await expect(fetchRepo('ashlrai/phantom', async () => page([pr(1, '', 'MERGEABLE', null)], true, null))).rejects.toThrow('invalid cursor');
    await expect(fetchRepo('ashlrai/phantom', async () => page([pr(1, '', 'MERGEABLE', null)], true, 'same'), new Date()).then(() => 'ok')).rejects.toThrow('invalid cursor');
  });
});
