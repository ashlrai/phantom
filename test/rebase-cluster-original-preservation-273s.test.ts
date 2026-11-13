import { describe, expect, it } from 'vitest';
import { clusterKey, fileClusters } from '../src/core/fleet/rebase-order.js';
import {
  runQueuegenCycle,
  QUEUEGEN_PR_WINDOW_MS,
  type QueuegenIo, type QueuegenPr, type QueuegenState,
} from '../src/core/drive/queuegen.js';

const NOW = 1_700_000_000_000;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const pr = (over: Partial<QueuegenPr>): QueuegenPr => ({
  number: 1,
  headRef: 'fleet/fix-broken',
  headSha: sha('a'),
  baseRef: 'main',
  baseSha: sha('b'),
  mergeState: 'UNSTABLE',
  inMergeQueue: false,
  author: 'ashlr-fleet[bot]',
  files: ['src/cli/first.ts', 'src/core/second.ts'],
  filesTruncated: false,
  ...over,
});

interface Fake {
  io: QueuegenIo;
  lines: string[];
  state: () => QueuegenState | undefined;
}

function makeIo(options: {
  prs?: Map<string, QueuegenPr[]>;
  conflicts?: Map<string, string[]>;
  checks?: Map<string, { id: number; name: string; status: string; conclusion: string | null; required: boolean }[]>;
  logs?: Map<string, string>;
  hold?: Set<string>;
  queueIds?: Set<string>;
  state?: unknown;
  now?: number;
}): Fake {
  const lines: string[] = [];
  const now = options.now ?? NOW;
  let state = options.state;
  const io: QueuegenIo = {
    listPullRequests: (repo) => options.prs?.get(repo) ?? [],
    checks: (repo, p) => options.checks?.get(`${repo}#${p.number}`) ?? [],
    checkLogTail: (repo, p, c) => options.logs?.get(`${repo}#${p.number}/${c.name}`) ?? '',
    conflictFiles: (repo, p) => options.conflicts?.get(`${repo}#${p.number}`) ?? [],
    readQueueIds: () => new Set(options.queueIds ?? []),
    appendQueueLine: (line) => { lines.push(line); },
    readHoldList: () => new Set(options.hold ?? []),
    loadState: () => state,
    saveState: (s) => { state = s; },
    log: () => {},
    now: () => now,
  };
  return { io, lines, state: () => state as QueuegenState | undefined };
}

const key = (line: string): string | undefined => /cluster=(clu-\d+)/.exec(line)?.[1];

describe('fileClusters (original #4079 scenarios)', () => {
  const item = (id: number, files: string[]) => ({ id, files });

  it('groups transitively overlapping file sets into one cluster', () => {
    const got = fileClusters([
      item(1, ['src/a.ts']), item(2, ['src/a.ts', 'src/b.ts']),
      item(3, ['src/b.ts']), item(4, ['docs/z.md']),
    ]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[1, 2, 3], [4]]);
  });

  it('keeps empty file sets as singletons that never merge', () => {
    const got = fileClusters([item(1, []), item(2, []), item(3, ['x'])]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[1], [2], [3]]);
  });

  it('is deterministic under a deterministic input order', () => {
    const got = fileClusters([item(9, ['y']), item(2, ['x', 'y']), item(7, ['z'])]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[9, 2], [7]]);
  });

  it('clusterKey is the lowest member id', () => {
    expect(clusterKey([41, 9, 12])).toBe('clu-9');
    expect(clusterKey([5])).toBe('clu-5');
  });
});

describe('queuegen REBASE cluster stamping', () => {
  it('stamps a shared cluster= key on sibling REBASE lines and a distinct key on disjoint ones', () => {
    const prs = [
      pr({ number: 1, mergeState: 'DIRTY', files: ['src/a.ts'] }),
      pr({ number: 2, mergeState: 'DIRTY', headSha: sha('c'), files: ['src/a.ts', 'src/b.ts'] }),
      pr({ number: 3, mergeState: 'DIRTY', headSha: sha('d'), files: ['docs/z.md'] }),
    ];
    const { io, lines } = makeIo({
      prs: new Map([['ashlrai/phantom', prs]]),
      conflicts: new Map([
        ['ashlrai/phantom#1', ['src/a.ts']],
        ['ashlrai/phantom#2', ['src/b.ts']],
        ['ashlrai/phantom#3', ['docs/z.md']],
      ]),
    });
    expect(runQueuegenCycle(io, { repos: ['ashlrai/phantom'] }).emitted).toBe(3);
    expect(key(lines[0]!)).toBe('clu-1');
    expect(key(lines[1]!)).toBe('clu-1');   // shares src/a.ts with #1
    expect(key(lines[2]!)).toBe('clu-3');   // disjoint file set: its own cluster
    expect(lines[0]).toMatch(/repo=phantom, cluster=clu-1, after none/);
  });

  it('clusters transitively through a clean sibling: same files, same key', () => {
    const prs = [
      pr({ number: 1, mergeState: 'DIRTY', files: ['src/a.ts'] }),
      pr({ number: 2, mergeState: 'UNSTABLE', headSha: sha('c'), files: ['src/a.ts', 'src/b.ts'] }),
      pr({ number: 3, mergeState: 'DIRTY', headSha: sha('d'), files: ['src/b.ts'] }),
    ];
    const { io, lines } = makeIo({
      prs: new Map([['ashlrai/phantom', prs]]),
      conflicts: new Map([
        ['ashlrai/phantom#1', ['src/a.ts']],
        ['ashlrai/phantom#3', ['src/b.ts']],
      ]),
    });
    // #2 emits nothing (no failing required check) but still bridges #1 and #3.
    expect(runQueuegenCycle(io, { repos: ['ashlrai/phantom'] }).emitted).toBe(2);
    expect(key(lines[0]!)).toBe('clu-1');
    expect(key(lines[1]!)).toBe('clu-1');
  });

  it('keeps empty-file and held-out siblings in their own clusters', () => {
    const prs = [
      pr({ number: 1, mergeState: 'DIRTY', files: [] }),
      pr({ number: 2, mergeState: 'DIRTY', headSha: sha('c'), files: [] }),
      pr({ number: 3, mergeState: 'DIRTY', headSha: sha('d'), files: ['src/a.ts'] }),
      pr({ number: 4, mergeState: 'DIRTY', headSha: sha('e'), files: ['src/a.ts'] }),
    ];
    const { io, lines } = makeIo({
      prs: new Map([['ashlrai/phantom', prs]]),
      conflicts: new Map([
        ['ashlrai/phantom#1', ['src/x.ts']],
        ['ashlrai/phantom#2', ['src/y.ts']],
        ['ashlrai/phantom#3', ['src/a.ts']],
        ['ashlrai/phantom#4', ['src/a.ts']],
      ]),
    });
    expect(runQueuegenCycle(io, { repos: ['ashlrai/phantom'] }).emitted).toBe(4);
    // Empty touched-file lists are singletons and never merge, even with each other.
    expect(key(lines[0]!)).toBe('clu-1');
    expect(key(lines[1]!)).toBe('clu-2');
    // The overlapping pair shares the lowest member number.
    expect(key(lines[2]!)).toBe('clu-3');
    expect(key(lines[3]!)).toBe('clu-3');
  });

  it('does not mix cluster keys across repositories', () => {
    const { io, lines } = makeIo({
      prs: new Map([
        ['ashlrai/phantom', [pr({ number: 7, mergeState: 'DIRTY', files: ['src/a.ts'] })]],
        ['ashlrai/locus', [pr({ number: 3, mergeState: 'DIRTY', files: ['src/a.ts'] })]],
      ]),
      conflicts: new Map([
        ['ashlrai/phantom#7', ['src/a.ts']],
        ['ashlrai/locus#3', ['src/a.ts']],
      ]),
    });
    expect(runQueuegenCycle(io, { repos: ['ashlrai/phantom', 'ashlrai/locus'] }).emitted).toBe(2);
    expect(key(lines[0]!)).toBe('clu-7');
    expect(key(lines[1]!)).toBe('clu-3');
    expect(lines[0]).toContain('repo=phantom');
    expect(lines[1]).toContain('repo=locus');
  });

  it('leaves FIXUP lines unchanged: no cluster attribute', () => {
    const { io, lines } = makeIo({
      prs: new Map([['ashlrai/phantom', [
        pr({ number: 1, files: ['src/x.ts'] }),
        pr({ number: 2, headSha: sha('c'), files: ['src/x.ts'] }),
      ]]]),
      checks: new Map([
        ['ashlrai/phantom#1', [{ id: 1, name: 'typecheck', status: 'completed', conclusion: 'failure', required: true }]],
        ['ashlrai/phantom#2', [{ id: 2, name: 'typecheck', status: 'completed', conclusion: 'failure', required: true }]],
      ]),
      logs: new Map([
        ['ashlrai/phantom#1/typecheck', 'ERROR src/x.ts:1: bad'],
        ['ashlrai/phantom#2/typecheck', 'ERROR src/x.ts:2: bad'],
      ]),
    });
    expect(runQueuegenCycle(io, { repos: ['ashlrai/phantom'] }).emitted).toBe(2);
    for (const line of lines) {
      expect(line).toContain('FIXUP');
      expect(line).not.toContain('cluster=');
      expect(line).toMatch(/repo=phantom, after none/);
    }
  });

  it('repeat cycles preserve dedupe and the cycle cap with cluster stamping', () => {
    const prs = [
      pr({ number: 1, mergeState: 'DIRTY', files: ['src/a.ts'] }),
      pr({ number: 2, mergeState: 'DIRTY', headSha: sha('c'), files: ['src/a.ts'] }),
    ];
    const options = {
      prs: new Map([['ashlrai/phantom', prs]]),
      conflicts: new Map([
        ['ashlrai/phantom#1', ['src/a.ts']],
        ['ashlrai/phantom#2', ['src/a.ts']],
      ]),
    };
    const fake = makeIo(options);
    expect(runQueuegenCycle(fake.io, { repos: ['ashlrai/phantom'] })).toMatchObject({ emitted: 2, deduped: 0 });
    expect(fake.lines).toHaveLength(2);
    expect(key(fake.lines[0]!)).toBe('clu-1');
    expect(key(fake.lines[1]!)).toBe('clu-1');
    // Second cycle: both ids are already in state/queue -> deduped, no new lines.
    expect(runQueuegenCycle(fake.io, { repos: ['ashlrai/phantom'] })).toMatchObject({ emitted: 0, deduped: 2 });
    expect(fake.lines).toHaveLength(2);
    // Past the window with a fresh queue, both re-emit with the same stable key.
    const again = makeIo({ ...options, state: fake.state(), now: NOW + QUEUEGEN_PR_WINDOW_MS + 1 });
    expect(runQueuegenCycle(again.io, { repos: ['ashlrai/phantom'] })).toMatchObject({ emitted: 2 });
    expect(key(again.lines[0]!)).toBe('clu-1');
    expect(key(again.lines[1]!)).toBe('clu-1');
    // The cap still bounds emissions per cycle.
    const capped = makeIo(options);
    expect(runQueuegenCycle(capped.io, { repos: ['ashlrai/phantom'], cycleCap: 1 })).toMatchObject({ emitted: 1, capped: true });
  });
});
