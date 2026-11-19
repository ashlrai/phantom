import { describe, expect, it } from 'vitest';
import { coordinationRowBlocks, observeQueuedPaths, type CoordinationView } from '../src/core/agents/claim-store.js';

const row = (over: Partial<CoordinationView>): CoordinationView => ({
  origin: 'resource', key: 'repo:fake/repo', owner: 'fake-owner', leaseUntil: 2_000,
  sourceId: 'work:fake', live: true, repo: null, branch: null, path: null, started: null,
  ...over,
});

describe('coordinationRowBlocks', () => {
  it('blocks equal and overlapping claim keys only while the row is live', () => {
    const live = row({});
    expect(coordinationRowBlocks(live, 'repo:fake/repo')).toBe(true);
    expect(coordinationRowBlocks(live, 'path:fake/repo:src/**')).toBe(true);
    expect(coordinationRowBlocks(live, 'repo:fake/other')).toBe(false);
    expect(coordinationRowBlocks(live, 'queue:q1')).toBe(false);
    expect(coordinationRowBlocks(row({ live: false }), 'repo:fake/repo')).toBe(false);
  });

  it('honors team targets the same way acquisition does', () => {
    const team = row({ origin: 'team', key: 'team:fake/repo::src/**', repo: 'fake/repo', path: 'src/**' });
    expect(coordinationRowBlocks(team, 'path:fake/repo:src/a.ts')).toBe(true);
    expect(coordinationRowBlocks(team, 'repo:fake/repo')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:docs/x.md')).toBe(false);
    expect(coordinationRowBlocks(team, 'queue:q1')).toBe(false);
    expect(coordinationRowBlocks(team, 'repo:fake/other')).toBe(false);
  });

  it('never blocks on queue observations or malformed keys', () => {
    const queued = observeQueuedPaths(new Map([['src/a.ts', ['job-1']]]))[0]!;
    expect(queued.origin).toBe('queue');
    expect(coordinationRowBlocks(queued, 'path:local/queue:src/a.ts')).toBe(false);
    expect(coordinationRowBlocks(row({}), 'not-a-claim-key')).toBe(false);
  });
});
