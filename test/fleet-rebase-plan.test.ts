import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdFleetRebasePlan, type FleetRebasePlanDeps } from '../src/cli/fleet-rebase-plan.js';
import type { MergeBatchPr } from '../src/core/fleet/merge-batch.js';
import {
  REBASE_PLAN_SCHEMA,
  chunkOrder,
  coveredPrNumbers,
  parseHoldList,
  planRebaseJobs,
  rebaseAttemptsSpent,
  type RebasePlanExistingJob,
} from '../src/core/fleet/rebase-plan.js';

const NOW = new Date('2026-11-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const conflictedBridge = (number: number, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr => ({
  number,
  title: `bridge: RQ-JOB-${number}`,
  headRef: `bridge/job-${number}`,
  headSha: `${SHA.slice(0, 34)}${String(number).padStart(6, '0')}`.slice(0, 40),
  isDraft: false,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  createdAt: hoursAgo(100 - number),
  updatedAt: hoursAgo(10),
  files: [`f${number}.ts`],
  ...overrides,
});

const plan = (prs: MergeBatchPr[], overrides: Record<string, unknown> = {}) =>
  planRebaseJobs({ prs, repo: 'ashlrai/phantom', now: NOW, ...overrides });

const existing = (id: string | null, status: string, text = '', repo: string | null = null): RebasePlanExistingJob => ({ id, status, text, repo });

describe('planRebaseJobs', () => {
  it('puts same-file conflicting bridge PRs in one cluster job', () => {
    const result = plan([
      conflictedBridge(1, { files: ['s.ts', 'a.ts'] }),
      conflictedBridge(2, { files: ['s.ts', 'b.ts'] }),
      conflictedBridge(3, { files: ['solo.ts'] }),
    ]);
    expect(result.counts).toMatchObject({ open: 3, conflicting: 3, jobs: 2, clusters: 1, singles: 1 });
    const cluster = result.jobs.find(j => j.kind === 'cluster')!;
    expect(cluster.prs.sort()).toEqual([1, 2]);
    expect(cluster.sharedFiles).toEqual(['s.ts']);
    const single = result.jobs.find(j => j.kind === 'single')!;
    expect(single.prs).toEqual([3]);
  });

  it('skips non-conflicting, non-bridge and clean PRs honestly', () => {
    const result = plan([
      conflictedBridge(1, { files: ['s.ts'] }),
      conflictedBridge(2, { title: 'feat: not a bridge', files: ['s.ts'] }),
      conflictedBridge(3, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: ['s.ts'] }),
      conflictedBridge(4, { title: 'docs: prose', mergeStateStatus: 'BEHIND', files: ['s.ts'] }),
    ]);
    expect(result.counts).toMatchObject({ open: 4, conflicting: 1, jobs: 1 });
    expect(result.jobs[0]!.prs).toEqual([1]);
  });

  it('names single jobs with the queuegen id shape when head oids are known', () => {
    const result = plan([conflictedBridge(4021, { files: ['a.ts'] })]);
    const job = result.jobs[0]!;
    expect(job.id).toBe(`RQ-REBASE-phantom-4021-${conflictedBridge(4021).headSha!.slice(0, 7)}`);
    expect(job.line.startsWith(`- READY ${job.id} (`)).toBe(true);
    expect(job.line).toContain('repo=phantom');
    expect(job.line).toContain('after none');
  });

  it('falls back to a u-hash id when the snapshot has no head oid', () => {
    const result = plan([conflictedBridge(4021, { headSha: null, files: ['a.ts'] })]);
    expect(result.jobs[0]!.id).toMatch(/^RQ-REBASE-phantom-4021-u[0-9a-f]{6}$/);
  });

  it('embeds member numbers in batch job ids for queue coverage', () => {
    const result = plan([
      conflictedBridge(4021, { files: ['s.ts'] }),
      conflictedBridge(4023, { files: ['s.ts'] }),
    ]);
    const job = result.jobs[0]!;
    expect(job.id).toMatch(/^RQ-REBASE-BATCH-phantom-4021-4023-[0-9a-f]{6}$/);
    expect(job.line).toContain('prs=#4021,#4023');
  });

  it('emits deterministic ids for a fixed input', () => {
    const prs = [
      conflictedBridge(7, { files: ['s.ts'] }),
      conflictedBridge(8, { files: ['s.ts'] }),
      conflictedBridge(9, { files: ['x.ts'] }),
    ];
    const a = plan(prs).jobs.map(j => j.id);
    const b = plan(prs).jobs.map(j => j.id);
    expect(a).toEqual(b);
  });

  it('chunks an oversized cluster into file-connected pieces chained by after=', () => {
    // 1-2-3-4-5 share a file transitively; cap 2 → [1,2],[3,4],[5] chained.
    const prs = [1, 2, 3, 4, 5].map(n =>
      conflictedBridge(n, { files: n % 2 ? ['hub.ts', `${n}.ts`] : ['hub.ts'] }));
    const result = plan(prs, { maxPrs: 2 });
    expect(result.jobs).toHaveLength(3);
    expect(result.counts.chained).toBe(2);
    expect(result.jobs[0]!.after).toEqual([]);
    for (let i = 1; i < result.jobs.length; i++) {
      expect(result.jobs[i]!.after).toEqual([result.jobs[i - 1]!.id]);
      expect(result.jobs[i]!.line).toContain(`after ${result.jobs[i - 1]!.id}`);
      expect(result.jobs[i]!.prompt).toContain(`DEPENDENCY GATE: ${result.jobs[i - 1]!.id}`);
    }
    // A one-member tail chunk emits the queuegen-shaped single id.
    expect(result.jobs[2]!.kind).toBe('single');
    expect(result.jobs[2]!.id).toMatch(/^RQ-REBASE-phantom-5-[0-9a-fu]/);
    // Every member covered exactly once.
    expect(result.jobs.flatMap(c => c.prs).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps every emitted job id inside the router 80-char gate-token bound', () => {
    // 14 members × 5-char PR numbers overflows a batch id; chunking must split on the id budget too.
    const prs = Array.from({ length: 14 }, (_, i) =>
      conflictedBridge(4000 + i, { files: ['hub.ts'] }));
    const result = plan(prs, { maxPrs: 16 });
    expect(result.jobs.length).toBeGreaterThan(1);
    for (const job of result.jobs) {
      expect(job.id.length).toBeLessThanOrEqual(80);
      // Chained successors can still name their dependency in a DEPENDENCY GATE.
      for (const dep of job.after) expect(dep.length).toBeLessThanOrEqual(80);
    }
    expect(result.jobs.flatMap(j => j.prs).sort((a, b) => a - b)).toEqual(prs.map(p => p.number));
  });

  it('keeps chunk members file-connected where possible', () => {
    // Order [1,2,3,4] where only 1-3 and 2-4 overlap: BFS growth gives [1,3]+[2,4], not [1]+[2,3,4]-ish.
    const prs = [
      conflictedBridge(1, { files: ['a.ts'] }),
      conflictedBridge(2, { files: ['b.ts'] }),
      conflictedBridge(3, { files: ['a.ts'] }),
      conflictedBridge(4, { files: ['b.ts'] }),
    ];
    const result = plan(prs, { maxPrs: 2 });
    const chunks = result.jobs.map(j => [...j.prs].sort());
    expect(chunks).toEqual([[1, 3], [2, 4]]);
  });

  it('marks security-pinned surfaces on the job and the line', () => {
    const result = plan([
      conflictedBridge(1, { files: ['.github/workflows/ci.yml', 'a.ts'] }),
      conflictedBridge(2, { files: ['a.ts'] }),
    ]);
    const job = result.jobs[0]!;
    expect(job.pinned).toBe(true);
    expect(job.line).toContain('[Security pin required]');
    expect(result.counts.pinned).toBe(1);
  });

  it('excludes PRs already covered by an active queue job', () => {
    const result = plan([
      conflictedBridge(1, { files: ['s.ts'] }),
      conflictedBridge(2, { files: ['s.ts'] }),
      conflictedBridge(3, { files: ['t.ts'] }),
    ], {
      existing: [existing(`RQ-REBASE-phantom-1-${SHA.slice(0, 7)}`, 'READY')],
    });
    expect(result.coverage.state).toBe('ok');
    expect(result.coverage.coveredPrs).toEqual([1]);
    expect(result.counts).toMatchObject({ conflicting: 3, covered: 1, jobs: 2 });
    expect(result.jobs.flatMap(j => j.prs).sort()).toEqual([2, 3]);
  });

  it('does not cover PRs whose queue rows are terminal', () => {
    const result = plan([conflictedBridge(1, { files: ['a.ts'] })], {
      existing: [
        existing('RQ-REBASE-phantom-1-deadbeef', 'DONE'),
        existing('RQ-REBASE-phantom-1-cafef00d', 'MERGED'),
      ],
    });
    expect(result.counts.covered).toBe(0);
    expect(result.jobs).toHaveLength(1);
  });

  it('covers PRs named in batch ids and router-queue line text', () => {
    const covered = coveredPrNumbers([
      existing('RQ-REBASE-BATCH-phantom-4010-4011-a1b2c3', 'READY'),
      existing('RQ-REBASE-PH-07', 'CLAIMED', '- CLAIMED 07:31 dispatchd devin RQ-REBASE-PH-07 (P1, pool=devin, tier=work, repo=phantom, after none): rebase https://github.com/ashlrai/phantom/pull/3716 and pull/3718'),
      existing('RQ-REBASE-phantom-4099-bb0cc11', 'PARKED-DEP'),
      existing('RQ-REBASE-phantom-4098-dd00ee1', 'DONE'),
    ], 'ashlrai/phantom');
    expect([...covered].sort()).toEqual([3716, 3718, 4010, 4011, 4099]);
  });

  it('does not cover PRs attributed to a different repo', () => {
    const covered = coveredPrNumbers([
      existing('RQ-REBASE-locus-7-a1b2c3d', 'READY', '', 'locus'),
      existing('RQ-REBASE-PH-99', 'READY', 'rebase pull/4021', 'locus'),       // proven locus — refs not ours
      existing('RQ-REBASE-PH-98', 'READY', 'rebase pull/4023'),               // unattributed — still counts
      existing('RQ-REBASE-BATCH-locus-5-6-abcdef', 'READY'),
    ], 'ashlrai/phantom');
    expect([...covered].sort()).toEqual([4023]);
  });

  it('anchors id coverage on hyphenated repo shorts', () => {
    const covered = coveredPrNumbers([
      existing('RQ-REBASE-phantom-secrets-140-a1b2c3d', 'READY'),
      existing('RQ-REBASE-BATCH-phantom-secrets-168-418-abcdef', 'READY'),
      existing('RQ-REBASE-phantomsecrets-999-deadbee', 'READY'),
    ], 'ashlrai/phantom-secrets');
    expect([...covered].sort()).toEqual([140, 168, 418]);
  });

  it('covers nothing when the repo is unknown — no attribution possible', () => {
    const covered = coveredPrNumbers([
      existing('RQ-REBASE-phantom-4021-a1b2c3d', 'READY'),
      existing('RQ-REBASE-PH-98', 'READY', 'rebase pull/4023'),
    ], null);
    expect(covered.size).toBe(0);
  });

  it('skips hold-list PRs', () => {
    const result = plan([
      conflictedBridge(1, { files: ['s.ts'] }),
      conflictedBridge(2, { files: ['s.ts'] }),
    ], { hold: new Set(['phantom#1']) });
    expect(result.counts).toMatchObject({ conflicting: 2, held: 1, jobs: 1 });
    expect(result.jobs[0]!.prs).toEqual([2]);
  });

  it('produces a router-queue line and prompt with the queuegen grammar', () => {
    const result = plan([
      conflictedBridge(4021, { files: ['s.ts', 'a.ts'] }),
      conflictedBridge(4023, { files: ['s.ts', 'b.ts'] }),
    ]);
    const job = result.jobs[0]!;
    expect(job.line).toMatch(/^- READY RQ-REBASE-BATCH-phantom-\d+-\d+-[0-9a-f]{6} \(P1, pool=any, tier=work, repo=phantom, after none, rebase-plan \d{2}:\d{2}\): /);
    expect(job.line).not.toContain('\n');
    expect(job.promptFile).toBe(`prompts/${job.id}.md`);
    expect(job.prompt).toContain('Rebase-or-supersede 2 conflicting bridge PRs');
    expect(job.prompt.indexOf('#4021')).toBeLessThan(job.prompt.indexOf('#4023'));
    expect(job.prompt).toContain('s.ts');
  });

  it('orders members by the merge-batch least-churn order inside a job', () => {
    // 1 is the hub (rebase wave, last); 2/3/4 are leaves (clean wave… all conflicting → FIFO).
    const result = plan([
      conflictedBridge(1, { files: ['f1.ts', 'f2.ts'], createdAt: hoursAgo(5) }),
      conflictedBridge(2, { files: ['f1.ts'], createdAt: hoursAgo(50) }),
      conflictedBridge(3, { files: ['f2.ts'], createdAt: hoursAgo(40) }),
    ]);
    const job = result.jobs[0]!;
    expect(job.prs[0]).toBe(2); // FIFO: oldest first in the rebase wave
  });

  it('flags jobs whose members carry no file data', () => {
    const result = plan([conflictedBridge(5, { files: [] })]);
    expect(result.jobs[0]!.evidence).toBe('no-file-data');
    expect(result.counts.noFileData).toBe(1);
  });

  it('covers a PR whose rework job is in flight (RQ-RECUT id)', () => {
    const result = plan([conflictedBridge(7, { files: ['a.ts'] }), conflictedBridge(8, { files: ['b.ts'] })], {
      existing: [existing('RQ-RECUT-phantom-7-abc1234', 'RUNNING'), existing('RQ-RECUT-phantom-8-abc1234', 'DONE')],
    });
    expect(result.coverage.coveredPrs).toEqual([7]);
    expect(result.jobs.flatMap(j => j.prs)).toEqual([8]);
  });

  it('drops a conflicting origin replaced by an open rework PR, keeping the rework PR', () => {
    const rework = (number: number, origin: number) =>
      conflictedBridge(number, { title: `bridge: RQ-RECUT-phantom-${origin}-abc1234`, files: ['s.ts'] });
    const result = plan([
      conflictedBridge(10, { files: ['s.ts'] }),
      rework(20, 10),
      rework(21, 10),
      conflictedBridge(11, { files: ['t.ts'] }),
    ]);
    // 10 is replaced; rework 20 is older than 21; 21 (conflicting) is rebased.
    expect(result.counts).toMatchObject({ conflicting: 4, superseded: 2, jobs: 2 });
    expect(result.jobs.flatMap(j => j.prs).sort()).toEqual([11, 21]);
  });

  describe('one rebase attempt per original PR', () => {
    const rebasePr = (number: number, title: string, overrides: Partial<MergeBatchPr> = {}) =>
      conflictedBridge(number, { title: `bridge: ${title}`, ...overrides });

    it('refuses a rebase PR that conflicts again, including hand-run batch ids', () => {
      const result = plan([
        rebasePr(54, 'RQ-REBASE-PH-00'),
        rebasePr(64, 'RQ-REBASE2-PH-00'),
        conflictedBridge(9, { files: ['z.ts'] }),
      ]);
      expect(result.exhausted).toEqual([
        { number: 54, reason: 'is-rebase', via: 54 },
        { number: 64, reason: 'is-rebase', via: 64 },
      ]);
      expect(result.counts).toMatchObject({ conflicting: 3, exhausted: 2, jobs: 1 });
      expect(result.jobs.flatMap(j => j.prs)).toEqual([9]);
    });

    it('refuses an origin an open single or batch rebase PR already names', () => {
      const result = plan([
        conflictedBridge(7, { files: ['a.ts'] }),
        conflictedBridge(8, { files: ['b.ts'] }),
        conflictedBridge(9, { files: ['c.ts'] }),
        conflictedBridge(10, { files: ['d.ts'] }),
        rebasePr(70, 'RQ-REBASE-phantom-7-abc1234', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        rebasePr(71, 'RQ-REBASE-BATCH-phantom-8-9-abcdef', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
      ]);
      expect(result.exhausted).toEqual([
        { number: 7, reason: 'already-rebased', via: 70 },
        { number: 8, reason: 'already-rebased', via: 71 },
        { number: 9, reason: 'already-rebased', via: 71 },
      ]);
      expect(result.jobs.flatMap(j => j.prs)).toEqual([10]);
    });

    it('names the rebase PR itself, not its origin, when both conflict', () => {
      const spent = rebaseAttemptsSpent([
        conflictedBridge(7),
        rebasePr(70, 'RQ-REBASE-phantom-7-abc1234'),
      ], 'ashlrai/phantom');
      expect(spent.get(70)).toEqual({ number: 70, reason: 'is-rebase', via: 70 });
      expect(spent.get(7)).toEqual({ number: 7, reason: 'already-rebased', via: 70 });
    });

    it('ignores rebase PRs of another repo and does nothing without a repo', () => {
      const prs = [conflictedBridge(7, { files: ['a.ts'] }), rebasePr(70, 'RQ-REBASE-other-7-abc1234', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })];
      expect(plan(prs).counts.exhausted).toBe(0);
      expect(rebaseAttemptsSpent(prs, null).size).toBe(0);
    });

    it('leaves first-time rebases and rework PRs alone', () => {
      const result = plan([conflictedBridge(7, { files: ['a.ts'] }), conflictedBridge(8, { title: 'bridge: RQ-RECUT-phantom-99-abc1234', files: ['b.ts'] })]);
      expect(result.exhausted).toEqual([]);
      expect(result.jobs.flatMap(j => j.prs).sort()).toEqual([7, 8]);
    });
  });

  it('defers conflicting PRs behind an overlapping clean PR only when asked', () => {
    const prs = [
      conflictedBridge(1, { files: ['hot.ts'] }),
      conflictedBridge(2, { files: ['cold.ts'] }),
      conflictedBridge(3, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: ['hot.ts'] }),
      conflictedBridge(4, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: true, files: ['cold.ts'] }),
    ];
    expect(plan(prs).counts).toMatchObject({ deferred: 0, jobs: 2 });
    const result = plan(prs, { deferBehindClean: true });
    expect(result.counts).toMatchObject({ conflicting: 2, deferred: 1, jobs: 1 });
    expect(result.jobs[0]!.prs).toEqual([2]);
  });

  it('measures the rebase work saved on a hot-file backlog', () => {
    // 12 conflicting PRs on one hot file, 2 already replaced by rework PRs,
    // 3 clean PRs on the same file about to land: the baseline rebases all 12
    // (and again after each landing), the convergent plan only the survivors.
    const prs: MergeBatchPr[] = [];
    for (let n = 1; n <= 12; n++) prs.push(conflictedBridge(n, { files: ['hot.ts', `own${n}.ts`] }));
    for (let n = 1; n <= 2; n++) {
      prs.push(conflictedBridge(100 + n, { title: `bridge: RQ-RECUT-phantom-${n}-abc1234`, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: ['hot.ts'] }));
    }
    const baseline = plan(prs.map(pr => ({ ...pr, title: pr.title.replace('RQ-RECUT', 'RQ-OTHER') })));
    const convergent = plan(prs, { deferBehindClean: true });
    const rebased = (p: ReturnType<typeof plan>) => p.jobs.flatMap(j => j.prs).length;
    expect(rebased(baseline)).toBe(12);
    expect(convergent.counts).toMatchObject({ superseded: 2, deferred: 10 });
    expect(rebased(convergent)).toBe(0);
  });

  it('rejects an unknown tier and a bad pool', () => {
    expect(() => plan([conflictedBridge(1)], { tier: 'standard' })).toThrow(/unknown tier/);
    expect(() => plan([conflictedBridge(1)], { pool: 'bad pool!' })).toThrow(/invalid pool/);
    expect(() => plan([conflictedBridge(1)], { priority: 'P9' })).toThrow(/invalid priority/);
  });
});

describe('chunkOrder', () => {
  it('chunks along order when members outgrow the cap', () => {
    const adj = new Map<number, Set<number>>([[1, new Set([2])], [2, new Set([1, 3])], [3, new Set([2])]]);
    expect(chunkOrder([1, 2, 3], adj, 2)).toEqual([[1, 2], [3]]);
  });

  it('starts a new chunk when no member is adjacent', () => {
    const adj = new Map<number, Set<number>>([[1, new Set([3])], [3, new Set([1])]]);
    expect(chunkOrder([1, 2, 3], adj, 3)).toEqual([[1, 3], [2]]);
  });
});

describe('parseHoldList', () => {
  it('parses short and owner/name entries, skipping comments', () => {
    const hold = parseHoldList('# comment\nphantom#197 ashlrai/phantom#878\nlocus#140\n');
    expect(hold.has('phantom#197')).toBe(true);
    expect(hold.has('ashlrai/phantom#878')).toBe(true);
    expect(hold.has('locus#140')).toBe(true);
    expect(hold.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface RunResult { code: number; out: string; err: string }

const OPEN_PRS = JSON.stringify([
  { number: 4021, title: 'bridge: RQ-A', headRefName: 'bridge/a', headRefOid: SHA.slice(0, 40), isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', createdAt: hoursAgo(9), updatedAt: hoursAgo(1), files: [{ path: 's.ts' }, { path: 'a.ts' }] },
  { number: 4023, title: 'bridge: RQ-B', headRefName: 'bridge/b', headRefOid: 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', createdAt: hoursAgo(8), updatedAt: hoursAgo(1), files: [{ path: 's.ts' }, { path: 'b.ts' }] },
  { number: 4025, title: 'bridge: RQ-C', headRefName: 'bridge/c', headRefOid: 'c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', createdAt: hoursAgo(7), updatedAt: hoursAgo(1), files: [{ path: 'solo.ts' }] },
  { number: 4027, title: 'docs: clean', headRefName: 'x', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', createdAt: hoursAgo(6), updatedAt: hoursAgo(1), files: [{ path: 's.ts' }] },
]);

async function run(args: string[], opts: { stdinText?: string | null; files?: Record<string, string> } = {}): Promise<RunResult> {
  let out = '';
  let err = '';
  const deps: FleetRebasePlanDeps = {
    stdin: Readable.from(opts.stdinText === null || opts.stdinText === undefined ? [] : [opts.stdinText]),
    stdinIsTty: opts.stdinText === undefined || opts.stdinText === null,
    root: '/runs',
    queueDir: '/runs/queue',
    now: () => NOW,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  };
  deps.readText = async (path: string) => {
    if (opts.files && path in opts.files) return opts.files[path]!;
    throw new Error('ENOENT');
  };
  const code = await cmdFleetRebasePlan(args, deps);
  return { code, out, err };
}

describe('phm fleet rebase-plan', () => {
  it('plans a piped snapshot: cluster + single job specs', async () => {
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.schema).toBe(REBASE_PLAN_SCHEMA);
    expect(report.counts).toMatchObject({ open: 4, conflicting: 3, jobs: 2, clusters: 1, singles: 1 });
    const cluster = report.jobs.find((j: { kind: string }) => j.kind === 'cluster')!;
    expect(cluster.prs.sort()).toEqual([4021, 4023]);
    expect(cluster.line).toContain('- READY RQ-REBASE-BATCH-phantom-4021-4023-');
    expect(report.coverage.state).toBe('missing'); // no queue files injected
  });

  it('excludes conflicting PRs already queued in ready.tsv and router-queue.md', async () => {
    const files = {
      '/runs/queue/ready.tsv': 'RQ-REBASE-phantom-4021-a1b2c3d\tphantom\tdevin\twork\t/runs/queue/prompts/RQ-REBASE-phantom-4021-a1b2c3d.md\n',
      '/runs/queue/router-queue.md': '- READY RQ-OTHER-1 (P1, pool=any, tier=work, repo=phantom, after none): something else\n- CLAIMED 11:00 dispatchd devin RQ-REBASE-phantom-4025-ffff00f (P0, pool=devin, tier=work, repo=phantom, after none): REBASE phantom#4025 …\n',
    };
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS, files });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.coverage.state).toBe('ok');
    expect(report.coverage.coveredPrs.sort()).toEqual([4021, 4025]);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].prs).toEqual([4023]);
  });

  it('counts status-first parked ready.tsv rows as coverage', async () => {
    const files = {
      '/runs/queue/ready.tsv': 'PARKED-DEP.devin\tRQ-REBASE-phantom-4021-a1b2c3d\tdevin\twork\tphantom\t/runs/queue/prompts/x.md\nPARKED-MERGERATE.devin\tRQ-REBASE-phantom-4023-b2b2c3d\tdevin\twork\tphantom\t/runs/queue/prompts/y.md\n',
      '/runs/queue/router-queue.md': '',
    };
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS, files });
    const report = JSON.parse(result.out);
    expect(report.coverage.coveredPrs.sort()).toEqual([4021, 4023]);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].prs).toEqual([4025]);
  });

  it('emits router-queue lines with --emit lines', async () => {
    const result = await run(['--emit', 'lines', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    const lines = result.out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every(l => l.startsWith('- READY RQ-REBASE'))).toBe(true);
    expect(lines.some(l => l.includes('RQ-REBASE-BATCH-phantom-4021-4023'))).toBe(true);
    expect(lines.some(l => l.includes('RQ-REBASE-phantom-4025-'))).toBe(true);
  });

  it('emits ready.tsv rows with --emit rows (and warns on pool=any)', async () => {
    const result = await run(['--emit', 'rows', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    expect(result.err).toContain("pool 'any'");
    const rows = result.out.trim().split('\n');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = row.split('\t');
      expect(cells).toHaveLength(5);
      expect(cells[0]).toMatch(/^RQ-REBASE/);
      expect(cells[1]).toBe('phantom');
      expect(cells[2]).toBe('any');
      expect(cells[3]).toBe('work');
      expect(cells[4]).toBe(`/runs/queue/prompts/${cells[0]}.md`);
    }
  });

  it('applies --pool/--tier/--priority/--max-prs to the specs', async () => {
    const result = await run(['--json', '--repo', 'ashlrai/phantom', '--pool', 'devin', '--tier', 'mid', '--priority', 'P0', '--max-prs', '1'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    for (const job of report.jobs) {
      expect(job.pool).toBe('devin');
      expect(job.tier).toBe('mid');
      expect(job.priority).toBe('P0');
      expect(job.line).toContain('(P0, pool=devin, tier=mid');
    }
    expect(report.jobs).toHaveLength(3); // max-prs 1 → all singles
  });

  it('honors the hold-list file', async () => {
    const files = { '/runs/queue/hold-list.txt': 'phantom#4021\nphantom#4023\n' };
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS, files });
    const report = JSON.parse(result.out);
    expect(report.counts.held).toBe(2);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].prs).toEqual([4025]);
    expect(report.sources.hold).toBe('ok');
  });

  it('exits 1 with an honest input.state when no snapshot exists', async () => {
    const result = await run(['--json'], { stdinText: null });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.schema).toBe(REBASE_PLAN_SCHEMA);
    expect(report.input.state).toBe('missing');
    expect(report.jobs).toEqual([]);
  });

  it('exits 1 on malformed JSON', async () => {
    const result = await run(['--json'], { stdinText: 'not json{' });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).input.state).toBe('malformed');
  });

  it('exits 1 when the snapshot envelope says its upstream read failed', async () => {
    const degraded = JSON.stringify({ v: 1, repo: 'ashlrai/phantom', source: 'gh-failed', items: [] });
    const result = await run(['--json'], { stdinText: degraded });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).input.upstream).toBe('gh-failed');
  });

  it('prints a human summary without --json', async () => {
    const result = await run(['--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    expect(result.out).toContain('3 conflicting bridge PRs → 2 job(s)');
    expect(result.out).toContain('RQ-REBASE-BATCH-phantom-4021-4023');
  });

  it('exits 2 on bad usage and 0 on --help', async () => {
    expect((await run(['--bogus'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--emit', 'yaml'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--tier', 'standard'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--max-prs', '0'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--priority', 'P9'], { stdinText: OPEN_PRS })).code).toBe(2);
    const help = await run(['--help'], { stdinText: OPEN_PRS });
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet rebase-plan');
  });
});
