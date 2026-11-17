import { describe, expect, it } from 'vitest';
import {
  classifyMergeQueuePr, normalizeMergeQueueState, runMergeQueueCycle, MERGEQ_REPOS,
  type MergeQueueIo, type MergeQueuePr, type MergeQueueRepoSnapshot, type MergeQueueState,
} from '../src/core/drive/merge-queue-loop.js';
import { drainKey } from '../src/core/drive/refix-loop.js';

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
    expect(fake.calls).toEqual([`read ${REPO}`, `enqueue ${REPO}#3@aaaaaaa`, `update ${REPO}#1@bbbbbbb`]);
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
