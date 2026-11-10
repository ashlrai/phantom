import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFleetEvalReport,
  foldJobsLedger,
  formatFleetEvalReport,
  parseGhPullRequests,
  FLEET_EVAL_OBSERVATION_WINDOW_MS,
  type EvalObservationRow,
  type FleetEvalReport,
} from '../src/core/fleet/eval-report.js';
import { cmdFleetEvalReport } from '../src/cli/fleet-eval-report.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { PostMergeObservationReadResult } from '../src/core/fleet/post-merge-observations.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const FIXTURES = join(__dirname, 'fixtures', 'fleet-eval-report');
const jobsFixture = () => readFile(join(FIXTURES, 'jobs.jsonl'), 'utf8');
const prsFixture = () => readFile(join(FIXTURES, 'prs.json'), 'utf8');

const observations = (rows: EvalObservationRow[]): NonNullable<Parameters<typeof buildFleetEvalReport>[0]['observations']> =>
  ({ sourceState: 'healthy', rows });

const OBS: EvalObservationRow[] = [
  // Loses to the deterministic gh revert of PR #100 (reverted > followed-up).
  { mergeCommit: 'aa10000000000000000000000000000000000001', outcome: 'followed-up', confidence: 'deterministic' },
  { mergeCommit: 'cc30000000000000000000000000000000000003', outcome: 'regressed', confidence: 'heuristic' },
  { mergeCommit: 'ee50000000000000000000000000000000000005', outcome: 'reverted', confidence: 'deterministic' },
];

const build = async (over: Partial<Parameters<typeof buildFleetEvalReport>[0]> = {}): Promise<FleetEvalReport> =>
  buildFleetEvalReport({
    jobsText: await jobsFixture(),
    prsTexts: [await prsFixture()],
    observations: observations(OBS),
    nowMs: NOW,
    ...over,
  });

const pr = (report: FleetEvalReport, url: string) =>
  report.pullRequests.find((p) => p.url.endsWith(url));
const lane = (report: FleetEvalReport, name: string) => report.byLane.find((g) => g.name === name);
const tier = (report: FleetEvalReport, name: string) => report.byTier.find((g) => g.name === name);
const repo = (report: FleetEvalReport, name: string) => report.byRepo.find((g) => g.name === name);

afterEach(() => vi.restoreAllMocks());

describe('foldJobsLedger', () => {
  it('folds dispatchd rows into jobs, url-keyed outcomes and attributed activity', async () => {
    const since = NOW - 7 * 86_400_000;
    const fold = foldJobsLedger(await jobsFixture(), since, NOW);
    expect(fold.counts).toMatchObject({ rows: 25, events: 24, ignored: 1 });
    expect(fold.jobByUrl.get('https://github.com/ashlrai/phantom/pull/101')).toBe('RQ-B');
    expect(fold.outcomes.get('https://github.com/ashlrai/phantom/pull/103')).toMatchObject({ state: 'MERGED', ttmS: null });
    // prUrl-only outcome rows still join through the publish row's url→job map.
    expect(fold.outcomes.get('https://github.com/ashlrai/phantom/pull/103')?.jobId).toBe('RQ-E');
    const finished = fold.activity.filter((a) => a.kind === 'finish');
    expect(finished).toHaveLength(3);
    expect(finished.filter((a) => a.failed)).toHaveLength(1);
    expect(finished.filter((a) => a.empty)).toHaveLength(1);
    // Publish rows borrow the producing job's latest route even when missing fields.
    expect(fold.activity.filter((a) => a.kind === 'publish' && a.lane === 'devin')).toHaveLength(3);
    // Out-of-window launch (RQ-OLD) is not an activity event.
    expect(fold.activity.filter((a) => a.kind === 'launch')).toHaveLength(6);
  });
});

describe('parseGhPullRequests', () => {
  it('parses array exports, JSONL and the search-API repository shape', async () => {
    const { rows, ignored } = parseGhPullRequests(await prsFixture());
    expect(ignored).toBe(0);
    expect(rows).toHaveLength(8);
    const p100 = rows.find((r) => r.number === 100)!;
    expect(p100.mergeCommit).toBe('aa10000000000000000000000000000000000001');
    expect(p100.checks).toBeNull();
    const p103 = rows.find((r) => r.number === 103)!;
    expect(p103.checks).toBeNull();
    // JSONL plus repository.nameWithOwner fallback.
    const jsonl = [
      JSON.stringify({ number: 7, title: 'x', state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z', repository: { nameWithOwner: 'ashlrai/phantom' } }),
      'garbage{',
    ].join('\n');
    const parsed = parseGhPullRequests(jsonl);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.key).toBe('https://github.com/ashlrai/phantom/pull/7');
    expect(parsed.ignored).toBe(1);
    expect(parseGhPullRequests('')).toEqual({ rows: [], ignored: 0 });
  });
});

describe('buildFleetEvalReport', () => {
  it('classifies every merged PR with the worst evidence across channels', async () => {
    const report = await build();
    expect(pr(report, '/pull/100')).toMatchObject({
      jobId: 'RQ-A', lane: 'devin', tier: 'work', model: 'swe-2',
      durability: 'reverted', durabilityBasis: 'gh-revert', durabilityConfidence: 'deterministic',
      ttm_s: 36000, ttmSource: 'ledger', checkState: 'unknown',
    });
    expect(pr(report, '/pull/101')).toMatchObject({
      jobId: 'RQ-B', lane: 'codex', tier: 'fast',
      durability: 'followed-up', durabilityBasis: 'gh-follow-up', durabilityConfidence: 'heuristic',
      checkState: 'unknown', failedChecks: null, jobFinishFailed: true,
    });
    expect(pr(report, '/pull/103')).toMatchObject({
      jobId: 'RQ-E', lane: 'claude-api', durability: 'regressed',
      durabilityBasis: 'observation-ledger', ttm_s: 28800, ttmSource: 'derived',
    });
    expect(pr(report, '/pull/104')).toMatchObject({ jobId: null, durability: 'stable' });
    expect(pr(report, '/pull/105')).toMatchObject({ durability: 'reverted', durabilityBasis: 'observation-ledger' });
    expect(pr(report, '/pull/106')).toMatchObject({ jobId: null, durability: 'stable' });
    expect(pr(report, '/pull/50')).toMatchObject({ jobId: 'RQ-C', durability: 'pending' });
    expect(pr(report, '/pull/9')).toMatchObject({ jobId: 'RQ-F', lane: 'stack', durability: 'unobserved' });
    // Outside the window: PR #90 merged 2026-10-05 never enters the cohort.
    expect(report.pullRequests.some((p) => p.url.endsWith('/pull/90'))).toBe(false);
  });

  it('rolls merges, fleetIQ and per-lane/tier/repo groups up honestly', async () => {
    const report = await build();
    expect(report.schema).toBe('fleet.eval-report.v1');
    expect(report.merges).toMatchObject({
      total: 8, attributed: 5, unattributed: 3,
      stable: 2, reverted: 2, regressed: 1, followedUp: 1, pending: 1, unobserved: 1,
      resolved: 6, fleetIQ: 33.3,
    });
    expect(report.jobs).toMatchObject({
      launched: 6, finished: 3, failedFinishes: 1, emptyFinishes: 1,
      published: 6, merged: 5, closed: 1,
    });
    expect(lane(report, 'devin')).toMatchObject({ launched: 3, finished: 2, emptyFinishes: 1, published: 3, closed: 1, merged: 2, reverted: 1, pending: 1 });
    expect(lane(report, 'devin')!.durability.resolved).toBe(1);
    expect(lane(report, 'codex')).toMatchObject({ launched: 1, failedFinishes: 1, merged: 1, followedUp: 1 });
    expect(lane(report, 'claude-api')).toMatchObject({ merged: 1, regressed: 1 });
    expect(lane(report, 'stack')).toMatchObject({ merged: 1, unobserved: 1 });
    expect(tier(report, 'work')).toMatchObject({ launched: 4, merged: 4, reverted: 1, regressed: 1, pending: 1, unobserved: 1 });
    expect(tier(report, 'mid')).toMatchObject({ launched: 1, closed: 1, merged: 0 });
    expect(repo(report, 'ashlrai/phantom')).toMatchObject({ merged: 6, stable: 2, reverted: 2, regressed: 1, followedUp: 1 });
    expect(repo(report, 'ashlrai/phantom')!.durability.rate).toBeCloseTo(2 / 6);
    // Wilson lower bound ranks the 2/6 repo above every 0/1 lane.
    expect(report.ranked[0]).toMatchObject({ kind: 'repo', name: 'ashlrai/phantom', resolved: 6 });
  });

  it('reports ledger ttm, derived merge lead and raw CI correlation', async () => {
    const report = await build();
    expect(report.timeToMerge).toMatchObject({ measured: 2, median_s: 20000, p90_s: 36000 });
    expect(report.mergeLead.measured).toBe(5);
    expect(report.mergeLead.median_s).toBe(36000);
    expect(report.ci).toMatchObject({
      measured: 0, unknown: 8, clean: { merged: 0 }, failedChecks: { merged: 0 },
      jobFinishFailed: { merged: 1, adverse: 1 }, direction: 'insufficient-data',
    });
  });

  it('counts only required head-bound checks observed by merge time', () => {
    const head = 'a'.repeat(40);
    const check = (name: string, conclusion: string, extra = {}) => ({
      name, conclusion, status: 'COMPLETED', headSha: head,
      completedAt: '2026-11-01T09:00:00Z', ...extra,
    });
    const base = { url: 'https://github.com/ashlrai/phantom/pull/300', state: 'MERGED',
      mergedAt: '2026-11-01T10:00:00Z', headRefOid: head, requiredChecks: ['gate'] };
    const parse = (row: object) => parseGhPullRequests(JSON.stringify(row)).rows[0]!.checks;
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'SUCCESS'), check('optional', 'FAILURE')] }))
      .toMatchObject({ total: 1, failed: 0 });
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'FAILURE')] })).toMatchObject({ failed: 1 });
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'STALE')] })).toMatchObject({ pending: 1, failed: 0 });
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'FAILURE', { headSha: 'b'.repeat(40) })] })).toBeNull();
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'FAILURE', { completedAt: '2026-11-01T11:00:00Z' })] })).toBeNull();
    expect(parse({ ...base, statusCheckRollup: [check('gate', 'FAILURE'), check('gate', 'SUCCESS')] })).toBeNull();
    expect(parse({ ...base, requiredChecks: undefined, statusCheckRollup: [check('gate', 'FAILURE')] })).toBeNull();
    expect(parse({ ...base, state: 'OPEN', mergedAt: null, statusCheckRollup: [check('gate', 'FAILURE')] }))
      .toMatchObject({ failed: 1 });
    expect(parse({ ...base, state: 'OPEN', mergedAt: null, statusCheckRollup: [check('optional', 'FAILURE')] })).toBeNull();
  });

  it('keeps merges unobserved without a covering evidence channel', async () => {
    const noGh = await build({ prsTexts: [] });
    expect(noGh.sources.pullRequests.state).toBe('absent');
    // With no gh channel the ledger alone classifies: #101 and #9 stay
    // unobserved (window elapsed, nothing covering them) and are never
    // credited; #100 keeps its ledger follow-up, #103 its regression.
    expect(pr(noGh, '/pull/101')!.durability).toBe('unobserved');
    expect(pr(noGh, '/pull/9')!.durability).toBe('unobserved');
    expect(pr(noGh, '/pull/100')!.durability).toBe('followed-up');
    expect(noGh.merges.unobserved).toBe(2);
    const noObs = await build({ observations: null });
    expect(noObs.sources.observations.state).toBe('disabled');
    // Without the ledger, PR #103 is stable (window elapsed, gh row present).
    expect(pr(noObs, '/pull/103')).toMatchObject({ durability: 'stable' });
    // And PR #105 falls back to gh evidence: no adverse row → stable.
    expect(pr(noObs, '/pull/105')).toMatchObject({ durability: 'stable' });
  });

  it('honours --days/--until windowing and a missing jobs ledger', async () => {
    const report = await build({ windowDays: 1, untilMs: Date.parse('2026-11-07T00:00:00Z') });
    expect(report.window.days).toBe(1);
    // Only the 2026-11-06 merge survives [11-06, 11-07).
    expect(report.merges.total).toBe(1);
    expect(pr(report, '/pull/50')).toMatchObject({ durability: 'pending' });
    const ghOnly = await build({ jobsText: null });
    expect(ghOnly.sources.jobs.state).toBe('missing');
    expect(ghOnly.merges.total).toBe(7);
    expect(ghOnly.merges.unattributed).toBe(7);
    expect(ghOnly.jobs.launched).toBe(0);
  });

  it('marks a malformed gh export degraded without dropping parsed rows', async () => {
    const report = await build({ prsTexts: [await prsFixture(), '{broken'] });
    expect(report.sources.pullRequests).toMatchObject({ files: 2, rows: 8, ignored: 1, state: 'degraded' });
  });
});

describe('formatFleetEvalReport', () => {
  it('renders a readable weekly summary', async () => {
    const text = formatFleetEvalReport(await build());
    expect(text).toContain('Fleet IQ (7d');
    expect(text).toContain('33.3 durable');
    expect(text).toContain('By lane');
    expect(text).toContain('devin: 2 merged');
    expect(text).toContain('Most durable');
  });
});

describe('cmdFleetEvalReport', () => {
  const depsFor = async () => ({
    read: async (path: string) => {
      if (path === join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')) return jobsFixture();
      if (path === 'prs.json') return prsFixture();
      return null;
    },
    observations: () => ({
      sourceState: 'healthy', observations: OBS.map((o) => ({ ...o })),
    }) as unknown as PostMergeObservationReadResult,
    now: () => NOW,
  });

  it('prints JSON, wires args, and registers the verb', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = await depsFor();
    expect(await cmdFleetEvalReport(['--json', '--prs', 'prs.json'], deps)).toBe(0);
    const report = JSON.parse(String(out.mock.calls[0]![0])) as FleetEvalReport;
    expect(report.schema).toBe('fleet.eval-report.v1');
    expect(report.merges.total).toBe(8);
    expect(await cmdFleetEvalReport(['--days', '1', '--prs', 'prs.json'], deps)).toBe(0);
    expect(String(out.mock.lastCall![0])).toContain('Fleet IQ (1d');
    expect(await cmdFleetEvalReport(['--help'])).toBe(0);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['eval-report']!()).cmdFleetEvalReport).toBe('function');
  });

  it('rejects bad args, reports empty inputs and degrades missing --prs files', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = await depsFor();
    for (const args of [['--days'], ['--days', '0'], ['--days', '1.5'], ['--until', 'never'], ['--json', '--json'], ['bogus'], ['--prs']]) {
      expect(await cmdFleetEvalReport(args, deps)).toBe(2);
    }
    // Nothing readable at all: exit 1 with a plain error, no report.
    expect(await cmdFleetEvalReport(['--no-observations'], { read: async () => null, now: () => NOW })).toBe(1);
    // An unreadable --prs file warns but still reports from other sources.
    expect(await cmdFleetEvalReport(['--prs', 'missing.json'], deps)).toBe(0);
    expect(String(err.mock.lastCall![0])).toContain('1 --prs file(s) unreadable');
    expect(out).toHaveBeenCalled();
  });
});
