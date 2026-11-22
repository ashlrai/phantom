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

  it('treats a concrete team path as a prefix claim against wildcard bus globs', () => {
    const team = row({ origin: 'team', key: 'team:fake/repo::src', repo: 'fake/repo', path: 'src' });
    // 'src' covers the path and everything beneath it; a bus glob that matches
    // any of those paths overlaps even when it cannot match 'src' itself.
    expect(coordinationRowBlocks(team, 'path:fake/repo:src/**')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:src/*.ts')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:**/*.ts')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:src')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:src/x.ts')).toBe(true);
    expect(coordinationRowBlocks(team, 'path:fake/repo:docs/**')).toBe(false);
    expect(coordinationRowBlocks(team, 'path:fake/repo:src2/**')).toBe(false);
  });

  it('keeps prefix coverage when a team path holds literal bracket or brace characters', () => {
    // `[`/`{` are literal under globMatches — `src/[id]` is a concrete
    // directory name (Next.js-style route segments), not a glob, so the
    // team prefix claim still covers everything beneath it.
    const bracket = row({ origin: 'team', key: 'team:fake/repo::src/[id]', repo: 'fake/repo', path: 'src/[id]' });
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:src/[id]/**')).toBe(true);
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:src/[id]/page.tsx')).toBe(true);
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:**/page.tsx')).toBe(true);
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:src/[id]')).toBe(true);
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:docs/**')).toBe(false);
    expect(coordinationRowBlocks(bracket, 'path:fake/repo:src/[id]x/**')).toBe(false);
    const brace = row({ origin: 'team', key: 'team:fake/repo::src/{gen}', repo: 'fake/repo', path: 'src/{gen}' });
    expect(coordinationRowBlocks(brace, 'path:fake/repo:src/{gen}/out.ts')).toBe(true);
    expect(coordinationRowBlocks(brace, 'path:fake/repo:src/other/**')).toBe(false);
  });

  it('blocks wildcard path claims that share a concrete path', () => {
    const held = row({ key: 'path:fake/repo:**/*.ts' });
    expect(coordinationRowBlocks(held, 'path:fake/repo:src/*.ts')).toBe(true);
    expect(coordinationRowBlocks(held, 'path:fake/repo:docs/*.md')).toBe(false);
    expect(coordinationRowBlocks(held, 'path:fake/repo:src/core/**')).toBe(true);
  });

  it('never blocks on queue observations or malformed keys', () => {
    const queued = observeQueuedPaths(new Map([['src/a.ts', ['job-1']]]))[0]!;
    expect(queued.origin).toBe('queue');
    expect(coordinationRowBlocks(queued, 'path:local/queue:src/a.ts')).toBe(false);
    expect(coordinationRowBlocks(row({}), 'not-a-claim-key')).toBe(false);
  });
});
