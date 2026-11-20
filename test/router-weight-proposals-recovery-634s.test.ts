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
