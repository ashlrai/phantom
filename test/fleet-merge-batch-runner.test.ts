import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdFleetMergeBatchRun, type FleetMergeBatchRunDeps } from '../src/cli/fleet-merge-batch-run.js';
import { MAX_FILES_PER_PR, MAX_PRS, parseMergeBatchPrs, planMergeBatches, type MergeBatchPr } from '../src/core/fleet/merge-batch.js';
import { classifyMergeBatchRisk, runMergeBatch, type MergeBatchRun, type MergeBatchRunInput } from '../src/core/fleet/merge-batch-runner.js';
import type { GreenMergeTrain } from '../src/core/fleet/green-merge-train.js';

const now = new Date('2026-11-14T10:00:00Z');
const repo = 'ashlrai/phantom';
const pr = (number: number, files = [`src/feature-${number}.ts`], patch: Partial<MergeBatchPr> = {}): MergeBatchPr => ({
  number, title: `bridge: RQ-FEATURE-${number}`, headRef: `bridge/feature-${number}`, headSha: number.toString(16).padStart(40, '0'),
  files, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, createdAt: now.toISOString(), updatedAt: null, ...patch,
});
const run = (prs: MergeBatchPr[], extra: Partial<MergeBatchRunInput> = {}) =>
  runMergeBatch({ plan: planMergeBatches({ prs, repo, now }), prs, ...extra });
const wire = (p: MergeBatchPr) => ({ ...p, headRefName: p.headRef, headRefOid: p.headSha, files: p.files.map(path => ({ path })) });

describe('merge-batch next actions', () => {
  it('enqueues disjoint batches together and is deterministic without mutating the snapshot', () => {
    const prs = [pr(1), pr(2, ['docs/guide.md']), pr(3, ['test/feature.test.ts'])];
    const before = JSON.stringify(prs);
    const result = run(prs);
    expect(result.actions.map(a => [a.kind, a.ready, a.afterMerged])).toEqual(Array(3).fill(['enqueue-merge', true, []]));
    expect(new Set(result.actions.map(a => a.batch)).size).toBe(3);
    expect(result.actions.map(a => a.ci)).toEqual(['full', 'targeted', 'targeted']);
    expect(run(prs)).toEqual(result);
    expect(JSON.stringify(prs)).toBe(before);
  });

  it('parallelizes the independent clean wave inside a component and defers its overlapping successor', () => {
    const result = run([pr(1, ['a.ts']), pr(2, ['a.ts', 'b.ts']), pr(3, ['b.ts'])]);
    expect(result.actions.filter(a => a.kind === 'enqueue-merge').map(a => a.number)).toEqual([1, 3]);
    expect(result.actions.find(a => a.number === 2)).toMatchObject({ kind: 'rebase', ready: false,
      afterMerged: [1, 3], job: { status: 'WAITING', afterMerged: [1, 3] } });
  });

  it('serializes dirty overlapping heads and releases a successor only after replanning', () => {
    const dirty = { mergeStateStatus: 'DIRTY' as const, mergeable: 'CONFLICTING' as const };
    const prs = [pr(1, ['a.ts'], dirty), pr(2, ['a.ts'], dirty), pr(3, ['a.ts'], dirty)];
    const result = run(prs);
    expect(result.actions.map(a => [a.kind, a.ready, a.afterMerged])).toEqual([
      ['rebase', true, []], ['rebase', false, [1]], ['rebase', false, [2]],
    ]);
    expect(result.actions[0]!.job).toMatchObject({ id: 'RQ-REBASE-phantom-1-0000000', repo, tier: 'work', status: 'READY' });
    expect(run(prs.slice(1)).actions[0]).toMatchObject({ number: 2, ready: true, afterMerged: [] });
  });

  it.each([{ mergeStateStatus: 'DIRTY' }, { mergeable: 'CONFLICTING' as const }, { mergeStateStatus: 'BEHIND' }])(
    'routes stale/conflicted evidence to rebase: %j', patch => {
      expect(run([pr(1, ['a.ts'], patch)]).actions[0]).toMatchObject({ kind: 'rebase', ready: true });
    });

  it.each([{ isDraft: true }, { mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'UNKNOWN' as const }, { headSha: null }, { headSha: 'abcdef0' }, { files: [] }, { filesComplete: false }])(
    'withholds merge with missing or ineligible evidence: %j', patch => {
      expect(run([pr(1, ['a.ts'], patch)]).actions[0]).toMatchObject({ kind: 'wait', ready: false, job: null });
    });

  it('reserves case-folded aliases even when the planner puts them in different batches', () => {
    expect(run([pr(1, ['src/A.ts']), pr(2, ['src/a.ts'])]).actions[1]).toMatchObject({ kind: 'rebase', afterMerged: [1], ready: false });
  });

  it('flags explicit recut origins and stale recuts for review without merging or rebasing them', () => {
    const prs = [pr(1), pr(2, ['a.ts'], { title: 'bridge: RQ-RECUT-phantom-1-abcdef0' }),
      pr(3, ['a.ts'], { title: 'bridge: RQ-RECUT-phantom-1-abcdef1' })];
    expect(run(prs).actions.filter(a => a.kind === 'close-review').map(a => a.number).sort()).toEqual([1, 2]);
    expect(run(prs).actions.find(a => a.number === 3)).toMatchObject({ kind: 'enqueue-merge', ready: true, afterMerged: [] });
    expect(run([prs[0]!, { ...prs[1]!, isDraft: true }]).actions[0]!.kind).toBe('enqueue-merge');
    expect(run([pr(1), pr(2, ['b.ts'], { title: pr(1).title })]).counts['close-review']).toBe(0);
  });

  it('retains holds, active-job coverage and the one-rebase-attempt rule', () => {
    const prs = [pr(1), pr(2), pr(3, ['c.ts'], { title: 'bridge: RQ-REBASE-phantom-9-abcdef0', mergeStateStatus: 'DIRTY' })];
    const result = run(prs, { hold: new Set(['phantom#1']),
      existing: [{ id: 'RQ-REBASE-phantom-2-abcdef0', status: 'RUNNING', text: '' }] });
    expect(result.actions.map(a => a.reason)).toEqual(['held', 'active-job', 'rebase-attempt-spent']);
  });

  it.each(['src/core/authority/gates.ts', '.github/workflows/ci.yml', 'package.json',
    'test/protected-paths.test.ts', 'contrib/mac/dispatchd.py'])(
    'keeps protected paths out of targeted CI: %s', file => {
      expect(classifyMergeBatchRisk(pr(1, [file, 'docs/guide.md']))).toBe('protected');
    });
  it('handles invalid, capped and Tier-1-importing test evidence conservatively', () => {
    expect(classifyMergeBatchRisk(pr(1, ['../bad', 'docs/ok.md']))).toBe('unknown');
    expect(classifyMergeBatchRisk(pr(1, Array(MAX_FILES_PER_PR).fill('docs/a.md')))).toBe('unknown');
    expect(classifyMergeBatchRisk(pr(1, ['test/feature.test.ts']), new Set(['test/feature.test.ts']))).toBe('protected');
    const parsed = parseMergeBatchPrs([{ ...wire(pr(1)), files: [{ path: 'docs/ok.md' }, { path: '../bad' }] }]);
    expect(parsed.ok && run(parsed.prs).actions[0]).toMatchObject({ kind: 'wait', riskTier: 'unknown' });
  });

  it('rejects mismatched/oversized plans and suppresses actions on incomplete snapshots', () => {
    const prs = [pr(1)];
    expect(run(prs, { snapshotComplete: false }).actions[0]!.reason).toBe('incomplete-snapshot');
    expect(() => run(prs, { plan: planMergeBatches({ prs: [pr(2)], now }) })).toThrow('membership');
    expect(() => run(prs, { plan: planMergeBatches({ prs: [pr(1, [], { isDraft: true })], now }) })).toThrow('evidence');
    expect(() => runMergeBatch({ prs: Array(MAX_PRS + 1).fill(pr(1)), plan: planMergeBatches({ prs: [], now }) })).toThrow('oversized');
  });
});

async function cli(value: unknown, args = ['--repo', repo], deps: FleetMergeBatchRunDeps = {}) {
  let output = ''; let error = '';
  const code = await cmdFleetMergeBatchRun(args, { stdin: Readable.from([JSON.stringify(value)]), stdinIsTty: false,
    now: () => now, existing: [], hold: new Set(), stdout: text => { output += text; }, stderr: text => { error += text; }, ...deps });
  return { code, output, error, report: output.startsWith('{') ? JSON.parse(output) as MergeBatchRun & { error?: string; train: GreenMergeTrain | null } : null };
}

const checked = (number: number, patch: Record<string, unknown> = {}) => ({ ...wire(pr(number)),
  state: 'OPEN', baseRefName: 'master', changedFiles: 1,
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'Merge Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...patch });

describe('green merge train proposals', () => {
  it('combines green disjoint heads deterministically without mutating input', async () => {
    const rows = [checked(3), checked(1), checked(2, {
      statusCheckRollup: [{ __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' },
        ...['SKIPPED', 'NEUTRAL'].map(conclusion => ({ __typename: 'CheckRun', name: conclusion, status: 'COMPLETED', conclusion }))],
    })];
    const before = JSON.stringify(rows);
    const train = (await cli(rows)).report!.train!;
    expect(train).toMatchObject({ authority: 'proposal-only', validation: 'required-checks-on-combined-commit',
      baseRef: 'master', members: [1, 2, 3].map(number => ({ number, headSha: pr(number).headSha })), deferred: [] });
    expect((await cli([...rows].reverse())).report!.train).toEqual(train);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it.each([undefined, [], Array(100).fill({ __typename: 'StatusContext', context: 'ci', state: 'SUCCESS' }),
    [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: 'SUCCESS' }],
    ...['FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'TIMED_OUT'].map(conclusion => [
      { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion },
    ]), [null], [{ state: 'SUCCESS' }], [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }],
    ['SUCCESS', 'FAILURE'].map(state => ({ __typename: 'StatusContext', context: state, state }))]
    .map((statusCheckRollup, index) => ({ statusCheckRollup, index })))(
    'withholds missing, pending, failed, capped and unfamiliar checks #$index', async ({ statusCheckRollup }) => {
      const train = (await cli([checked(1, { statusCheckRollup })])).report!.train!;
      expect(train.members).toEqual([]);
      expect(train.deferred).toEqual([{ number: 1, reason: 'checks-not-green' }]);
    });
  it('keeps holds, active jobs, overlaps, drafts, base mismatches and file completeness out', async () => {
    const rows = [checked(1), checked(2), checked(3), checked(4, { files: [{ path: 'src/feature-3.ts' }] }),
      checked(5, { isDraft: true }), checked(6, { baseRefName: 'release' }), checked(7, { changedFiles: 2 }),
      checked(8, { baseRefName: undefined }), checked(9, { mergeStateStatus: 'BEHIND' }),
      checked(10, { files: [{ path: '../invalid' }] })];
    const train = (await cli(rows, ['--repo', repo], { hold: new Set(['phantom#1']),
      existing: [{ id: 'RQ-REBASE-phantom-2-abcdef0', status: 'RUNNING', text: '' }] })).report!.train!;
    expect(train.members.map(member => member.number)).toEqual([3]);
    expect(train.deferred).toEqual(expect.arrayContaining([
      { number: 1, reason: 'held' }, { number: 2, reason: 'active-job' },
      { number: 4, reason: 'after-overlapping-merges' }, { number: 5, reason: 'draft' },
      { number: 6, reason: 'different-base' }, { number: 7, reason: 'incomplete-files' },
      { number: 8, reason: 'missing-identity' }, { number: 9, reason: 'base-sync-required' },
      { number: 10, reason: 'incomplete-files' },
    ]));
  });
  it('never combines case-folded file aliases', async () => {
    const train = (await cli([checked(1), checked(2, { files: [{ path: 'SRC/FEATURE-1.TS' }] })])).report!.train!;
    expect(train.members).toHaveLength(1);
    expect(train.deferred).toHaveLength(1);
  });
  it('bounds a train and withholds it when hold or queue evidence is unreadable', async () => {
    const rows = Array.from({ length: 17 }, (_, i) => checked(i + 1));
    const train = (await cli(rows)).report!.train!;
    expect(train.members).toHaveLength(16);
    expect(train.deferred).toEqual([{ number: 17, reason: 'train-limit' }]);
    for (const missing of [{ hold: undefined }, { existing: undefined }]) {
      const result = await cli(rows, ['--repo', repo], { ...missing, readText: async () => { throw new Error('missing'); } });
      expect(result.report!.train).toBeNull();
    }
  });
});

describe('fleet merge-batch-run CLI', () => {
  it('retains explicit merged supersession evidence from hygiene even without file data', async () => {
    const result = await cli({ schema: 'fleet.pr-hygiene.v1', repo, reads: { open: 'ok' }, items: [
      { number: 1, flags: ['superseded'], supersededBy: { number: 9 } },
      { number: 2, flags: ['superseded'] },
    ] });
    expect(result.report!.actions).toMatchObject([
      { kind: 'close-review', reason: 'superseded-by-merged-pr:9', job: null },
      { kind: 'wait', reason: 'incomplete-files' },
    ]);
  });
  it('reads existing queue jobs and holds without dispatching duplicate work', async () => {
    const result = await cli([wire(pr(1)), wire(pr(2))], ['--repo', repo, '--root', '/fixture'], {
      existing: undefined, hold: undefined, readText: async path => path.endsWith('hold-list.txt') ? 'phantom#1\n'
        : path.endsWith('ready.tsv') ? 'RQ-REBASE-phantom-2-abcdef0\tphantom\tany\twork\tprompt.md\n' : '',
    });
    expect(result.report!.actions.map(a => a.reason)).toEqual(['held', 'active-job']);
  });
  it('runs the snapshot-plan-actions pipeline from stdin and a state file', async () => {
    const snapshot = [wire(pr(1)), wire(pr(2, ['docs/guide.md'], { mergeStateStatus: 'DIRTY' }))];
    const piped = await cli(snapshot);
    expect(piped.code).toBe(0);
    expect(piped.report!.counts).toEqual({ 'enqueue-merge': 1, rebase: 1, 'close-review': 0, wait: 0 });
    const state = await cli(null, ['--repo', repo, '--root', '/fixture', '--json'], { stdinIsTty: true,
      readText: async path => { expect(path).toBe('/fixture/fleet/open-prs.json'); return JSON.stringify(snapshot); } });
    expect(state.report!.actions).toEqual(piped.report!.actions);
  });
  it.each([
    [{ items: [], source: 'gh-failed', repo }, 'upstream-failed'],
    [{ items: [], complete: false, repo }, 'incomplete-snapshot'],
    [[wire(pr(1)), null], 'incomplete-snapshot'],
    [[wire(pr(1)), wire(pr(1))], 'incomplete-snapshot'],
    [{ items: [], repo: 'other/repo' }, 'repo-mismatch'],
    [[{ ...wire(pr(1)), state: 'CLOSED' }], 'not-open-snapshot'],
  ])('returns an empty error report for unusable evidence %j', async (snapshot, error) => {
    const result = await cli(snapshot);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ error, actions: [] });
  });
  it('reports missing files, malformed JSON and usage errors', async () => {
    expect((await cli(null, ['--input', '/missing'], { readText: async () => { throw new Error('private diagnostic'); } })).report)
      .toMatchObject({ error: 'unreadable', actions: [] });
    expect((await cli(null, ['--input', '-'], { stdin: Readable.from(['{']) })).report!.error).toBe('malformed-json');
    expect((await cli([], ['--root', 'relative'])).code).toBe(2);
    expect((await cli([], ['--apply'])).code).toBe(2);
    expect((await cli([], ['--help'])).output).toContain('Usage: phm fleet merge-batch-run');
  });
});
