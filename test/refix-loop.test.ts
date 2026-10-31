import { describe, expect, it } from 'vitest';
import {
  runRefixCycle, securityPinnedPath, REFIX_REPOS,
  type RefixIo, type RefixPr, type RefixState,
} from '../src/core/drive/refix-loop.js';

const NOW = 1_700_000_000_000;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const pr = (over: Partial<RefixPr>): RefixPr => ({
  number: 1,
  headSha: sha('a'),
  mergeState: 'CLEAN',
  inMergeQueue: false,
  author: 'ashlr-fleet[bot]',
  files: [],
  filesTruncated: false,
  ...over,
});

interface Fake {
  io: RefixIo;
  calls: string[];
  lines: string[];
  state: () => RefixState | undefined;
  setPrs: (repo: string, prs: RefixPr[]) => void;
}

function makeIo(options: {
  prs?: Map<string, RefixPr[]>;
  redChecks?: Set<string>;
  hold?: Set<string>;
  queueIds?: Set<string>;
  failList?: Set<string>;
  holdThrows?: boolean;
  now?: number;
}): Fake {
  const calls: string[] = [];
  const lines: string[] = [];
  let state: RefixState | undefined;
  const prs = options.prs ?? new Map<string, RefixPr[]>();
  const io: RefixIo = {
    listPullRequests: (repo) => {
      calls.push(`list ${repo}`);
      if (options.failList?.has(repo)) throw new Error('gh failed');
      return prs.get(repo) ?? [];
    },
    updateBranch: (repo, n) => { calls.push(`update-branch ${repo}#${n}`); },
    requiredCheckRed: (repo, n) => {
      calls.push(`checks ${repo}#${n}`);
      return options.redChecks?.has(`${repo}#${n}`) ?? false;
    },
    readQueueIds: () => new Set(options.queueIds ?? []),
    appendQueueLine: (line) => { lines.push(line); },
    readHoldList: () => {
      if (options.holdThrows) throw new Error('unreadable');
      return new Set(options.hold ?? []);
    },
    loadState: () => state,
    saveState: (s) => { state = s; },
    log: (line) => { calls.push(`log ${line}`); },
    now: () => options.now ?? NOW,
  };
  return {
    io, calls, lines,
    state: () => state,
    setPrs: (repo, next) => { prs.set(repo, next); },
  };
}

const updateCalls = (calls: string[]) => calls.filter((c) => c.startsWith('update-branch '));
const drainLines = (lines: string[]) => lines.map((l) => JSON.parse(l) as { id: string });
const logs = (calls: string[], prefix: string) =>
  calls.filter((c) => c === `log ${prefix}` || c.startsWith(`log ${prefix} `));

describe('refix-loop dispatchd cycle', () => {
  it('update-branches BEHIND fleet PRs not queued/held; drains DIRTY and red-check PRs', () => {
    const prs = new Map<string, RefixPr[]>([
      ['ashlrai/phantom', [
        pr({ number: 1, mergeState: 'BEHIND' }),
        pr({ number: 2, mergeState: 'BEHIND', inMergeQueue: true }),
        pr({ number: 3, mergeState: 'DIRTY', headSha: sha('b') }),
        pr({ number: 4, mergeState: 'CLEAN' }),
        pr({ number: 5, mergeState: 'CLEAN' }),
        pr({ number: 6, mergeState: 'BEHIND', author: 'someone-else' }),
        pr({ number: 7, mergeState: 'BEHIND' }),
        pr({ number: 8, mergeState: 'DIRTY' }),
        pr({ number: 10, mergeState: 'BEHIND', headSha: sha('c') }),
      ]],
      ['ashlrai/phantom-secrets', [pr({ number: 7, mergeState: 'DIRTY', headSha: sha('d') })]],
    ]);
    const red = new Set(['ashlrai/phantom#4', 'ashlrai/phantom#10']);
    const hold = new Set(['phantom#7', 'phantom#8']);
    const fake = makeIo({ prs, redChecks: red, hold });

    const summary = runRefixCycle(fake.io);

    expect(summary).toMatchObject({ updated: 2, drains: 4, giveups: 0, capped: false });
    expect(updateCalls(fake.calls)).toEqual([
      'update-branch ashlrai/phantom#1',
      'update-branch ashlrai/phantom#10',
    ]);
    expect(drainLines(fake.lines).map((l) => l.id)).toEqual([
      'RQ-DRAIN-phantom-3-bbbbbbb',
      'RQ-DRAIN-phantom-4-aaaaaaa',
      'RQ-DRAIN-phantom-10-ccccccc',
      'RQ-DRAIN-phantom-secrets-7-ddddddd',
    ]);
    // Hold-listed and non-fleet PRs are never touched by any gh call.
    for (const tag of ['#7', '#8']) {
      expect(fake.calls).not.toContain(`update-branch ashlrai/phantom${tag}`);
      expect(fake.calls).not.toContain(`checks ashlrai/phantom${tag}`);
    }
    expect(fake.calls).not.toContain('checks ashlrai/phantom#6');
    expect(logs(fake.calls, 'REFIX_CYCLE')).toHaveLength(1);
  });

  it('is idempotent by key on a second run', () => {
    const prs = new Map([['ashlrai/phantom', [pr({ number: 3, mergeState: 'DIRTY' })]]]);
    const fake = makeIo({ prs });
    runRefixCycle(fake.io);
    expect(fake.lines).toHaveLength(1);
    const again = runRefixCycle(fake.io);
    expect(again.drains).toBe(0);
    expect(fake.lines).toHaveLength(1);
    // An id already present in the queue file itself is also skipped.
    const preloaded = makeIo({
      prs,
      queueIds: new Set(['RQ-DRAIN-phantom-3-aaaaaaa']),
    });
    expect(runRefixCycle(preloaded.io).drains).toBe(0);
    expect(preloaded.lines).toHaveLength(0);
  });

  it('caps new drain lines at 20 per cycle', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      pr({ number: 100 + i, mergeState: 'DIRTY', headSha: sha(`${i % 10}`) }));
    const fake = makeIo({ prs: new Map([['ashlrai/locus', many]]) });
    const summary = runRefixCycle(fake.io, { repos: ['ashlrai/locus'] });
    expect(summary.drains).toBe(20);
    expect(summary.capped).toBe(true);
    expect(fake.lines).toHaveLength(20);
    // The 20-cap is per cycle: the skipped keys may append next cycle.
    const next = runRefixCycle(fake.io, { repos: ['ashlrai/locus'] });
    expect(next.drains).toBe(5);
  });

  it('gives up after 3 drain lines per PR per 24h and logs REFIX_GIVEUP once', () => {
    const fake = makeIo({ prs: new Map() });
    const repo = 'ashlrai/phantom-secrets';
    const opts = { repos: [repo] };
    for (const seed of ['e', 'f', 'g']) {
      fake.setPrs(repo, [pr({ number: 9, mergeState: 'DIRTY', headSha: sha(seed) })]);
      expect(runRefixCycle(fake.io, opts).drains).toBe(1);
    }
    fake.setPrs(repo, [pr({ number: 9, mergeState: 'DIRTY', headSha: sha('h') })]);
    const fourth = runRefixCycle(fake.io, opts);
    expect(fourth.drains).toBe(0);
    expect(fourth.giveups).toBe(1);
    expect(logs(fake.calls, 'REFIX_GIVEUP')).toEqual(['log REFIX_GIVEUP RQ-DRAIN-phantom-secrets-9-hhhhhhh']);
    // Same key gives up silently; a new key in the window logs its own giveup once.
    expect(runRefixCycle(fake.io, opts).giveups).toBe(0);
    fake.setPrs(repo, [pr({ number: 9, mergeState: 'DIRTY', headSha: sha('i') })]);
    expect(runRefixCycle(fake.io, opts).giveups).toBe(1);
    expect(logs(fake.calls, 'REFIX_GIVEUP')).toHaveLength(2);
    expect(fake.lines).toHaveLength(3);
  });

  it('abandons the cycle on any gh error and never retries', () => {
    const prs = new Map<string, RefixPr[]>([
      ['ashlrai/phantom', [pr({ number: 1, mergeState: 'BEHIND' }), pr({ number: 2, mergeState: 'DIRTY' })]],
      ['ashlrai/locus', [pr({ number: 3, mergeState: 'DIRTY' })]],
    ]);
    const fake = makeIo({ prs, failList: new Set(['ashlrai/phantom-secrets']) });
    expect(() => runRefixCycle(fake.io)).toThrow('gh failed');
    // phantom was processed; phantom-secrets and everything after it was not.
    expect(fake.calls).not.toContain('list ashlrai/locus');
    expect(updateCalls(fake.calls)).toEqual(['update-branch ashlrai/phantom#1']);
    expect(drainLines(fake.lines).map((l) => l.id)).toEqual(['RQ-DRAIN-phantom-2-aaaaaaa']);
    expect(fake.calls).toContain('log REFIX_GH_ERROR list ashlrai/phantom-secrets');
    expect(fake.state()?.appended).toHaveProperty('RQ-DRAIN-phantom-2-aaaaaaa');
  });

  it('stops before any gh call when the hold file is unreadable', () => {
    const fake = makeIo({ holdThrows: true, prs: new Map<string, RefixPr[]>([['ashlrai/phantom', [pr({ mergeState: 'DIRTY' })]]]) });
    expect(() => runRefixCycle(fake.io)).toThrow('unreadable');
    expect(fake.calls.filter((c) => c.startsWith('list '))).toHaveLength(0);
    expect(fake.calls).toContain('log REFIX_HOLD_UNAVAILABLE');
    expect(fake.lines).toHaveLength(0);
  });

  it('marks drain lines touching protected paths with Security pin required', () => {
    const prs = new Map<string, RefixPr[]>([['ashlrai/phantom', [
      pr({ number: 11, mergeState: 'DIRTY', headSha: sha('a'), files: ['.github/workflows/ci.yml'] }),
      pr({ number: 12, mergeState: 'DIRTY', headSha: sha('b'), files: ['scripts/bridge/reaper.sh'] }),
      pr({ number: 13, mergeState: 'DIRTY', headSha: sha('c'), files: ['src/core/drive/loop.ts'] }),
      pr({ number: 14, mergeState: 'DIRTY', headSha: sha('d'), files: ['src/a.ts'], filesTruncated: true }),
    ]]]);
    const fake = makeIo({ prs, hold: new Set(['none#1']) });
    runRefixCycle(fake.io, { repos: ['ashlrai/phantom'] });
    const rows = drainLines(fake.lines) as { id: string; prompt: string }[];
    expect(rows.map((r) => r.prompt.startsWith('Security pin required'))).toEqual([true, true, false, true]);
  });

  it('covers the seven GS_REPOS in one cycle', () => {
    const fake = makeIo({});
    runRefixCycle(fake.io);
    const listed = fake.calls.filter((c) => c.startsWith('list ')).map((c) => c.slice(5));
    expect(listed).toEqual([...REFIX_REPOS]);
  });
});

describe('securityPinnedPath', () => {
  it.each([
    ['.github/workflows/ci.yml', true],
    ['x/.github/dependabot.yml', true],
    ['scripts/bridge/publish.sh', true],
    ['contrib/dispatchd/run.sh', true],
    ['lib/git_safety.sh', true],
    ['src/core/util/scrub.ts', true],
    ['scripts/bridge/reaper.sh', true],
    ['src/core/drive/loop.ts', false],
    ['src/core/types.ts', false],
  ])('%s -> %s', (path, expected) => {
    expect(securityPinnedPath(path)).toBe(expected);
  });
});
