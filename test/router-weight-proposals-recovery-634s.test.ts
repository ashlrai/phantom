import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetRouterWeights, FLEET_ROUTER_WEIGHTS_USAGE } from '../src/cli/fleet-router-weights.js';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { foldRouterOutcomes, ROUTER_OUTCOME_LEDGER_LIMIT, type RouterOutcome } from '../src/core/router/outcomes.js';
import { proposeRouterWeights } from '../src/core/router/weight-proposals.js';

// Recovery test for the pure proposal slice of PR #6794 (head f9e484e87ec2d01f155cc280e818d2e98519dbe7).
// Runs the real CLI over the real bounded ledger reader. HOME and ASHLR_HOME are temp dirs, so the eval
// projection read stays hermetic. All fixtures are synthetic.

let root: string;
let runs: string;
let logged: string[];
let errored: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'router-weights-634s-'));
  runs = join(root, 'runs');
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  logged = [];
  errored = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const ledgerPath = (): string => join(runs, 'metrics', 'jobs.jsonl');
const writeLedger = (rows: object[]): void => writeFileSync(ledgerPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const marketPath = (): string => join(runs, 'metrics', 'work-market.jsonl');
const writeMarket = (rows: object[]): void => writeFileSync(marketPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

/** A work-market.v1 route_decision row in the dispatcher's own shape. */
const marketDecision = (job: string, workClass: string, ts: number): object => ({
  schema: 'work-market.v1', event: 'route_decision', job,
  chosen_lane: 'alpha', preferred_lane: 'alpha', work_class: workClass,
  override: null, rejected_lanes: [], reason_codes: [], ts,
});

/** Current ledger event shape: state in `phase` (MERGED, CLOSED, or a non-terminal phase), route fields alongside. */
function event(job: string, lane: string, workClass: string, phase: string | null, extra: Record<string, unknown> = {}): object {
  return { job, lane, model: 'synthetic-model', tier: 'work', work_class: workClass, ...(phase ? { phase } : {}), ...extra };
}
const rows = (n: number, phase: string, lane: string, workClass: string): object[] =>
  Array.from({ length: n }, (_, i) => event(`synthetic-${phase}-${lane}-${workClass}-${i}`, lane, workClass, phase));
const merged = (n: number, lane = 'alpha', workClass = 'code'): object[] => rows(n, 'MERGED', lane, workClass);
const closed = (n: number, lane = 'alpha', workClass = 'code'): object[] => rows(n, 'CLOSED', lane, workClass);
const unknown = (n: number, lane = 'alpha', workClass = 'code'): object[] => rows(n, 'VERIFIED', lane, workClass);

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  logged = [];
  errored = [];
  const code = await cmdFleetRouterWeights(args);
  return { code, out: logged.join('\n'), err: errored.join('\n') };
}

/** The production path: `phm fleet router-weights ...` through cmdFleet and the generated registry. */
async function runFleet(args: string[]): Promise<{ code: number; out: string; err: string }> {
  logged = [];
  errored = [];
  const code = await cmdFleet(['router-weights', ...args]);
  return { code, out: logged.join('\n'), err: errored.join('\n') };
}

async function runJson(): Promise<{ code: number; report: any }> {
  const { code, out } = await run(['--runs-dir', runs, '--json']);
  return { code, report: JSON.parse(out) };
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [`${path}/`, ...listTree(path)] : [path];
  }).sort();
}

describe('sufficient known evidence', () => {
  it('proposes a shift toward the merge rate, capped at maxShift, and reports advisory-only evidence', async () => {
    writeLedger(merged(20));
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      schema: 'router.weight-proposals.v1', advisory_only: true, status: 'proposed', known_outcomes: 20,
      unknown_outcomes: 0, unclassified_outcomes: 0, bounds: { min_samples: 20, max_shift: 0.1 },
      source: { pr: 6794, head_sha: 'f9e484e87ec2d01f155cc280e818d2e98519dbe7' }, ledger: { state: 'read' },
    });
    // 20 of 20 merged targets 1.0 from the 0.5 baseline; the cap holds it at 0.6.
    expect(report.proposals).toEqual([expect.objectContaining({
      work_class: 'code', lane: 'alpha', status: 'proposed', reason: null, known_n: 20, baseline_weight: 0.5, proposed_weight: 0.6, shift: 0.1,
    })]);
    expect(Number.isNaN(Date.parse(report.as_of))).toBe(false);
  });

  it('moves downward when every known outcome is closed unmerged, and prints the same result in text', async () => {
    writeLedger(closed(20));
    expect((await runJson()).report.proposals[0]).toMatchObject({ status: 'proposed', proposed_weight: 0.4, shift: -0.1 });
    writeLedger(merged(20));
    const { code, out } = await run(['--runs-dir', runs]);
    expect(code).toBe(0);
    expect(out).toContain('status=proposed');
    expect(out).toContain('advisory-only: not applied to routing or weights.json');
    expect(out).toContain('code/alpha: proposed 0.5 -> 0.6 (known=20)');
  });
});

describe('unknown outcomes', () => {
  it('excludes merged:null outcomes from known evidence', async () => {
    writeLedger([...merged(19), ...unknown(10)]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({ known_outcomes: 19, unknown_outcomes: 10 });
    expect(report.proposals[0]).toMatchObject({ status: 'refused', known_n: 19, proposed_weight: 0.5 });
  });

  it('proposes once 20 known outcomes exist, despite unknown ones', async () => {
    writeLedger([...merged(20), ...unknown(5)]);
    const { report } = await runJson();
    expect(report.unknown_outcomes).toBe(5);
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', known_n: 20, proposed_weight: 0.6 });
  });
});

describe('insufficient evidence', () => {
  it('refuses 19 known outcomes, leaves the baseline unchanged and says so', async () => {
    writeLedger(merged(19));
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report.status).toBe('insufficient-evidence');
    expect(report.proposals[0]).toMatchObject({ status: 'refused', reason: 'insufficient-evidence', known_n: 19, baseline_weight: 0.5, proposed_weight: 0.5, shift: 0 });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('status=insufficient-evidence');
    expect(out).toContain('insufficient evidence known=19 need=20; baseline 0.5 unchanged');
  });

  it('says so when the ledger is readable but holds no classified rows', async () => {
    writeFileSync(ledgerPath(), 'not json\n{"job":"synthetic-no-class","phase":"MERGED"}\n');
    const { code, out } = await run(['--runs-dir', runs]);
    expect(code).toBe(0);
    expect(out).toContain('insufficient evidence: no classified known outcomes');
  });
});

describe('isolation between work classes and lanes', () => {
  it('keeps each (work_class, lane) group separate and counts unclassified rows', async () => {
    writeLedger([
      ...merged(20, 'alpha', 'code'), ...merged(19, 'alpha', 'docs'), ...closed(20, 'beta', 'code'),
      event('synthetic-bad-class', 'alpha', 'bad class!', 'MERGED'), event('synthetic-no-lane', 'Ω', 'code', 'MERGED'),
    ]);
    const { report } = await runJson();
    expect(report.unclassified_outcomes).toBe(2);
    const byKey = Object.fromEntries(report.proposals.map((p: { work_class: string; lane: string }) => [`${p.work_class}/${p.lane}`, p]));
    expect(byKey['code/alpha']).toMatchObject({ status: 'proposed', proposed_weight: 0.6 });
    expect(byKey['code/beta']).toMatchObject({ status: 'proposed', proposed_weight: 0.4 });
    expect(byKey['docs/alpha']).toMatchObject({ status: 'refused', known_n: 19, proposed_weight: 0.5 });
    expect(report.proposals).toHaveLength(3);
  });
});

describe('pure proposal semantics', () => {
  const outcomesOf = (r: object[]): RouterOutcome[] => foldRouterOutcomes(r.map(x => JSON.stringify(x)).join('\n')).outcomes;

  it('clamps weights to [0, 1] and starts absent groups at 0.5', () => {
    const low = proposeRouterWeights(outcomesOf(closed(20)), { baselines: [{ work_class: 'code', lane: 'alpha', weight: 0.02 }] });
    expect(low.proposals[0]).toMatchObject({ baseline_weight: 0.02, proposed_weight: 0, shift: -0.02 });
    expect(proposeRouterWeights(outcomesOf(merged(20, 'gamma'))).proposals[0]).toMatchObject({ baseline_weight: 0.5, proposed_weight: 0.6 });
  });

  it('excludes reverted merges from the held-merge rate but keeps them known', () => {
    const held = outcomesOf(merged(10));
    const reverted = outcomesOf(Array.from({ length: 10 }, (_, i) =>
      event(`synthetic-pure-rev-${i}`, 'alpha', 'code', 'MERGED', { reverted: true })));
    const set = proposeRouterWeights([...held, ...reverted]);
    // 10 held of 20 known sits exactly on the 0.5 baseline: proposed, zero shift.
    expect(set.proposals[0]).toMatchObject({ known_n: 20, reverted_n: 10, proposed_weight: 0.5, shift: 0 });
  });

  it('rejects invalid tuning bounds, baselines and as_of timestamps', () => {
    const rows1 = outcomesOf(merged(1));
    for (const minSamples of [0, -1, 1.5, NaN]) expect(() => proposeRouterWeights(rows1, { minSamples })).toThrow(RangeError);
    for (const maxShift of [0, -0.1, 1.5, NaN, Infinity]) expect(() => proposeRouterWeights(rows1, { maxShift })).toThrow(RangeError);
    expect(() => proposeRouterWeights(rows1, { baselines: [{ work_class: 'code', lane: 'alpha', weight: 1.2 }] })).toThrow(RangeError);
    const pair = [{ work_class: 'code', lane: 'alpha', weight: 0.4 }, { work_class: 'code', lane: 'alpha', weight: 0.6 }];
    expect(() => proposeRouterWeights(rows1, { baselines: pair })).toThrow(RangeError);
  });
});

describe('work_class join from the work market', () => {
  // Production jobs.jsonl rows never carry work_class; the market's
  // route_decision journal is the only per-job class evidence. Without the
  // join every outcome reads unclassified and no proposal can ever form.
  const marketRows = (jobs: string[], workClass: string): object[] =>
    jobs.map((job, i) => marketDecision(job, workClass, 1_000 + i));

  it('classifies outcomes from route_decision rows and proposes per (work_class, lane)', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => `synthetic-market-${i}`);
    // Lane and merge state come from jobs.jsonl; the class comes only from work-market.jsonl.
    writeLedger(jobs.map((job, i) => ({ job, lane: 'alpha', phase: 'MERGED', ts: `2026-11-0${(i % 9) + 1}T00:00:00Z` })));
    writeMarket(marketRows(jobs, 'bulk'));
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      status: 'proposed', market_state: 'read', market_truncated: false,
      known_outcomes: 20, unclassified_outcomes: 0,
    });
    expect(report.proposals).toEqual([expect.objectContaining({
      work_class: 'bulk', lane: 'alpha', status: 'proposed', known_n: 20, proposed_weight: 0.6,
    })]);
  });

  it('keeps groups separate per market class and reports unclassified jobs without decisions', async () => {
    const bulk = Array.from({ length: 20 }, (_, i) => `synthetic-bulk-${i}`);
    const judgment = Array.from({ length: 20 }, (_, i) => `synthetic-judgment-${i}`);
    const undecided = 'synthetic-no-decision';
    writeLedger([
      ...bulk.map(job => ({ job, lane: 'alpha', phase: 'MERGED' })),
      ...judgment.map(job => ({ job, lane: 'beta', phase: 'CLOSED' })),
      { job: undecided, lane: 'alpha', phase: 'MERGED' },
    ]);
    writeMarket([
      ...marketRows(bulk, 'bulk'),
      ...marketRows(judgment, 'judgment'),
    ]);
    const { report } = await runJson();
    expect(report.unclassified_outcomes).toBe(1);
    const byKey = Object.fromEntries(report.proposals.map((p: { work_class: string; lane: string }) => [`${p.work_class}/${p.lane}`, p]));
    expect(byKey['bulk/alpha']).toMatchObject({ status: 'proposed', proposed_weight: 0.6 });
    expect(byKey['judgment/beta']).toMatchObject({ status: 'proposed', proposed_weight: 0.4 });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('market=read');
  });

  it('reports market_state so a missing decision journal explains unclassified outcomes', async () => {
    // Production-shaped rows: no work_class on jobs.jsonl and no market file.
    writeLedger(Array.from({ length: 20 }, (_, i) => ({ job: `synthetic-nomarket-${i}`, lane: 'alpha', phase: 'MERGED' })));
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({ status: 'insufficient-evidence', market_state: 'missing', unclassified_outcomes: 20 });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('market=missing');
    expect(out).toContain('market coverage: work-market.jsonl missing');
  });
});

describe('reverted merges', () => {
  const revertedRows = (n: number, lane = 'alpha', workClass = 'code'): object[] =>
    Array.from({ length: n }, (_, i) => event(`synthetic-rev-${lane}-${workClass}-${i}`, lane, workClass, 'MERGED', { reverted: true }));

  it('never counts a recorded revert as a held merge and reports reverted_n', async () => {
    writeLedger([...merged(15), ...revertedRows(5)]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    // 15 held of 20 known = 0.75, capped at +0.1; the 5 reverts stay visible.
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', known_n: 20, reverted_n: 5, proposed_weight: 0.6, shift: 0.1 });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('code/alpha: proposed 0.5 -> 0.6 (known=20 reverted=5)');
  });

  it('moves downward when every known merge was recorded as reverted', async () => {
    writeLedger(revertedRows(20));
    const { report } = await runJson();
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', known_n: 20, reverted_n: 20, proposed_weight: 0.4, shift: -0.1 });
  });

  it('folds revert events and stamps, not only the reverted boolean', async () => {
    writeLedger([
      ...merged(18),
      event('synthetic-ev-revert', 'alpha', 'code', 'MERGED'),
      { job: 'synthetic-ev-revert', event: 'revert' },
      event('synthetic-stamp-revert', 'alpha', 'code', 'MERGED'),
      { job: 'synthetic-stamp-revert', reverted_at: '2026-11-02T00:00:00Z' },
    ]);
    const { report } = await runJson();
    // 18 held of 20 known = 0.9, capped at +0.1; the two recorded reverts do not hold.
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', known_n: 20, reverted_n: 2, proposed_weight: 0.6 });
  });

  it('keeps explicit reverted:false merges in the held count', async () => {
    writeLedger([...merged(19), event('synthetic-held', 'alpha', 'code', 'MERGED', { reverted: false })]);
    const { report } = await runJson();
    expect(report.proposals[0]).toMatchObject({ known_n: 20, reverted_n: 0, proposed_weight: 0.6 });
  });
});

describe('outcome-quality evidence', () => {
  const spendPath = (): string => join(runs, 'metrics', 'api-spend.jsonl');
  const writeSpend = (rows: object[]): void => writeFileSync(spendPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const writeLaneScores = (passPowK: number): void => {
    const dir = join(root, 'ashlr', 'eval', 'passk');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lane-scores.json'), `${JSON.stringify({
      schema: 'eval.lane-scores.v1', generatedAt: '2026-11-19T00:00:00.000Z', reportId: 'synthetic-report', k: 3, trials: 60,
      lanes: [{ lane: 'alpha', model: 'synthetic-model', tasks: 20, trials: 60, passes: 45, pass1: 0.75, passPowK }],
    })}\n`);
  };
  const signaled = (n: number, lane: string, workClass: string, phase: string, extra: Record<string, unknown>): object[] =>
    Array.from({ length: n }, (_, i) => event(`synthetic-evq-${lane}-${workClass}-${phase}-${i}`, lane, workClass, phase, extra));

  it('folds recorded CI, review, cost, wall, merge-latency, token and passk signals per group with coverage counts', async () => {
    writeLaneScores(0.71);
    writeLedger([
      ...Array.from({ length: 10 }, (_, i) => event(`synthetic-evq-a-${i}`, 'alpha', 'code', 'MERGED', {
        ci_first_pass: i < 8,
        review_findings: { fixed: 2, rejected: 1, ignored: 0 },
        cost_usd: 1.5,
        wall_s: 100,
        ttm_s: 200 + i * 10,
        tokens_total: 1000 + i * 100,
      })),
      ...merged(10),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report.proposals).toHaveLength(1);
    // Evidence is advisory context: the held-merge weight is unchanged by it.
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', proposed_weight: 0.6 });
    expect(report.proposals[0].evidence).toEqual({
      ci_first_pass_known: 10,
      ci_first_pass_rate: 0.8,
      review_findings_known: 10,
      review_findings: { fixed: 20, rejected: 10, ignored: 0 },
      cost_known: 10,
      cost_usd_mean: 1.5,
      wall_known: 10,
      wall_s_mean: 100,
      ttm_known: 10,
      ttm_s_mean: 245,
      queue_wait_known: 0,
      queue_wait_s_mean: null,
      ci_wall_known: 0,
      ci_wall_s_mean: null,
      lane_blocked_known: 0,
      lane_blocked_reasons: null,
      tokens_known: 10,
      tokens_total_mean: 1450,
      passk_known: 20,
      passk_mean: 0.71,
      acus_known: 0,
      acus_mean: null,
      diff_files_known: 0,
      diff_files_mean: null,
      diff_lines_known: 0,
      diff_lines_mean: null,
      usage_missing_known: 0,
      lane_overrides_known: 0,
      lane_override_reasons: null,
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('evidence ci_first_pass=0.8(10)');
    expect(out).toContain('review_findings=30(10)');
    expect(out).toContain('cost_usd=1.5(10)');
    expect(out).toContain('wall_s=100(10)');
    expect(out).toContain('ttm_s=245(10)');
    expect(out).toContain('tokens_total=1450(10)');
    expect(out).toContain('passk=0.71(20)');
  });

  it('folds queue-admission wait into group evidence with coverage counts', async () => {
    // Each job: enqueue at T0, launch at T0+wait, then a MERGED verdict row
    // carrying the group classification. queue_wait_s joins only the known
    // cohort, like wall_s and ttm_s — a job with no recorded arrival stays
    // out of the coverage count rather than counting as zero.
    const jobs = Array.from({ length: 20 }, (_, i) => `synthetic-qw-${i}`);
    const t0 = Date.parse('2026-11-20T00:00:00Z');
    writeLedger([
      ...jobs.flatMap((job, i) => [
        { job, event: 'enqueue', ts: new Date(t0).toISOString() },
        { job, event: 'launch', lane: 'alpha', ts: new Date(t0 + (i + 1) * 10_000).toISOString() },
        event(job, 'alpha', 'code', 'MERGED'),
      ]),
      // An unrecorded-arrival outcome in the same group keeps coverage at 20,
      // never inflating it with a fabricated zero wait.
      event('synthetic-qw-noarr', 'alpha', 'code', 'MERGED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    const p = report.proposals[0];
    expect(p).toMatchObject({ work_class: 'code', lane: 'alpha', known_n: 21 });
    // waits are 10s..200s over the 20 boundary-carrying jobs -> mean 105s.
    expect(p.evidence.queue_wait_known).toBe(20);
    expect(p.evidence.queue_wait_s_mean).toBe(105);
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('queue_wait_s=105(20)');
  });

  it('folds CI wall seconds into group evidence with coverage counts', async () => {
    // Each job: ci_start at T0, ci_complete at T0+wall, then a MERGED
    // verdict row carrying the group classification. ci_wall_s joins only
    // the known cohort under the exactly-one-pair rule — a job whose
    // boundaries are missing, reversed or repeated stays out of the
    // coverage count rather than counting as zero.
    const jobs = Array.from({ length: 20 }, (_, i) => `synthetic-cw-${i}`);
    const t0 = Date.parse('2026-11-20T00:00:00Z');
    writeLedger([
      ...jobs.flatMap((job, i) => [
        { job, event: 'ci_start', ts: new Date(t0).toISOString() },
        { job, event: 'ci_complete', ts: new Date(t0 + (i + 1) * 30_000).toISOString() },
        event(job, 'alpha', 'code', 'MERGED'),
      ]),
      // An ambiguous re-run pair keeps the job out of coverage entirely.
      { job: 'synthetic-cw-rerun', event: 'ci_start', ts: new Date(t0).toISOString() },
      { job: 'synthetic-cw-rerun', event: 'ci_complete', ts: new Date(t0 + 60_000).toISOString() },
      { job: 'synthetic-cw-rerun', event: 'ci_start', ts: new Date(t0 + 120_000).toISOString() },
      { job: 'synthetic-cw-rerun', event: 'ci_complete', ts: new Date(t0 + 180_000).toISOString() },
      event('synthetic-cw-rerun', 'alpha', 'code', 'MERGED'),
      // An unpaired boundary likewise never fabricates a duration.
      { job: 'synthetic-cw-open', event: 'ci_start', ts: new Date(t0).toISOString() },
      event('synthetic-cw-open', 'alpha', 'code', 'MERGED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    const p = report.proposals[0];
    expect(p).toMatchObject({ work_class: 'code', lane: 'alpha', known_n: 22 });
    // walls are 30s..600s over the 20 paired jobs -> mean 315s.
    expect(p.evidence.ci_wall_known).toBe(20);
    expect(p.evidence.ci_wall_s_mean).toBe(315);
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('ci_wall_s=315(20)');
  });

  it('folds dispatch lane overrides into group evidence with reason tallies', async () => {
    // Each overridden job claims off its hint before its merge verdict; the
    // tally counts known-cohort outcomes only, like every other signal.
    const claim = (job: string, lane: string, hint: string, reason: string): object =>
      ({ job, event: 'claim', lane, lane_hint: hint, lane_override: reason });
    const jobs = Array.from({ length: 20 }, (_, i) => `synthetic-ov-${i}`);
    writeLedger([
      ...jobs.flatMap((job, i) => [
        ...(i < 6 ? [claim(job, 'alpha', i < 4 ? 'codex-personal' : 'devin', i < 4 ? 'resource_fit' : 'batch_session')] : []),
        event(job, 'alpha', 'code', 'MERGED'),
      ]),
      // An unknown-cohort override stays out of the known group's tally.
      claim('synthetic-ov-unq', 'alpha', 'devin', 'batch_session'),
      event('synthetic-ov-unq', 'alpha', 'code', 'VERIFIED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    const p = report.proposals[0];
    expect(p).toMatchObject({ work_class: 'code', lane: 'alpha', known_n: 20 });
    expect(p.evidence.lane_overrides_known).toBe(6);
    expect(p.evidence.lane_override_reasons).toEqual([
      { reason: 'resource_fit', jobs: 4 },
      { reason: 'batch_session', jobs: 2 },
    ]);
    // Advisory context only: the held-merge weight math never reads it.
    expect(p.proposed_weight).toBe(0.6);
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('lane_overrides=6(resource_fit:4,batch_session:2)');
  });

  it('keeps unrecorded signals null with zero coverage, never zero', async () => {
    writeLedger(merged(20));
    const { report } = await runJson();
    expect(report.proposals[0].evidence).toEqual({
      ci_first_pass_known: 0, ci_first_pass_rate: null,
      review_findings_known: 0, review_findings: null,
      cost_known: 0, cost_usd_mean: null,
      wall_known: 0, wall_s_mean: null,
      ttm_known: 0, ttm_s_mean: null,
      queue_wait_known: 0, queue_wait_s_mean: null,
      ci_wall_known: 0, ci_wall_s_mean: null,
      lane_blocked_known: 0, lane_blocked_reasons: null,
      tokens_known: 0, tokens_total_mean: null,
      passk_known: 0, passk_mean: null,
      acus_known: 0, acus_mean: null,
      diff_files_known: 0, diff_files_mean: null,
      diff_lines_known: 0, diff_lines_mean: null,
      usage_missing_known: 0,
      lane_overrides_known: 0, lane_override_reasons: null,
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).not.toContain('ci_first_pass=');
    expect(out).not.toContain('ttm_s=');
    expect(out).not.toContain('tokens_total=');
  });

  it('counts spend-derived costs and never folds signals from the unknown cohort', async () => {
    const mergedJobs = Array.from({ length: 20 }, (_, i) => `synthetic-spend-${i}`);
    writeLedger([
      ...mergedJobs.map(job => ({ job, lane: 'alpha', model: 'synthetic-model', work_class: 'code', phase: 'MERGED' })),
      ...signaled(5, 'alpha', 'code', 'VERIFIED', { ci_first_pass: true, cost_usd: 9 }),
    ]);
    writeSpend(mergedJobs.slice(0, 4).map((job, i) => ({ job, cost_usd: 2 + i })));
    const { report } = await runJson();
    expect(report.unknown_outcomes).toBe(5);
    const p = report.proposals[0];
    expect(p.known_n).toBe(20);
    expect(p.evidence.cost_known).toBe(4);
    expect(p.evidence.cost_usd_mean).toBe(3.5);
    // The VERIFIED rows carried ci_first_pass/cost signals but merged:null keeps them out of every group.
    expect(p.evidence.ci_first_pass_known).toBe(0);
    expect(p.evidence.ci_first_pass_rate).toBeNull();
  });

  it('keeps evidence per group and reports it on refused groups too', async () => {
    writeLedger([
      ...signaled(20, 'alpha', 'code', 'MERGED', { ci_first_pass: true }),
      ...signaled(19, 'beta', 'docs', 'MERGED', {}),
    ]);
    const { report } = await runJson();
    const byKey = Object.fromEntries(report.proposals.map((p: { work_class: string; lane: string }) => [`${p.work_class}/${p.lane}`, p]));
    expect(byKey['code/alpha'].evidence.ci_first_pass_rate).toBe(1);
    expect(byKey['code/alpha'].evidence.ci_first_pass_known).toBe(20);
    expect(byKey['docs/beta'].status).toBe('refused');
    expect(byKey['docs/beta'].evidence).toMatchObject({
      ci_first_pass_known: 0, ci_first_pass_rate: null, cost_known: 0, cost_usd_mean: null,
    });
  });

  it('folds ACU spend, diff size and usage-gap coverage into group evidence and set tallies', async () => {
    const finishRowLike = (job: string, extra: Record<string, unknown>): object =>
      ({ job, lane: 'alpha', work_class: 'code', event: 'finish', ...extra });
    // dispatchd's finish rows carry the job_usage block (acus, token
    // breakdown, usage_source/usage_missing) and job_diff_metrics — the
    // devin lane's only recorded spend is ACU, never USD.
    writeLedger([
      ...Array.from({ length: 10 }, (_, i) => event(`synthetic-usage-a-${i}`, 'devin', 'code', 'MERGED', {
        acus: 1 + i * 0.5, diff_files: 4 + i, diff_lines: 100 + i * 10,
        usage_source: 'devin-sessions-db',
      })),
      ...Array.from({ length: 10 }, (_, i) => event(`synthetic-usage-b-${i}`, 'devin', 'code', 'MERGED', {
        usage_missing: i < 4 ? 'devin-usage-not-reported' : 'devin-usage-incomplete',
        usage_source: i < 4 ? null : 'tokens-line',
      })),
      // An unclassified outcome still tallies its usage labels — capture
      // completeness is not merge evidence.
      { job: 'synthetic-usage-unc', lane: 'devin', phase: 'MERGED', usage_missing: 'devin-session-db-missing' },
      // Unknown-cohort finishes tally the same way.
      finishRowLike('synthetic-usage-unq', { usage_missing: 'tokens-line-not-in-log' }),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({ known_outcomes: 20, unknown_outcomes: 1, unclassified_outcomes: 1 });
    expect(report.proposals).toHaveLength(1);
    const p = report.proposals[0];
    expect(p).toMatchObject({ work_class: 'code', lane: 'devin', known_n: 20, status: 'proposed' });
    expect(p.evidence).toMatchObject({
      acus_known: 10, acus_mean: 3.25,
      diff_files_known: 10, diff_files_mean: 8.5,
      diff_lines_known: 10, diff_lines_mean: 145,
      usage_missing_known: 10,
    });
    // usage_missing/usage_sources tally every folded outcome: 10 group B
    // gaps + 1 unclassified + 1 unknown-cohort finish.
    expect(report.usage_missing).toEqual([
      { usage_missing: 'devin-usage-incomplete', jobs: 6 },
      { usage_missing: 'devin-usage-not-reported', jobs: 4 },
      { usage_missing: 'devin-session-db-missing', jobs: 1 },
      { usage_missing: 'tokens-line-not-in-log', jobs: 1 },
    ]);
    expect(report.usage_sources).toEqual([
      { usage_source: 'devin-sessions-db', jobs: 10 },
      { usage_source: 'tokens-line', jobs: 6 },
    ]);
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('acus=3.25(10)');
    expect(out).toContain('diff_files=8.5(10)');
    expect(out).toContain('diff_lines=145(10)');
    expect(out).toContain('usage coverage:');
    expect(out).toContain('missing=devin-usage-incomplete:6,devin-usage-not-reported:4');
    expect(out).toContain('sources=devin-sessions-db:10,tokens-line:6');
  });

  it('folds claim lane-hint blocking codes into group evidence with reason tallies', async () => {
    // Each overridden job claims off its hint before its merge verdict; the
    // market's recorded blocked-by codes tally per known-cohort outcome.
    // The recorded empty list is the "nothing blocked it" verdict and stays
    // out of the count, like every other unrecorded signal.
    const claim = (job: string, lane: string, hint: string, reason: string, blocked?: string[]): object =>
      ({ job, event: 'claim', lane, lane_hint: hint, lane_override: reason, ...(blocked === undefined ? {} : { lane_hint_blocked_by: blocked }) });
    const jobs = Array.from({ length: 20 }, (_, i) => `synthetic-blk-${i}`);
    writeLedger([
      ...jobs.flatMap((job, i) => [
        ...(i < 8 ? [claim(job, 'alpha', 'codex-personal', 'preferred_lane_fallback',
          i < 5 ? ['quota_exhausted', 'saturated'] : i < 7 ? ['held'] : [])] : []),
        event(job, 'alpha', 'code', 'MERGED'),
      ]),
      // A batch_claim override carries no blocking record — stays out.
      { job: 'synthetic-blk-batch', event: 'batch_claim', batch: 'RQ-BATCH-blk', lane: 'alpha', lane_hint: 'devin', lane_override: 'batch_session' },
      event('synthetic-blk-batch', 'alpha', 'code', 'MERGED'),
      // An unknown-cohort blocked claim stays out of the known group's tally.
      claim('synthetic-blk-unq', 'alpha', 'devin', 'preferred_lane_fallback', ['saturated']),
      event('synthetic-blk-unq', 'alpha', 'code', 'VERIFIED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    const p = report.proposals[0];
    expect(p).toMatchObject({ work_class: 'code', lane: 'alpha', known_n: 21 });
    // 5 quota+saturated + 2 held = 7 non-empty records; the two [] verdicts
    // and the batch_claim's absent field do not count.
    expect(p.evidence.lane_blocked_known).toBe(7);
    expect(p.evidence.lane_blocked_reasons).toEqual([
      { reason: 'quota_exhausted', jobs: 5 },
      { reason: 'saturated', jobs: 5 },
      { reason: 'held', jobs: 2 },
    ]);
    // Advisory context only: the held-merge weight math never reads it.
    expect(p.proposed_weight).toBe(0.6);
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('lane_blocked=7(quota_exhausted:5,saturated:5,held:2)');
  });

  it('reports null usage tallies when the ledger was not read', async () => {
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(report).toMatchObject({ usage_missing: null, usage_sources: null });
  });
});

describe('unknown-outcome resolution', () => {
  // Finish rows carry empty/exit_code plus a failure classification
  // (failure_class, else failure_reason, else pool_error); the fold keeps
  // them on the outcome and the report resolves the merged:null cohort.
  const finishRow = (job: string, extra: Record<string, unknown>): object =>
    ({ job, lane: 'alpha', work_class: 'code', event: 'finish', ...extra });

  it('counts empty finishes, nonzero exits and failure classes inside the unknown cohort', async () => {
    writeLedger([
      ...merged(20),
      // Three crashed-empty runs: every signal overlaps on the same jobs.
      ...[0, 1, 2].map(i => finishRow(`synthetic-unq-crash-${i}`, { empty: true, exit_code: 1, failure_class: 'quota' })),
      // Two nonzero exits without an empty verdict or class.
      ...[0, 1].map(i => finishRow(`synthetic-unq-exit-${i}`, { exit_code: 2 })),
      // One classified failure without a usable exit code.
      finishRow('synthetic-unq-class', { failure_class: 'authentication' }),
      // Four jobs with no finish signal at all — in flight or awaiting a verdict.
      ...[0, 1, 2, 3].map(i => event(`synthetic-unq-open-${i}`, 'alpha', 'code', 'VERIFIED')),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 10, unclassified_outcomes: 0,
      unknown_empty: 3, unknown_nonzero_exit: 5, unknown_unresolved: 4,
      unknown_failure_classes: [
        { failure_class: 'quota', jobs: 3 },
        { failure_class: 'authentication', jobs: 1 },
      ],
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('unknown resolution: empty=3 nonzero_exit=5 unresolved=4');
    expect(out).toContain('failure_classes=quota:3,authentication:1');
  });

  it('tallies failure_reason and pool_error labels the same way as failure_class', async () => {
    // dispatchd writes failure_class only for the devin pool; other lanes
    // record failure_reason or pool_error on the same finish rows.
    writeLedger([
      ...merged(20),
      finishRow('synthetic-unq-timeout', { empty: true, exit_code: 124, failure_reason: 'launch_timeout' }),
      finishRow('synthetic-unq-rate', { exit_code: 1, pool_error: 'rate_limit' }),
      finishRow('synthetic-unq-quota', { exit_code: 1, pool_error: 'usage_limit', failure_reason: 'provider_usage_limit' }),
      finishRow('synthetic-unq-clean', { empty: false, exit_code: 0 }),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 4,
      unknown_empty: 1, unknown_nonzero_exit: 3, unknown_unresolved: 1,
      unknown_failure_classes: [
        { failure_class: 'launch_timeout', jobs: 1 },
        { failure_class: 'provider_usage_limit', jobs: 1 },
        { failure_class: 'rate_limit', jobs: 1 },
      ],
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('failure_classes=launch_timeout:1,provider_usage_limit:1,rate_limit:1');
  });

  it('tallies the recorded empty_class verdicts inside the unknown cohort', async () => {
    // dispatchd's classify_empty triage splits the empty share: no_diff is a
    // healthy no-op, error the infrastructure share, unknown a capture gap.
    writeLedger([
      ...merged(20),
      finishRow('synthetic-unq-nd-1', { empty: true, exit_code: 0, empty_class: 'no_diff' }),
      finishRow('synthetic-unq-nd-2', { empty: true, exit_code: 0, empty_class: 'no_diff' }),
      finishRow('synthetic-unq-err-1', { empty: true, exit_code: 1, empty_class: 'error', failure_class: 'quota' }),
      finishRow('synthetic-unq-unk-1', { empty: true, empty_class: 'unknown' }),
      // Out-of-vocabulary spellings never mint a class tally.
      finishRow('synthetic-unq-bad', { empty: true, exit_code: 1, empty_class: 'infra' }),
      // A verified row with no finish signal stays unresolved and untallied.
      event('synthetic-unq-open', 'alpha', 'code', 'VERIFIED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 6,
      unknown_empty: 5, unknown_nonzero_exit: 2, unknown_unresolved: 1,
      unknown_empty_classes: [
        { empty_class: 'no_diff', jobs: 2 },
        { empty_class: 'error', jobs: 1 },
        { empty_class: 'unknown', jobs: 1 },
      ],
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('empty_classes=no_diff:2,error:1,unknown:1');
  });

  it('never counts finish signals from the known cohort as unknown resolution', async () => {
    writeLedger([
      // A merged job can still carry a nonzero exit (the PR landed anyway)
      // and an empty verdict on an earlier attempt — neither is unknown.
      ...Array.from({ length: 20 }, (_, i) => event(`synthetic-known-${i}`, 'alpha', 'code', 'MERGED',
        i === 0 ? { empty: true, exit_code: 1, failure_class: 'quota' } : { empty: false, exit_code: 0 })),
      event('synthetic-unq-clean', 'alpha', 'code', 'VERIFIED', { empty: false, exit_code: 0 }),
    ]);
    const { report } = await runJson();
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 1,
      unknown_empty: 0, unknown_nonzero_exit: 0, unknown_unresolved: 1,
      unknown_failure_classes: [],
    });
  });

  it('reports null resolution counts when the ledger was not read', async () => {
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(report).toMatchObject({
      status: 'unavailable',
      unknown_empty: null, unknown_nonzero_exit: null, unknown_failure_classes: null,
      unknown_empty_classes: null, unknown_task_outcomes: null, unknown_unresolved: null,
    });
  });

  it('tallies batch-member task_outcome words and exempts the requeue words from unresolved', async () => {
    // dispatchd's batcher closes members with task_outcome rows — the
    // member's only finish boundary, since batch members get no per-member
    // finish row. The RETRY words (failed/deferred/unreported) are the
    // recorded failure signal; done/skipped members still await their own
    // publish verdict, and RQ-BATCH-* session rows never mint outcomes.
    const requeued = [
      ...[0, 1, 2].map(i => `synthetic-batch-fail-${i}`),
      ...[0, 1].map(i => `synthetic-batch-defer-${i}`),
      'synthetic-batch-unrep',
    ];
    const awaiting = [
      ...[0, 1].map(i => `synthetic-batch-done-${i}`),
      'synthetic-batch-skip',
      'synthetic-batch-open',
    ];
    const members = [...requeued, ...awaiting];
    const word = (job: string, outcome: string): object =>
      ({ job, event: 'task_outcome', batch: 'RQ-BATCH-syn0001', lane: 'alpha', outcome });
    writeLedger([
      ...merged(20),
      { job: 'RQ-BATCH-syn0001', event: 'launch', lane: 'alpha' },
      { job: 'RQ-BATCH-syn0001', event: 'finish', lane: 'alpha', wall_s: 800, tokens_total: 40000 },
      ...members.map(job => ({ job, event: 'batch_claim', batch: 'RQ-BATCH-syn0001', lane: 'alpha', tier: 'work' })),
      ...[0, 1, 2].map(i => word(`synthetic-batch-fail-${i}`, 'failed')),
      ...[0, 1].map(i => word(`synthetic-batch-defer-${i}`, 'deferred')),
      word('synthetic-batch-unrep', 'unreported'),
      ...[0, 1].map(i => word(`synthetic-batch-done-${i}`, 'done')),
      word('synthetic-batch-skip', 'skipped'),
      // A solo in-flight job joins the same awaiting-verdict remainder.
      { job: 'synthetic-solo-open', event: 'claim', lane: 'alpha' },
    ]);
    // Members carry no work_class of their own; the market's route_decision
    // journal is the recorded classification, same as every other job.
    writeMarket([...members, 'synthetic-solo-open']
      .map((job, i) => marketDecision(job, 'code', 2_000 + i)));
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 11, unclassified_outcomes: 0,
      unknown_empty: 0, unknown_nonzero_exit: 0,
      unknown_task_outcomes: [
        { task_outcome: 'failed', jobs: 3 },
        { task_outcome: 'deferred', jobs: 2 },
        { task_outcome: 'done', jobs: 2 },
        { task_outcome: 'skipped', jobs: 1 },
        { task_outcome: 'unreported', jobs: 1 },
      ],
      // The six requeued members are explained attempts; done/skipped members,
      // the member still awaiting its word and the solo in-flight job are not.
      unknown_unresolved: 5,
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('unresolved=5');
    expect(out).toContain('task_outcomes=failed:3,deferred:2,done:2,skipped:1,unreported:1');
  });

  it('classifies dead launches by their give_up reason and leaves transient receipts unresolved', async () => {
    // dispatchd drops a job whose launch budget is spent or whose failure is
    // permanent: the launch_failed give_up receipt is the only recorded
    // cause for a job that never reached finish. Retry receipts are
    // transient backoff and launch_terminal rows fire on requeues and
    // skips, so neither resolves the missing verdict.
    const launchRow = (job: string, extra: Record<string, unknown>): object =>
      ({ job, lane: 'alpha', work_class: 'code', event: 'launch_failed', ...extra });
    writeLedger([
      ...merged(20),
      launchRow('synthetic-dead-quota', { reason: 'provider_unavailable', class: 'permanent', action: 'give_up', attempt: 1 }),
      launchRow('synthetic-dead-auth', { reason: 'authentication', class: 'permanent', action: 'give_up', attempt: 1 }),
      launchRow('synthetic-dead-timeout', { reason: 'launch_timeout', action: 'give_up', attempt: 3 }),
      // Transient receipts, terminal markers and verified in-flight rows
      // carry no dead-launch cause and stay unresolved.
      launchRow('synthetic-retry', { reason: 'provider_unavailable', action: 'retry', attempt: 1 }),
      { job: 'synthetic-terminal', event: 'launch_terminal', reason: 'launcher-exited', lane: 'alpha', work_class: 'code' },
      event('synthetic-open', 'alpha', 'code', 'VERIFIED'),
    ]);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      known_outcomes: 20, unknown_outcomes: 6, unclassified_outcomes: 0,
      unknown_failure_classes: [
        { failure_class: 'authentication', jobs: 1 },
        { failure_class: 'launch_timeout', jobs: 1 },
        { failure_class: 'provider_unavailable', jobs: 1 },
      ],
      unknown_unresolved: 3,
    });
    const { out } = await run(['--runs-dir', runs]);
    expect(out).toContain('unresolved=3');
    expect(out).toContain('failure_classes=authentication:1,launch_timeout:1,provider_unavailable:1');
  });
});

describe('missing, unreadable and oversized input', () => {
  it('reports a missing ledger as unavailable, never as an empty measurement', async () => {
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(report).toMatchObject({ status: 'unavailable', ledger: { state: 'missing' }, known_outcomes: null, unknown_outcomes: null, unclassified_outcomes: null, proposals: [] });
  });

  it('reports a directory at the ledger path as not-file', async () => {
    mkdirSync(ledgerPath());
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(report).toMatchObject({ status: 'unavailable', ledger: { state: 'not-file' }, known_outcomes: null });
  });

  it('refuses a symlinked ledger as unreadable', async () => {
    const target = join(root, 'real.jsonl');
    writeFileSync(target, JSON.stringify(event('synthetic-link', 'alpha', 'code', 'MERGED')) + '\n');
    symlinkSync(target, ledgerPath());
    const { code, report } = await runJson();
    expect(code).toBe(1);
    expect(report).toMatchObject({ status: 'unavailable', ledger: { state: 'unreadable' }, proposals: [] });
  });

  it('reads the retained tail of an oversized ledger and reports truncated coverage', async () => {
    // One oversized pad line fills the bound; the tail window keeps the newest
    // rows, drops the cut line and flags the coverage as partial.
    const pad = 'x'.repeat(ROUTER_OUTCOME_LEDGER_LIMIT);
    writeFileSync(ledgerPath(), `${pad}\n${merged(20).map(r => JSON.stringify(r)).join('\n')}\n`);
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({
      status: 'proposed', truncated: true, known_outcomes: 20,
      ledger: { state: 'read' },
    });
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', proposed_weight: 0.6 });
    const human = await run(['--runs-dir', runs]);
    expect(human.code).toBe(0);
    expect(human.out).toContain('truncated=true');
    expect(human.out).toContain('coverage: retained tail only');
  });

  it('reports an oversized ledger with no retained rows as insufficient evidence, not a refusal', async () => {
    writeFileSync(ledgerPath(), '');
    truncateSync(ledgerPath(), ROUTER_OUTCOME_LEDGER_LIMIT + 1); // sparse; no 16 MiB write
    const { code, report } = await runJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({ status: 'insufficient-evidence', truncated: true, known_outcomes: 0, ledger: { state: 'read' } });
  });
});

describe('CLI arguments', () => {
  it('prints usage for --help and -h with exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, out } = await run([flag]);
      expect(code).toBe(0);
      expect(out).toBe(FLEET_ROUTER_WEIGHTS_USAGE);
    }
  });

  it('rejects unknown flags, positionals, relative or missing --runs-dir and repeated flags with exit 2', async () => {
    const cases = [
      ['--bogus'], ['extra-positional'], ['--runs-dir', 'relative/runs'], ['--runs-dir'], ['--runs-dir', '--json'],
      ['--json', '--json'], ['--runs-dir', runs, '--runs-dir', runs], ['--apply'], ['--min-samples', '5'],
    ];
    for (const args of cases) {
      const { code, out, err } = await run(args);
      expect(code, args.join(' ')).toBe(2);
      expect(out).toBe('');
      expect(err).toBe(FLEET_ROUTER_WEIGHTS_USAGE);
    }
  });
});

describe('fleet dispatch', () => {
  it('is registered in the generated registry and resolves by convention', () => {
    expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('router-weights');
    expect(resolveFleetSubcommand('router-weights')).toEqual({
      module: './fleet-router-weights.js', exportName: 'cmdFleetRouterWeights',
    });
  });

  it('answers --help and serves a real read through cmdFleet', async () => {
    const help = await runFleet(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toBe(FLEET_ROUTER_WEIGHTS_USAGE);

    writeLedger(merged(20));
    const { code, out } = await runFleet(['--runs-dir', runs, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: 'router.weight-proposals.v1', status: 'proposed', known_outcomes: 20 });
  });
});

describe('read-only behavior', () => {
  it('leaves the ledger and runs tree unchanged and creates no weights file', async () => {
    writeLedger([...merged(20), ...unknown(2)]);
    const before = readFileSync(ledgerPath(), 'utf8');
    const treeBefore = listTree(root);
    expect((await runJson()).code).toBe(0);
    expect((await run(['--runs-dir', runs])).code).toBe(0);
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
    expect(listTree(root)).toEqual(treeBefore);
    expect(listTree(root).filter(p => p.endsWith('weights.json'))).toEqual([]);
  });

  it('never echoes raw ledger rows or job identifiers', async () => {
    writeLedger([{ ...event('synthetic-sentinel-job-7c1e', 'alpha', 'code', 'MERGED'), note: 'SENTINEL-RAW-ROW-9d2b' }]);
    const json = await run(['--runs-dir', runs, '--json']);
    const text = await run(['--runs-dir', runs]);
    for (const output of [json.out, text.out]) {
      expect(output).not.toContain('SENTINEL-RAW-ROW-9d2b');
      expect(output).not.toContain('synthetic-sentinel-job-7c1e');
    }
  });
});
