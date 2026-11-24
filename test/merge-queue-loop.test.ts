import { describe, expect, it } from 'vitest';
import {
  classifyMergeQueuePr, normalizeMergeQueueState, runMergeQueueCycle, MERGEQ_REPOS,
  type MergeQueueIo, type MergeQueuePr, type MergeQueueRepoSnapshot, type MergeQueueState,
} from '../src/core/drive/merge-queue-loop.js';
import { drainKey } from '../src/core/drive/refix-loop.js';
import { dequeueMergeQueuePr, enqueueMergeQueuePr, readSnapshot } from '../scripts/merge-queue-loop.mjs';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const REPO = 'ashlrai/phantom';

const pr = (over: Partial<MergeQueuePr> = {}): MergeQueuePr => ({
  id: `PR_${over.number ?? 1}`,
  number: 1,
  headSha: sha('a'),
  baseRef: 'master',
  isDraft: false,
  author: 'ashlr-fleet[bot]',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  checks: 'SUCCESS',
  reviewDecision: null,
  inMergeQueue: false,
  autoMerge: false,
  files: ['src/core/x.ts'],
  filesTruncated: false,
  ...over,
});

const snap = (prs: MergeQueuePr[], over: Partial<MergeQueueRepoSnapshot> = {}): MergeQueueRepoSnapshot => ({
  repo: REPO, defaultBranch: 'master', mergeQueue: true, prs, ...over,
});

function makeIo(options: {
  snapshots?: Map<string, MergeQueueRepoSnapshot>;
  failRead?: Set<string>;
  failEnqueue?: Set<number>;
  hold?: Set<string>;
  queueIds?: Set<string>;
  holdThrows?: boolean;
  now?: () => number;
  state?: MergeQueueState;
} = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const logs: string[] = [];
  let state: MergeQueueState | undefined = options.state;
  let saves = 0;
  const io: MergeQueueIo = {
    readSnapshot: (repo) => {
      calls.push(`read ${repo}`);
      if (options.failRead?.has(repo)) throw new Error('gh failed: token=secret');
      return options.snapshots?.get(repo) ?? snap([], { repo });
    },
    enqueue: (repo, p) => {
      calls.push(`enqueue ${repo}#${p.number}@${p.headSha.slice(0, 7)}`);
      if (options.failEnqueue?.has(p.number)) throw new Error('provider said token=secret');
    },
    updateBranch: (repo, p) => { calls.push(`update ${repo}#${p.number}@${p.headSha.slice(0, 7)}`); },
    readQueueIds: () => new Set(options.queueIds ?? []),
    appendQueueLine: (line) => { lines.push(line); },
    readHoldList: () => {
      if (options.holdThrows) throw new Error('unreadable');
      return new Set(options.hold ?? []);
    },
    loadState: () => state,
    saveState: (s) => { state = JSON.parse(JSON.stringify(s)); saves++; },
    log: (line) => { logs.push(line); },
    now: options.now ?? (() => NOW),
  };
  return { io, calls, lines, logs, state: () => state, saves: () => saves };
}

const only = (prs: MergeQueuePr[], over: Partial<MergeQueueRepoSnapshot> = {}) =>
  new Map([[REPO, snap(prs, over)]]);

describe('classifyMergeQueuePr', () => {
  const queueRepo = { defaultBranch: 'master', mergeQueue: true };
  const plainRepo = { defaultBranch: 'main', mergeQueue: false };
  const fleet = { fleet: true, held: false };

  it('enqueues a green, mergeable PR in a merge-queue repo, including a green BEHIND one', () => {
    expect(classifyMergeQueuePr(pr(), queueRepo, fleet)).toBe('enqueue');
    expect(classifyMergeQueuePr(pr({ mergeState: 'BEHIND' }), queueRepo, fleet)).toBe('enqueue');
    expect(classifyMergeQueuePr(pr({ mergeState: 'HAS_HOOKS' }), queueRepo, fleet)).toBe('enqueue');
  });

  it('never grants merge authority outside a merge queue', () => {
    expect(classifyMergeQueuePr(pr({ baseRef: 'main' }), plainRepo, fleet)).toBe('no-queue');
  });

  it('rebases BEHIND PRs that are not enqueueable', () => {
    expect(classifyMergeQueuePr(pr({ baseRef: 'main', mergeState: 'BEHIND' }), plainRepo, fleet)).toBe('rebase');
    expect(classifyMergeQueuePr(pr({ baseRef: 'main', mergeState: 'BEHIND', checks: 'PENDING' }), plainRepo, fleet)).toBe('rebase');
    expect(classifyMergeQueuePr(pr({ mergeState: 'BEHIND', checks: 'NONE' }), queueRepo, fleet)).toBe('rebase');
  });

  it('leaves a BEHIND PR with running checks alone in a queue repo', () => {
    expect(classifyMergeQueuePr(pr({ mergeState: 'BEHIND', checks: 'PENDING' }), queueRepo, fleet)).toBe('wait');
    expect(classifyMergeQueuePr(pr({ mergeState: 'BEHIND', checks: 'EXPECTED' }), queueRepo, fleet)).toBe('wait');
  });

  it('routes conflicts to the drain and red checks to refix', () => {
    expect(classifyMergeQueuePr(pr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), queueRepo, fleet)).toBe('conflict');
    expect(classifyMergeQueuePr(pr({ mergeState: 'DIRTY', mergeable: 'UNKNOWN' }), queueRepo, fleet)).toBe('conflict');
    expect(classifyMergeQueuePr(pr({ checks: 'FAILURE' }), queueRepo, fleet)).toBe('red');
    expect(classifyMergeQueuePr(pr({ checks: 'ERROR', mergeState: 'BEHIND' }), queueRepo, fleet)).toBe('red');
  });

  it('waits on unknown mergeability and pending checks', () => {
    expect(classifyMergeQueuePr(pr({ mergeable: 'UNKNOWN' }), queueRepo, fleet)).toBe('wait');
    expect(classifyMergeQueuePr(pr({ mergeState: 'UNKNOWN' }), queueRepo, fleet)).toBe('wait');
    expect(classifyMergeQueuePr(pr({ checks: 'PENDING', mergeState: 'UNSTABLE' }), queueRepo, fleet)).toBe('wait');
  });

  it('respects review gates and distinguishes queue membership from auto-merge', () => {
    expect(classifyMergeQueuePr(pr({ reviewDecision: 'CHANGES_REQUESTED' }), queueRepo, fleet)).toBe('blocked');
    expect(classifyMergeQueuePr(pr({ reviewDecision: 'REVIEW_REQUIRED' }), queueRepo, fleet)).toBe('blocked');
    expect(classifyMergeQueuePr(pr({ mergeState: 'BLOCKED', checks: 'PENDING' }), queueRepo, fleet)).toBe('blocked');
    expect(classifyMergeQueuePr(pr({ mergeState: 'BLOCKED' }), queueRepo, fleet)).toBe('blocked');
    expect(classifyMergeQueuePr(pr({ inMergeQueue: true }), queueRepo, fleet)).toBe('queued');
    expect(classifyMergeQueuePr(pr({ autoMerge: true }), queueRepo, fleet)).toBe('enqueue');
  });

  it.each([
    [{ checks: 'PENDING' }, 'wait'], [{ checks: 'EXPECTED' }, 'wait'], [{ checks: 'NONE' }, 'wait'],
    [{ checks: 'FAILURE' }, 'red'], [{ checks: 'ERROR' }, 'red'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, 'blocked'], [{ reviewDecision: 'CHANGES_REQUESTED' }, 'blocked'],
    [{ mergeState: 'BLOCKED' }, 'blocked'], [{ mergeable: 'UNKNOWN' }, 'wait'],
    [{ files: ['.github/workflows/ci.yml'] }, 'pinned'], [{ filesTruncated: true }, 'pinned'],
    [{ inMergeQueue: true }, 'queued'], [{ isDraft: true }, 'skip'],
  ] as [Partial<MergeQueuePr>, string][])('keeps gates enforced for armed PRs: %j', (over, expected) => {
    expect(classifyMergeQueuePr(pr({ autoMerge: true, ...over }), queueRepo, fleet)).toBe(expected);
  });

  it('never auto-enqueues Security-pinned or unproven file sets', () => {
    expect(classifyMergeQueuePr(pr({ files: ['.github/workflows/ci.yml'] }), queueRepo, fleet)).toBe('pinned');
    expect(classifyMergeQueuePr(pr({ files: ['bin/dispatchd.py'] }), queueRepo, fleet)).toBe('pinned');
    expect(classifyMergeQueuePr(pr({ filesTruncated: true }), queueRepo, fleet)).toBe('pinned');
  });

  it.each([{}, { mergeState: 'DIRTY' }, { mergeState: 'BEHIND', checks: 'NONE' }] as Partial<MergeQueuePr>[])(
    'leaves actively owned PRs to their owner: %j', over => {
    expect(classifyMergeQueuePr(pr({ ...over, activeOwner: true }), queueRepo, fleet)).toBe('owned');
  });

  it('skips drafts, held, non-fleet, off-base and malformed PRs', () => {
    expect(classifyMergeQueuePr(pr({ isDraft: true }), queueRepo, fleet)).toBe('skip');
    expect(classifyMergeQueuePr(pr(), queueRepo, { fleet: true, held: true })).toBe('skip');
    expect(classifyMergeQueuePr(pr(), queueRepo, { fleet: false, held: false })).toBe('skip');
    expect(classifyMergeQueuePr(pr({ baseRef: 'release' }), queueRepo, fleet)).toBe('skip');
    expect(classifyMergeQueuePr(pr({ headSha: 'abc' }), queueRepo, fleet)).toBe('skip');
    expect(classifyMergeQueuePr(pr({ id: '' }), queueRepo, fleet)).toBe('skip');
  });
});

describe('runMergeQueueCycle', () => {
  it.each(['read', 'dequeue', 'enqueue'])('recovers a stalled entry after transient %s failure, without bypassing checks', stage => {
    let at = NOW, fail = true;
    const snapshots = only([pr({ inMergeQueue: true })]), commands: string[][] = [];
    const fake = makeIo({ snapshots, now: () => at });
    const read = fake.io.readSnapshot;
    let reads = 0;
    fake.io.readSnapshot = repo => {
      if (++reads === 3 && stage === 'read') throw new Error('provider secret');
      return read(repo);
    };
    fake.io.dequeue = (repo, head) => {
      expect(Object.values(fake.state()!.attempts)).toHaveLength(fail ? 1 : 2);
      dequeueMergeQueuePr((args: string[]) => {
        commands.push(args);
        if (fail && stage === 'dequeue') throw new Error('provider secret');
        return { data: { dequeuePullRequest: { clientMutationId: null } } };
      }, repo, head);
      snapshots.set(REPO, snap([pr()]));
    };
    fake.io.enqueue = (repo, head) => enqueueMergeQueuePr((args: string[]) => {
      commands.push(args);
      if (fail && stage === 'enqueue') throw new Error('provider secret');
      snapshots.set(REPO, snap([pr({ inMergeQueue: true, checks: 'PENDING' })]));
    }, repo, head);
    const cycle = () => runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(cycle().enqueued).toBe(0);
    at += 60 * MIN - 1; expect(cycle().repos[0]!.stalled).toEqual([]);
    reads = 1; at++;
    expect(cycle()).toMatchObject({ failed: 1, repos: [{ stalled: [1], recovered: [] }] });
    const saved = structuredClone(fake.state());
    const restart = makeIo({ state: saved, snapshots, now: () => at + MIN });
    restart.io.dequeue = () => { throw new Error('must respect persisted cooldown'); };
    expect(runMergeQueueCycle(restart.io, { repos: [REPO] }).enqueued).toBe(0);
    fail = false; at += 15 * MIN;
    expect(cycle().enqueued).toBe(1);
    expect(commands.at(-1)).toEqual(['pr', 'merge', '1', '--repo', REPO, '--auto', '--match-head-commit', sha('a')]);
    expect(commands.filter(args => args[0] === 'api').every(args => args.includes('id=PR_1'))).toBe(true);
    expect(cycle().enqueued).toBe(0); // The merge group still runs its required checks.
    expect(fake.logs.join(' ')).not.toContain('secret');
  });

  it.each(['merged', 'moved', 'held', 'owned', 'red', 'pending', 'review', 'pinned', 'truncated', 'no-queue', 'dry-run'])(
    'does not restart a stalled entry when refreshed state is %s', status => {
      let at = NOW, reads = 0;
      const fake = makeIo({ now: () => at });
      fake.io.dequeue = () => { throw new Error('must not dequeue'); };
      fake.io.readHoldList = () => new Set(reads >= 3 && status === 'held' ? ['phantom#1'] : []);
      const over: Partial<MergeQueuePr> = { inMergeQueue: true,
        ...(status === 'moved' ? { headSha: sha('b') } : {}),
        ...(status === 'owned' ? { activeOwner: true } : {}),
        ...(status === 'red' ? { checks: 'FAILURE' } : {}),
        ...(status === 'pending' ? { checks: 'PENDING' } : {}),
        ...(status === 'review' ? { reviewDecision: 'REVIEW_REQUIRED' } : {}),
        ...(status === 'pinned' ? { files: ['.github/workflows/ci.yml'] } : {}),
        ...(status === 'truncated' ? { filesTruncated: true } : {}),
      };
      fake.io.readSnapshot = () => ++reads < 3 ? snap([pr({ inMergeQueue: true })])
        : snap(status === 'merged' ? [] : [pr(over)], { mergeQueue: status !== 'no-queue' });
      runMergeQueueCycle(fake.io, { repos: [REPO] }); at += 60 * MIN;
      const report = runMergeQueueCycle(fake.io, { repos: [REPO], dryRun: status === 'dry-run' });
      expect(report).toMatchObject({ enqueued: 0, failed: 0, repos: [{ stalled: [1], recovered: [] }] });
    });

  it('resets queue residence after recovery and shares the per-cycle cap', () => {
    let at = NOW;
    const fake = makeIo({ snapshots: only([pr({ inMergeQueue: true }), pr({ number: 2, inMergeQueue: true })]), now: () => at });
    fake.io.dequeue = () => {};
    const cycle = () => runMergeQueueCycle(fake.io, { repos: [REPO], cycleCap: 1 });
    cycle(); at += 60 * MIN;
    expect(cycle()).toMatchObject({ capped: true, repos: [{ stalled: [1, 2], recovered: [1] }] });
    expect(fake.state()!.latency![`${REPO}#1`].since).toBe(at);
    at += 15 * MIN;
    expect(cycle()).toMatchObject({ repos: [{ stalled: [2], recovered: [2] }] });
    expect(fake.calls.filter(call => call.startsWith('enqueue'))).toHaveLength(2);
  });

  it('rejects GraphQL dequeue errors and missing success payloads', () => {
    for (const payload of [{ errors: [{ message: 'refused' }] }, {}, { data: { dequeuePullRequest: null } }]) {
      expect(() => dequeueMergeQueuePr(() => payload, REPO, pr())).toThrow('dequeue refused');
    }
  });

  it('measures overlapping blockers hidden by queue membership and ownership', () => {
    let at = NOW;
    const snapshots = only([pr({ inMergeQueue: true, mergeState: 'BEHIND', checks: 'PENDING', reviewDecision: 'REVIEW_REQUIRED' })]);
    const fake = makeIo({ snapshots, now: () => at });
    const cycle = (dryRun = false) => runMergeQueueCycle(fake.io, { repos: [REPO], dryRun }).repos[0]!.latency[0]!;
    expect(cycle()).toMatchObject({ state: 'queued', blockers: ['stale', 'checks', 'review'], blockerMs: { stale: 0, checks: 0, review: 0 } });
    at += MIN;
    snapshots.set(REPO, snap([pr({ activeOwner: true, mergeable: 'CONFLICTING', checks: 'FAILURE' })]));
    expect(cycle()).toMatchObject({ state: 'owned', blockers: ['conflict', 'checks'],
      stateMs: { queued: MIN }, blockerMs: { stale: MIN, checks: MIN, review: MIN, conflict: 0 } });
    at += 2 * MIN;
    const saved = structuredClone(fake.state());
    expect(cycle(true)).toMatchObject({ stateMs: { queued: MIN, owned: 2 * MIN },
      blockerMs: { stale: MIN, review: MIN, checks: 3 * MIN, conflict: 2 * MIN } });
    expect(fake.state()).toEqual(saved);
    const measured = cycle().blockerMs;
    expect(cycle().blockerMs).toEqual(measured); // Same-time reads add no time.
    expect(measured).toEqual({ stale: MIN, review: MIN, checks: 3 * MIN, conflict: 2 * MIN });
    snapshots.set(REPO, snap([pr({ headSha: sha('b'), checks: 'EXPECTED' })]));
    expect(cycle()).toMatchObject({ stateMs: { wait: 0 }, blockers: ['checks'], blockerMs: { checks: 0 } });
    at -= MIN; expect(cycle().blockerMs).toEqual({ checks: 0 });
    expect(fake.calls.every(call => call.startsWith('read '))).toBe(true);
    expect(fake.lines).toEqual([]);
  });

  it('starts legacy blocker measurements at observation and rejects malformed histories', () => {
    const legacy = { headSha: sha('a'), state: 'queued', since: NOW, observedAt: NOW, stateMs: { queued: MIN } };
    const state = normalizeMergeQueueState({ latency: { [`${REPO}#1`]: legacy } });
    const fake = makeIo({ state, snapshots: only([pr({ inMergeQueue: true, checks: 'NONE' })]), now: () => NOW + MIN });
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).repos[0]!.latency[0]).toMatchObject({
      stateMs: { queued: 2 * MIN }, blockers: ['checks'], blockerMs: { checks: 0 } });
    for (const patch of [{ blockers: null }, { blockers: ['unknown'] }, { blockers: ['checks', 'checks'] },
      { blockerMs: [] }, { blockerMs: { checks: -1 } }, { blockerMs: { checks: 1.5 } }, { blockerMs: { bypass: 1 } }]) {
      expect(normalizeMergeQueueState({ latency: { bad: { ...legacy, ...patch } } }).latency).toBeUndefined();
    }
  });

  it('drains a conflict once, waits for repaired-head checks and reenters the queue after eviction', () => {
    let at = NOW;
    const snapshots = only([pr({ mergeState: 'DIRTY' })]), fake = makeIo({ snapshots, now: () => at });
    const commands: string[][] = [];
    fake.io.enqueue = (repo, head) => enqueueMergeQueuePr((args: string[]) => commands.push(args), repo, head);
    const cycle = () => runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(cycle().drained).toBe(1); expect(cycle().drained).toBe(0);
    snapshots.set(REPO, snap([pr({ headSha: sha('b'), checks: 'PENDING' })]));
    expect(cycle().enqueued).toBe(0);
    snapshots.set(REPO, snap([pr({ headSha: sha('b') })]));
    expect(cycle().enqueued).toBe(1);
    snapshots.set(REPO, snap([pr({ headSha: sha('b'), inMergeQueue: true, checks: 'PENDING' })]));
    expect(cycle().repos[0]!.latency[0]).toMatchObject({ state: 'queued', blockers: ['checks'] });
    at += 15 * MIN;
    snapshots.set(REPO, snap([pr({ headSha: sha('b'), autoMerge: true, checks: 'FAILURE' })]));
    expect(cycle().enqueued).toBe(0);
    snapshots.set(REPO, snap([pr({ headSha: sha('b'), autoMerge: true })]));
    expect(cycle().enqueued).toBe(1); expect(cycle().enqueued).toBe(0);
    expect(commands).toEqual(Array.from({ length: 2 }, () => ['pr', 'merge', '1', '--repo', REPO, '--auto', '--match-head-commit', sha('b')]));
    expect(fake.lines).toHaveLength(1);
  });

  it('reports sampled state milliseconds as JSON, resets on new heads and omits closed PRs', () => {
    let at = NOW;
    const snapshots = only([pr({ checks: 'PENDING' })]), fake = makeIo({ snapshots, now: () => at });
    const cycle = () => JSON.parse(JSON.stringify(runMergeQueueCycle(fake.io, { repos: [REPO] }))).repos[0].latency;
    cycle();
    at += MIN; snapshots.set(REPO, snap([pr({ mergeState: 'DIRTY' })])); cycle();
    at += 2 * MIN; snapshots.set(REPO, snap([pr({ activeOwner: true })])); cycle();
    at += 3 * MIN; snapshots.set(REPO, snap([pr()])); cycle();
    at += 4 * MIN; snapshots.set(REPO, snap([pr({ inMergeQueue: true })])); cycle();
    at += 5 * MIN;
    expect(cycle()[0]).toMatchObject({ state: 'queued', since: NOW + 10 * MIN,
      stateMs: { wait: MIN, conflict: 2 * MIN, owned: 3 * MIN, enqueue: 4 * MIN, queued: 5 * MIN } });
    at -= MIN;
    expect(cycle()[0].stateMs).toEqual({ queued: 0 });
    snapshots.set(REPO, snap([pr({ headSha: sha('b') })]));
    expect(cycle()[0].stateMs).toEqual({ enqueue: 0 });
    snapshots.set(REPO, snap([])); expect(cycle()).toEqual([]);
    expect(fake.state()?.latency).toEqual({});
  });

  it('does not infer time across failed reads or accept malformed persisted timings', () => {
    let at = NOW;
    const failRead = new Set<string>(), fake = makeIo({ snapshots: only([pr({ mergeState: 'BEHIND' })]), failRead, now: () => at });
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    failRead.add(REPO); at += MIN; runMergeQueueCycle(fake.io, { repos: [REPO] });
    failRead.clear(); at += MIN;
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).repos[0]?.latency[0]).toMatchObject({
      stateMs: { enqueue: 0 }, blockers: ['stale'], blockerMs: { stale: 0 } });
    expect(normalizeMergeQueueState({ latency: { bad: { headSha: sha('a'), state: 'enqueue', since: 0, observedAt: 1, stateMs: { enqueue: -1 } } } }).latency).toBeUndefined();
  });

  it('recovers eligible heads through head-pinned auto-merge while owners, conflicts and checks wait', () => {
    const candidates = [pr(), pr({ number: 2, checks: 'PENDING' }), pr({ number: 3, mergeState: 'DIRTY' }),
      pr({ number: 4, activeOwner: true }), pr({ number: 5, checks: 'FAILURE' }), pr({ number: 6, inMergeQueue: true })];
    const fake = makeIo({ snapshots: only(candidates) }), calls: string[][] = [];
    fake.io.enqueue = (repo, p) => { enqueueMergeQueuePr((args: string[]) => { calls.push(args); throw new Error('uncertain'); }, repo, p); };
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(calls).toEqual([['pr', 'merge', '1', '--repo', REPO, '--auto', '--match-head-commit', sha('a')]]);
    expect(fake.lines).toHaveLength(1);
    const snapshot = (claims: { key: string; live: boolean }[]) => readSnapshot(() => ({ data: { repository: {
      defaultBranchRef: { name: 'master' }, mergeQueue: { id: 'Q' },
      pullRequests: { nodes: [{ number: 1 }], pageInfo: { hasNextPage: false } },
    } } }), REPO, claims).prs[0];
    expect(snapshot([{ key: `pr:${REPO}#1`, live: true }]).activeOwner).toBe(true);
    expect(snapshot([{ key: `repo:${REPO.toUpperCase()}`, live: true }]).activeOwner).toBe(true);
    expect(snapshot([{ key: `pr:${REPO}#1`, live: false }]).activeOwner).toBe(false);
  });

  it('enqueues a stranded armed head once and leaves the actual queue to enforce merge checks', () => {
    const candidate = pr({ autoMerge: true });
    const snapshots = only([candidate]);
    const fake = makeIo({ snapshots });
    fake.io.enqueue = (repo, head) => {
      expect([repo, head.id, head.headSha]).toEqual([REPO, candidate.id, sha('a')]);
      snapshots.set(REPO, snap([pr({ autoMerge: true, inMergeQueue: true, checks: 'PENDING' })]));
    };
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).enqueued).toBe(1);
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).repos[0]?.totals).toEqual({ queued: 1 });
    for (const options of [{ hold: new Set(['phantom#1']) }, { snapshots: only([candidate], { mergeQueue: false }) }]) {
      const blocked = makeIo({ snapshots: only([candidate]), ...options });
      expect(runMergeQueueCycle(blocked.io, { repos: [REPO] }).enqueued).toBe(0);
      expect(blocked.calls).toEqual([`read ${REPO}`]);
    }
  });

  it('covers the seven approved repos by default and nothing else', () => {
    const fake = makeIo();
    runMergeQueueCycle(fake.io);
    expect(fake.calls).toEqual(MERGEQ_REPOS.map((repo) => `read ${repo}`));
    expect(MERGEQ_REPOS).toHaveLength(7);
  });

  it('enqueues green PRs, rebases behind ones and drains conflicts in one pass', () => {
    const fake = makeIo({ snapshots: only([
      pr({ number: 3 }),
      pr({ number: 1, mergeState: 'BEHIND', checks: 'NONE', headSha: sha('b') }),
      pr({ number: 2, mergeable: 'CONFLICTING', mergeState: 'DIRTY', headSha: sha('c') }),
      pr({ number: 4, checks: 'FAILURE' }),
    ]) });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(fake.calls).toEqual([`read ${REPO}`, `enqueue ${REPO}#3@aaaaaaa`, `update ${REPO}#1@bbbbbbb`, `read ${REPO}`]);
    expect(summary).toMatchObject({ enqueued: 1, rebased: 1, drained: 1, failed: 0, repoErrors: 0, capped: false });
    expect(summary.repos[0]!.totals).toEqual({ enqueue: 1, rebase: 1, conflict: 1, red: 1 });
    expect(fake.lines).toHaveLength(1);
    const row = JSON.parse(fake.lines[0]!);
    expect(row.id).toBe(drainKey(REPO, 2, sha('c')));
    expect(row.prompt).toContain('merge conflict (DIRTY)');
    expect(row.prompt).toContain('Never force-push');
    expect(fake.logs.at(-1)).toMatch(/^MERGEQ_CYCLE enqueued=1 rebased=1 resolved=0 drained=1/);
  });

  it('dry run classifies without mutating, appending or saving state', () => {
    const fake = makeIo({ snapshots: only([
      pr({ number: 1 }), pr({ number: 2, mergeState: 'BEHIND', checks: 'NONE' }),
      pr({ number: 3, mergeState: 'DIRTY' }),
    ]) });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO], dryRun: true });
    expect(fake.calls).toEqual([`read ${REPO}`]);
    expect(fake.lines).toEqual([]);
    expect(fake.saves()).toBe(0);
    expect(summary.repos[0]!.totals).toEqual({ enqueue: 1, rebase: 1, conflict: 1 });
  });

  it.each([false, true])('removes recovery latency before enrollment (update failure=%s)', (updateFails) => {
    // All heads are observed at NOW. Fixed I/O costs model an older 60s
    // branch update and 90s conflict resolver ahead of two 100ms enrollments.
    const fixture = [
      pr({ number: 1, mergeState: 'BEHIND', checks: 'NONE', autoMerge: true }),
      pr({ number: 2, mergeable: 'CONFLICTING', mergeState: 'DIRTY', autoMerge: true }),
      pr({ number: 3, autoMerge: true }), pr({ number: 4, autoMerge: true }),
      pr({ number: 5, inMergeQueue: true, checks: 'PENDING', autoMerge: true }),
    ];
    const measure = (serial: boolean) => {
      let at = NOW;
      const snapshots = only(fixture);
      const fake = makeIo({ snapshots, now: () => at });
      const latency: number[] = [];
      fake.io.updateBranch = () => {
        at += 60_000;
        if (updateFails) throw new Error('transient provider failure');
      };
      fake.io.resolveConflict = () => { at += 90_000; return 'real'; };
      fake.io.enqueue = (_repo, head) => {
        expect([head.autoMerge, head.headSha]).toEqual([true, sha('a')]);
        expect([3, 4]).toContain(head.number);
        at += 100;
        latency.push(at - NOW);
      };
      // Replay the previous ascending-PR schedule through the same executor,
      // one snapshot row at a time; batch mode uses the new scheduling order.
      const reports = (serial ? fixture.map((head) => [head]) : [fixture]).map((heads) => {
        snapshots.set(REPO, snap(heads));
        return runMergeQueueCycle(fake.io, { repos: [REPO] });
      });
      expect(reports.reduce((n, r) => n + r.failed, 0)).toBe(Number(updateFails));
      expect(reports.reduce((n, r) => n + r.drained, 0)).toBe(1);
      expect(reports.reduce((n, r) => n + (r.repos[0]?.totals.queued ?? 0), 0)).toBe(1);
      expect(fake.lines).toHaveLength(1);
      expect(fixture.every((head) => head.autoMerge)).toBe(true);
      return latency;
    };
    expect(measure(true)).toEqual([150_100, 150_200]);
    expect(measure(false)).toEqual([100, 200]);
  });

  it('keeps a failed enrollment bounded while admitting other ready PRs before recovery', () => {
    let at = NOW;
    const candidate = pr({ number: 2, autoMerge: true });
    const snapshots = only([
      pr({ number: 1, mergeState: 'DIRTY', mergeable: 'CONFLICTING' }),
      candidate, pr({ number: 3, autoMerge: true }),
    ]);
    const failures = new Set([2]);
    const fake = makeIo({ snapshots, failEnqueue: failures, now: () => at });
    fake.io.resolveConflict = () => {
      expect(fake.calls).toEqual([`read ${REPO}`, `enqueue ${REPO}#2@aaaaaaa`, `enqueue ${REPO}#3@aaaaaaa`]);
      return 'real';
    };
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] })).toMatchObject({ enqueued: 1, failed: 1, drained: 1 });
    expect(fake.logs.join('\n')).not.toContain('secret');
    failures.clear();
    snapshots.set(REPO, snap([candidate, pr({ number: 3, inMergeQueue: true, autoMerge: true })]));
    at += MIN;
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).enqueued).toBe(0);
    at = NOW + 15 * MIN;
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).enqueued).toBe(1);
    snapshots.set(REPO, snap([pr({ ...candidate, inMergeQueue: true })]));
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).repos[0]?.totals).toEqual({ queued: 1 });
  });

  it('does not double-append a drain refix-loop already queued for the same head', () => {
    const conflict = pr({ number: 9, mergeState: 'DIRTY', headSha: sha('d') });
    const fake = makeIo({ snapshots: only([conflict]), queueIds: new Set([drainKey(REPO, 9, sha('d'))]) });
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).drained).toBe(0);
    expect(fake.lines).toEqual([]);
  });

  it('resolves a conflict mechanically before spending an agent lane', () => {
    const fake = makeIo({ snapshots: only([pr({ number: 9, mergeState: 'DIRTY', headSha: sha('d') })]) });
    const resolved: number[] = [];
    fake.io.resolveConflict = (_repo, p) => { resolved.push(p.number); return 'resolved'; };
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(resolved).toEqual([9]);
    expect(summary).toMatchObject({ resolved: 1, drained: 0 });
    expect(fake.lines).toEqual([]);
  });

  it('falls back to the lane on a real conflict or a resolver throw, and spends the resolve budget once', () => {
    let at = NOW;
    const fake = makeIo({ snapshots: only([pr({ number: 9, mergeState: 'DIRTY', headSha: sha('d') })]), now: () => at });
    let calls = 0;
    fake.io.resolveConflict = () => { calls++; if (calls === 1) throw new Error('boom'); return 'real'; };
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] })).toMatchObject({ resolved: 0, drained: 1 });
    expect(JSON.parse(fake.lines[0]!).id).toBe(drainKey(REPO, 9, sha('d')));
    at += 20 * MIN;
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(calls).toBe(1); // already drained for this head: no second resolve, no second line
    expect(fake.lines).toHaveLength(1);
  });

  it('dry-run never resolves', () => {
    const fake = makeIo({ snapshots: only([pr({ number: 9, mergeState: 'DIRTY', headSha: sha('d') })]) });
    fake.io.resolveConflict = () => { throw new Error('must not run'); };
    expect(runMergeQueueCycle(fake.io, { repos: [REPO], dryRun: true }).resolved).toBe(0);
  });

  it('requeues the recovered head through auto-merge, bounds retries and stops after merge', () => {
    let at = NOW;
    const snapshots = only([pr({ mergeState: 'DIRTY' })]);
    const failures = new Set([1]), calls: string[][] = [];
    const fake = makeIo({ snapshots, now: () => at });
    fake.io.resolveConflict = () => {
      expect(Object.values(fake.state()!.attempts)).toContainEqual({ pr: 'phantom#1', action: 'resolve', at: NOW });
      snapshots.set(REPO, snap([pr({ headSha: sha('b'), autoMerge: false })]));
      return 'resolved';
    };
    fake.io.enqueue = (repo, head) => enqueueMergeQueuePr((args: string[]) => {
      calls.push(args); if (failures.has(1)) throw new Error('provider secret');
    }, repo, head);
    const cycle = () => runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(cycle()).toMatchObject({ resolved: 1, enqueued: 0, failed: 1, drained: 0 });
    failures.clear(); at += MIN;
    expect(cycle().enqueued).toBe(0);
    at = NOW + 15 * MIN;
    expect(cycle().enqueued).toBe(1);
    expect(calls).toEqual(Array(2).fill(['pr', 'merge', '1', '--repo', REPO,
      '--auto', '--match-head-commit', sha('b')]));
    snapshots.set(REPO, snap([])); at += 20 * MIN;
    expect(cycle()).toMatchObject({ enqueued: 0, resolved: 0, drained: 0 });
    expect(calls).toHaveLength(2);
    expect(fake.logs.join('\n')).not.toContain('secret');
  });

  it.each([
    [{ checks: 'PENDING' }, {}], [{ checks: 'NONE' }, {}], [{ checks: 'FAILURE' }, {}],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, {}], [{ filesTruncated: true }, {}],
    [{ files: ['.github/workflows/ci.yml'] }, {}], [{ activeOwner: true }, {}],
    [{ inMergeQueue: true }, {}], [{}, { mergeQueue: false }],
  ] as [Partial<MergeQueuePr>, Partial<MergeQueueRepoSnapshot>][])(
    'rechecks every gate after mechanical recovery: %j %j', (over, repo) => {
      const snapshots = only([pr({ mergeState: 'DIRTY' })]), fake = makeIo({ snapshots });
      fake.io.resolveConflict = () => {
        snapshots.set(REPO, snap([pr({ headSha: sha('b'), ...over })], repo)); return 'resolved';
      };
      expect(runMergeQueueCycle(fake.io, { repos: [REPO] })).toMatchObject({ resolved: 1, enqueued: 0, drained: 0 });
      expect(fake.calls.filter(c => c.startsWith('enqueue'))).toEqual([]);
    });

  it.each([false, true])('waits for recovered checks or stops if merged during recovery (merged=%s)', merged => {
    const snapshots = only([pr({ mergeState: 'DIRTY' })]), fake = makeIo({ snapshots });
    fake.io.resolveConflict = () => {
      snapshots.set(REPO, snap(merged ? [] : [pr({ headSha: sha('b'), checks: 'PENDING' })])); return 'resolved';
    };
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] })).toMatchObject({ resolved: 1, enqueued: 0, drained: 0 });
    if (!merged) snapshots.set(REPO, snap([pr({ headSha: sha('b') })]));
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).enqueued).toBe(Number(!merged));
    expect(fake.lines).toEqual([]);
  });

  it('caps recovery reads and repairs per cycle', () => {
    const fake = makeIo({ snapshots: only([pr({ mergeState: 'DIRTY' }), pr({ number: 2, mergeState: 'DIRTY' })]) });
    expect(runMergeQueueCycle(fake.io, { repos: [REPO], cycleCap: 1 })).toMatchObject({ drained: 1, capped: true });
    expect(fake.calls).toEqual([`read ${REPO}`, `read ${REPO}`]);
    expect(Object.values(fake.state()!.attempts)).toHaveLength(1);
  });

  it.each(['merged', 'held', 'ready', 'moved'])(
    're-observes a stale conflict before repair: %s', (state) => {
      const fake = makeIo(), conflict = pr({ mergeState: 'DIRTY' });
      let reads = 0, resolves = 0;
      fake.io.readSnapshot = () => ++reads === 1 ? snap([conflict]) : snap(state === 'merged' ? [] : [
        pr({ headSha: sha('b'), ...(state === 'moved' ? { mergeState: 'DIRTY' } : {}) }),
      ]);
      fake.io.readHoldList = () => new Set(reads > 0 && state === 'held' ? ['phantom#1'] : []);
      fake.io.resolveConflict = (_repo, head) => { resolves++; expect(head.headSha).toBe(sha('b')); return 'real'; };
      const report = runMergeQueueCycle(fake.io, { repos: [REPO] });
      expect(resolves).toBe(Number(state === 'moved'));
      expect(report.enqueued).toBe(Number(state === 'ready'));
      expect(report.drained).toBe(Number(state === 'moved'));
      if (state === 'moved') expect(JSON.parse(fake.lines[0]!).id).toBe(drainKey(REPO, 1, sha('b')));
    });

  it('bounds unsettled recovery and failed refreshes across cycles and restarts', () => {
    let at = NOW, resolves = 0, reads = 0;
    const fake = makeIo({ now: () => at });
    fake.io.readSnapshot = () => {
      if (++reads === 2) throw new Error('provider secret');
      return snap([pr({ mergeState: 'DIRTY' })]);
    };
    fake.io.resolveConflict = () => { resolves++; return 'resolved'; };
    const cycle = () => runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(cycle()).toMatchObject({ failed: 1, drained: 0 });
    at += MIN; cycle(); expect(resolves).toBe(0);
    for (let n = 0; n < 4; n++) { at += 16 * MIN; cycle(); }
    expect(resolves).toBe(2); expect(fake.lines).toEqual([]);
    const restart = makeIo({ state: fake.state(), snapshots: only([pr({ mergeState: 'DIRTY' })]), now: () => at });
    restart.io.resolveConflict = () => { throw new Error('budget must survive restart'); };
    expect(runMergeQueueCycle(restart.io, { repos: [REPO] })).toMatchObject({ resolved: 0, drained: 0, failed: 0 });
    at = NOW + 24 * 60 * MIN + MIN; cycle(); expect(resolves).toBe(3);
    expect(fake.logs.join('\n')).not.toContain('secret');
  });

  it('a new head after a conflict drain gets its own line, the same head never twice', () => {
    let at = NOW;
    const snapshots = only([pr({ number: 9, mergeState: 'DIRTY', headSha: sha('d') })]);
    const fake = makeIo({ snapshots, now: () => at });
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    at += 20 * MIN;
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(fake.lines).toHaveLength(1);
    snapshots.set(REPO, snap([pr({ number: 9, mergeState: 'DIRTY', headSha: sha('e') })]));
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(fake.lines).toHaveLength(2);
  });

  it.each([false, true])('spaces retries and caps attempts at 3 per rolling 24h (armed=%s)', (autoMerge) => {
    let at = NOW;
    const fake = makeIo({ snapshots: only([pr({ number: 5, autoMerge })]), now: () => at });
    const enqueues = () => fake.calls.filter((c) => c.startsWith('enqueue')).length;
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    at += 5 * MIN;
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(enqueues()).toBe(1);
    for (let i = 0; i < 4; i++) {
      at += 16 * MIN;
      runMergeQueueCycle(fake.io, { repos: [REPO] });
    }
    expect(enqueues()).toBe(3);
    at = NOW + 24 * 60 * MIN + MIN;
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(enqueues()).toBe(4);
  });

  it('writes the attempt ahead of the call so a crash cannot loop', () => {
    const fake = makeIo({ snapshots: only([pr({ number: 5 })]) });
    fake.io.enqueue = () => {
      expect(Object.values(fake.state()!.attempts)).toEqual([{ pr: 'phantom#5', action: 'enqueue', at: NOW }]);
      throw new Error('crash');
    };
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(summary.failed).toBe(1);
  });

  it('caps each action per cycle and reports the cap', () => {
    const prs = Array.from({ length: 5 }, (_, i) => pr({ number: i + 1 }));
    const fake = makeIo({ snapshots: only(prs) });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO], cycleCap: 2 });
    expect(summary.enqueued).toBe(2);
    expect(summary.capped).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith('enqueue'))).toEqual([
      `enqueue ${REPO}#1@aaaaaaa`, `enqueue ${REPO}#2@aaaaaaa`,
    ]);
  });

  it('a failed mutation is logged without provider text and the cycle continues', () => {
    const fake = makeIo({ snapshots: only([pr({ number: 1 }), pr({ number: 2 })]), failEnqueue: new Set([1]) });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(summary).toMatchObject({ enqueued: 1, failed: 1 });
    expect(summary.repos[0]!.failed).toEqual([1]);
    expect(fake.logs).toContain(`MERGEQ_GH_ERROR enqueue ${REPO}#1`);
    expect(fake.logs.join('\n')).not.toContain('secret');
  });

  it('a failed repo read skips only that repo', () => {
    const other = 'ashlrai/locus';
    const snapshots = new Map([[other, snap([pr({ number: 7, baseRef: 'main' })], { repo: other, defaultBranch: 'main' })]]);
    const fake = makeIo({ snapshots, failRead: new Set([REPO]) });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO, other] });
    expect(summary.repoErrors).toBe(1);
    expect(summary.enqueued).toBe(1);
    expect(summary.repos.map((r) => r.ok)).toEqual([false, true]);
    expect(fake.logs).toContain(`MERGEQ_GH_ERROR read ${REPO}`);
    expect(fake.logs.join('\n')).not.toContain('secret');
  });

  it('fails closed before any read when the hold list is unreadable', () => {
    const fake = makeIo({ holdThrows: true });
    expect(() => runMergeQueueCycle(fake.io, { repos: [REPO] })).toThrow('unreadable');
    expect(fake.calls).toEqual([]);
    expect(fake.logs).toEqual(['MERGEQ_HOLD_UNAVAILABLE']);
  });

  it('never touches held or non-fleet PRs and de-duplicates repeated rows', () => {
    const fake = makeIo({
      snapshots: only([pr({ number: 1 }), pr({ number: 2, author: 'someone' }), pr({ number: 1 })]),
      hold: new Set(['phantom#1']),
    });
    const summary = runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(summary.enqueued).toBe(0);
    expect(summary.repos[0]!.totals).toEqual({ skip: 2 });
  });

  it('matches the fleet bot in both its GraphQL and REST login forms', () => {
    const fake = makeIo({ snapshots: only([pr({ number: 1, author: 'ashlr-fleet' }), pr({ number: 2 })]) });
    expect(runMergeQueueCycle(fake.io, { repos: [REPO] }).enqueued).toBe(2);
  });

  it('normalizes persisted state and expires old entries', () => {
    expect(normalizeMergeQueueState({
      attempts: { a: { pr: 'x#1', action: 'enqueue', at: 1 }, b: { pr: 'x#1', action: 'merge', at: 1 }, c: null },
      drained: { k: 5, bad: 'no' },
    })).toEqual({ v: 1, attempts: { a: { pr: 'x#1', action: 'enqueue', at: 1 } }, drained: { k: 5 } });
    const fake = makeIo({ state: { v: 1, attempts: { old: { pr: 'phantom#1', action: 'enqueue', at: 0 } }, drained: { gone: 0 } } });
    runMergeQueueCycle(fake.io, { repos: [REPO] });
    expect(fake.state()).toEqual({ v: 1, attempts: {}, drained: {} });
  });
});
