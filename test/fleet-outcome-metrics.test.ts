import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOutcomeMetrics, outcomePercentile } from '../src/core/fleet/outcome-metrics.js';
import { suggestOutcomePolicy } from '../src/core/fleet/policy-suggest.js';
import { generateWeeklySelfReport } from '../src/core/fleet/weekly-self-report.js';
import { cmdFleetMetrics } from '../src/cli/fleet-metrics.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const nowMs = Date.parse('2026-11-14T12:00:00Z');
const stamp = (hours: number) => new Date(nowMs - hours * 3_600_000).toISOString();
const event = (kind: string, hours: number, extra: Record<string, unknown> = {}) => ({ event: kind, ts: stamp(hours), ...extra });
const launch = (job: string, hours = 3, extra = {}) => event('launch', hours, { job, lane: 'codex', model: 'model-a', tier: 'work', ...extra });
const finish = (job: string, hours = 2, extra = {}) => event('finish', hours, { job, ...extra });
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const build = (events: readonly unknown[] | null, hours = 24) => buildOutcomeMetrics({ events, nowMs, hours });
afterEach(() => vi.restoreAllMocks());

describe('fleet outcome measurement', () => {
  it('rolls up a shuffled fixture by launch attempt, lane and model tier without duplicate inflation', () => {
    const a = launch('A'), f = finish('A', 2, { wall_s: 60, cost: 0, empty: false });
    const report = build([f, launch('B'), a, { ...a }, { ...f }, finish('B', 1, { cost: 2, empty: true }),
      event('publish', 1, { job: 'A', url: pr(1) }), launch('C', 2, { lane: 'devin', model: 'model-b' }),
      finish('C', 1, { cost: 5, empty: false })]);
    expect(report.sourceState).toBe('healthy');
    expect(report.byLane[0]).toMatchObject({ name: 'codex', jobs: 2, finished: 2, finishRate: 1, prRate: 0.5,
      emptyRate: 0.5, medianDuration: 3630, estCost: 2, samples: { pr: 2, published: 1, cost: 2 } });
    expect(report.byModelTier).toHaveLength(2);
    expect(report.byLane[1]!.prRate).toBeNull(); // nonempty does not prove publication
    expect(outcomePercentile([10, 20, 30], 0.95)).toBe(29);
  });
  it('retains unknown measurements, partial cost coverage, unfinished jobs and missing sources', () => {
    expect(build(null)).toMatchObject({ sourceState: 'missing', totals: null, byLane: [], byRepo: [] });
    expect(build([]).totals).toMatchObject({ jobs: 0, finishRate: null, prRate: null, emptyRate: null, estCost: null, medianDuration: null });
    const m = build([launch('A'), finish('A', 2, { cost: 1 }), launch('B')]).totals!;
    expect(m).toMatchObject({ jobs: 2, finishRate: 0.5, prRate: null, emptyRate: null, estCost: null, samples: { cost: 1 } });
  });
  it('keeps retries and window boundaries separate and ignores future and orphan events', () => {
    const events = [launch('A', 25), finish('A', 24.5), launch('A', 24), finish('A', 23, { empty: true }),
      launch('A', 2, { lane: 'devin' }), finish('A', 1, { empty: false }), finish('orphan'), launch('future', -1)];
    expect(build(events).totals).toMatchObject({ jobs: 2, finished: 2, emptyRate: 0.5, medianDuration: 3600 });
    expect(build(events).byLane.map(g => g.jobs)).toEqual([1, 1]);
  });
  it('does not invent attempts or route attribution for conflicting launches at one timestamp', () => {
    const m = build([launch('A'), launch('A', 3, { lane: 'other' }), finish('A')]);
    expect(m).toMatchObject({ sourceState: 'degraded', totals: { jobs: 1 }, byLane: [{ name: 'unknown' }] });
  });
  it('does not measure conflicting finishes, negative costs or invalid rows as zeros', () => {
    const m = build([launch('A'), finish('A'), finish('A', 1), launch('B'), finish('B', 1, { cost: -1 }),
      null, { event: 'launch', ts: 'bad', job: 'C' }, { event: 'enqueue' }]);
    expect(m).toMatchObject({ sourceState: 'degraded', ignoredRows: 2 });
    expect(m.totals).toMatchObject({ jobs: 2, finished: 2, estCost: null, samples: { duration: 1, cost: 0 } });
    expect(() => buildOutcomeMetrics({ events: [], nowMs, hours: NaN })).toThrow();
  });
  it('deduplicates URL-keyed merges and measures seven-day reverts only with evidence', () => {
    const merged = event('outcome', 190, { url: pr(1), state: 'MERGED', mergedAt: stamp(200), ttm_s: 100 });
    const m = build([merged, { ...merged, ts: stamp(180) },
      event('publish', 210, { url: pr(1) }), event('revert', 40, { url: pr(1) }),
      event('outcome', 190, { url: pr(2), state: 'MERGED', mergedAt: stamp(200), ttm_s: 200 }),
      event('revert', 1, { url: pr(2) }), // more than seven days later; excluded
      event('revert_coverage', 0, { repo: 'ashlrai/phantom', from: stamp(210), through: stamp(0) })], 240);
    expect(m.byRepo[0]).toMatchObject({ merged: 2, mergesPerDay: 0.2, revertRate: 0.5, revertSamples: 2,
      timeToMerge: { p50: 150, p90: 190, p95: 195, samples: 2 } });
    expect(m.byRepo[0]!.evidenceRefs).toContain('events:6');
    const uncovered = build([merged], 240).byRepo[0]!;
    expect(uncovered.revertRate).toBeNull();
    expect(uncovered.revertSamples).toBe(0);
    expect(build([merged, event('outcome', 180, { url: pr(1), state: 'MERGED' })], 240).byRepo[0]!.merged).toBe(1);
  });
  it('rejects future revert assertions and future coverage while retaining unknown merge durations', () => {
    const m = build([event('outcome', 200, { url: pr(1), state: 'MERGED', mergedAt: stamp(200) }),
      event('outcome', 1, { url: pr(1), revertedAt: stamp(-1) }),
      event('revert_coverage', 200, { repo: 'ashlrai/phantom', from: stamp(201), through: stamp(0) })], 240);
    expect(m.byRepo[0]).toMatchObject({ reverted: 0, revertRate: null, timeToMerge: { p50: null, samples: 0 } });
  });
  it('supports reconciler rows, PR-to-merge duration, unknown merge times and immature coverage', () => {
    const m = build([event('publish', 3, { url: pr(1) }),
      { source: 'metrics-outcomes-reconciler', ts: stamp(1), outcome: 'MERGED', prUrl: pr(1), mergedAt: stamp(2) },
      event('outcome', 1, { url: pr(2), state: 'MERGED' }),
      event('revert_coverage', 0, { repo: 'ashlrai/phantom', from: stamp(4), through: stamp(0) })]);
    expect(m.unknownMergeTimes).toBe(1);
    expect(m.byRepo[0]).toMatchObject({ merged: 1, revertRate: null, timeToMerge: { p50: 3600 } });
  });
});

function measuredFleet(n = 20): unknown[] {
  return ['cheap', 'costly', 'empty'].flatMap((lane, index) => Array.from({ length: n }, (_, i) => {
    const job = `${lane}-${i}`;
    return [launch(job, 3, { lane, model: lane }), finish(job, 2, { cost: index + 1, empty: lane === 'empty' }),
      ...(lane === 'empty' ? [] : [event('publish', 1, { job, url: pr(index * 100 + i + 1) })])];
  }).flat());
}
describe('fleet advisory policy and weekly brief', () => {
  it('bounds advice, carries evidence and prefers measured lower cost within a tier', () => {
    const metrics = build(measuredFleet()), frozen = JSON.stringify(metrics);
    const p = suggestOutcomePolicy(metrics);
    expect(p.suggestOnly).toBe(true);
    expect(p.laneTargetDeltas.map(s => [s.lane, s.delta])).toEqual([['cheap', 1], ['costly', 1], ['empty', -1]]);
    expect(p.tierRoutingHints[0]).toMatchObject({ tier: 'work', preferModel: 'cheap', overModel: 'costly', confidence: 0.5 });
    expect(p.promptTemplateFlags[0]!.evidenceRefs.length).toBeGreaterThan(20);
    expect(JSON.stringify(metrics)).toBe(frozen);
    const weekly = generateWeeklySelfReport({ events: measuredFleet(), nowMs });
    expect(weekly).toContain('Weekly fleet self-report');
    expect(weekly).toContain('(168 hours)');
    expect(weekly).toContain('unknown');
    expect(weekly).toContain('Suggestions never apply changes');
    expect(weekly).toContain('more in JSON');
  });
  it('does not recommend across tiers, marginal savings or worse publication rates', () => {
    const metrics = build(measuredFleet());
    metrics.byModelTier.find(g => g.model === 'costly')!.tier = 'frontier';
    expect(suggestOutcomePolicy(metrics).tierRoutingHints).toEqual([]);
    metrics.byModelTier.find(g => g.model === 'costly')!.tier = 'work';
    metrics.byModelTier.find(g => g.model === 'cheap')!.estCost = 39;
    expect(suggestOutcomePolicy(metrics).tierRoutingHints).toEqual([]);
    metrics.byModelTier.find(g => g.model === 'cheap')!.estCost = 20;
    metrics.byModelTier.find(g => g.model === 'cheap')!.prRate = 0.8;
    expect(suggestOutcomePolicy(metrics).tierRoutingHints).toEqual([]);
  });
  it('abstains on small, degraded or unmeasured input and caps each list at eight', () => {
    for (const metrics of [build(null), build(measuredFleet(19)), build([...measuredFleet(), null])]) {
      expect(suggestOutcomePolicy(metrics).laneTargetDeltas).toEqual([]);
      expect(suggestOutcomePolicy(metrics).tierRoutingHints).toEqual([]);
    }
    const metrics = build(measuredFleet(100));
    metrics.byLane = Array.from({ length: 30 }, (_, i) => ({ ...metrics.byLane[0]!, name: `lane-${i}` }));
    const p = suggestOutcomePolicy(metrics);
    expect(p.laneTargetDeltas).toHaveLength(8);
    expect(p.laneTargetDeltas.every(s => Math.abs(s.delta) <= 1 && s.confidence <= 0.9)).toBe(true);
    metrics.byModelTier.forEach(g => { g.estCost = null; });
    expect(suggestOutcomePolicy(metrics).tierRoutingHints).toEqual([]);
  });
});

describe('fleet metrics CLI', () => {
  it('loads through the fleet registry and reports missing evidence with an unsuccessful status', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.metrics!()).cmdFleetMetrics).toBe(cmdFleetMetrics);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMetrics(['report', '--json'], { read: async () => null, now: () => nowMs })).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ sourceState: 'missing', totals: null });
  });
  it('runs report, suggest and weekly from injected streams without side effects', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(async () => measuredFleet().map(e => JSON.stringify(e)).join('\n'));
    for (const verb of ['report', 'suggest', 'weekly']) {
      expect(await cmdFleetMetrics([verb, '--jobs', '/fixture/jobs.jsonl', '--json'], { read, now: () => nowMs })).toBe(0);
      const output = JSON.parse(log.mock.calls.at(-1)![0] as string);
      if (verb === 'weekly') expect(output.markdown).toContain('168 hours');
      if (verb === 'suggest') expect(output.suggestOnly).toBe(true);
    }
    expect(read).toHaveBeenCalledWith('/fixture/jobs.jsonl');
    expect(await cmdFleetMetrics(['report'], { read: async () => 'broken', now: () => nowMs })).toBe(1);
  });
  it('refuses unknown, repeated or out-of-range options before reading inputs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn(async () => '');
    for (const args of [[], ['apply'], ['report', '--hours', '0'], ['report', '--hours', '2161'],
      ['suggest', '--apply'], ['report', '--jobs'], ['report', '--json', '--json']]) {
      expect(await cmdFleetMetrics(args, { read })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
