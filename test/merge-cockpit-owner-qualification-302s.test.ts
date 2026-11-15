import { describe, expect, it } from 'vitest';
import { fetchRepo, summarize } from '../src/core/merge-cockpit.js';
import type { Gh } from '../src/core/autopilot/github.js';

const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null, remaining = 10) => JSON.stringify({
  data: { rateLimit: { remaining }, repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } },
});
const pr = (number: number, title: string, body: string, mergeable: string, checks: string | null, autoMerge = false) => ({
  number, title, body, mergeable, autoMergeRequest: autoMerge ? { enabledAt: '2026-11-01T00:00:00Z' } : null,
  commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] },
});

describe('merge cockpit owner qualification (PR #5264 preservation)', () => {
  it('paginates to summary through the real fetchRepo with read-only GraphQL arguments and deterministic observedAt', async () => {
    const calls: string[][] = [];
    const gh: Gh = async args => {
      calls.push(args);
      return calls.length === 1
        ? page([pr(1, 'first', '', 'MERGEABLE', 'SUCCESS')], true, 'cursor-a')
        : page([pr(2, 'second', '', 'CONFLICTING', null), pr(3, 'third', '', 'UNKNOWN', 'FAILURE', true)], false, null);
    };
    const snapshot = await fetchRepo('ashlrai/phantom', gh, new Date('2026-11-13T12:00:00Z'));

    expect(snapshot.observedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(snapshot.prs.map(p => p.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);

    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
      const fields = args.slice(2);
      expect(fields.length % 2).toBe(0);
      for (let i = 0; i < fields.length; i += 2) expect(fields[i]).toBe('-f');
      const query = fields[fields.indexOf('-f') + 1]!;
      expect(query).toMatch(/^query=query\(/);
      expect(query).not.toMatch(/\bmutation\b/i);
      expect(query).toContain('pullRequests');
      expect(query).toContain('states:OPEN');
      expect(query).toContain('rateLimit');
      expect(args).toContain('owner=ashlrai');
      expect(args).toContain('name=phantom');
      expect(args.some(a => /--method|-X|POST|PATCH|PUT|DELETE/i.test(a))).toBe(false);
    }
    expect(calls[1]).toContain('cursor=cursor-a');
    expect(calls[0]).not.toContain('cursor=cursor-a');

    expect(summarize(snapshot)).toMatchObject({
      open: 3, conflicting: 1, green: 1, autoMerge: 1,
      unknownMergeable: 1, unknownChecks: 1, held: [], edges: [],
    });
  });

  it('extracts rework edges from title and body, dedupes pairs and suppresses self-edges', async () => {
    const gh: Gh = async () => page([
      pr(10, 'Reworks #20', 'also reworks #20 and reworks #21', 'MERGEABLE', 'SUCCESS'),
      pr(30, 'unrelated', 'Reworks #10 Reworks #10', 'MERGEABLE', 'SUCCESS'),
      pr(40, 'Reworks #40', '', 'MERGEABLE', 'SUCCESS'),
      pr(50, 'held original', 'reworks #1228', 'MERGEABLE', 'SUCCESS'),
      pr(60, 'unheld original', 'REWORKS   #999', 'MERGEABLE', 'SUCCESS'),
    ]);
    const snapshot = await fetchRepo('ashlrai/phantom', gh, new Date('2026-11-13T00:00:00Z'));
    expect(summarize(snapshot).edges).toEqual([
      { rework: 10, original: 20, originalHeld: false },
      { rework: 10, original: 21, originalHeld: false },
      { rework: 30, original: 10, originalHeld: false },
      { rework: 50, original: 1228, originalHeld: true },
      { rework: 60, original: 999, originalHeld: false },
    ]);
  });

  it('keeps null checks and nonstandard mergeable values unknown and propagates held originals', async () => {
    const gh: Gh = async () => page([
      pr(197, 'held open PR', '', 'UNKNOWN', null),
      pr(500, 'rework of held', 'Reworks #197', 'BLOCKED', null),
      pr(501, 'conflicting', 'Reworks #725', 'CONFLICTING', 'FAILURE'),
      pr(502, 'mergeable green', 'Reworks #693', 'MERGEABLE', 'SUCCESS'),
    ]);
    const snapshot = await fetchRepo('ashlrai/phantom', gh, new Date('2026-11-13T00:00:00Z'));
    expect(summarize(snapshot)).toMatchObject({
      open: 4, conflicting: 1, green: 1, autoMerge: 0,
      unknownMergeable: 2, unknownChecks: 2,
      held: [197],
      edges: [
        { rework: 500, original: 197, originalHeld: true },
        { rework: 501, original: 725, originalHeld: true },
        { rework: 502, original: 693, originalHeld: true },
      ],
    });
    expect(snapshot.prs[2]!.checks).toBe('FAILURE');
    expect(snapshot.prs[3]!.checks).toBe('SUCCESS');
  });

  it('reports no holds or held edges for repositories outside the hold list', async () => {
    const gh: Gh = async () => page([pr(7, 't', 'Reworks #197', 'MERGEABLE', 'SUCCESS')]);
    const snapshot = await fetchRepo('example/other', gh, new Date('2026-11-13T00:00:00Z'));
    expect(summarize(snapshot)).toMatchObject({
      held: [], edges: [{ rework: 7, original: 197, originalHeld: false }],
    });
  });
});
