import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('counts batch members as attempts and never the RQ-BATCH session id as a job', () => {
    const claim = (job: string, hours = 3, extra = {}) => event('batch_claim', hours,
      { job, batch: 'RQ-BATCH-ABC123', lane: 'codex', model: 'model-a', tier: 'work', ...extra });
    const member = (job: string, outcome: string, hours = 2) => event('task_outcome', hours,
      { job, batch: 'RQ-BATCH-ABC123', lane: 'codex', outcome });
    const m = build([
      // The session's own launch/finish are infrastructure rows, not an attempt.
      launch('RQ-BATCH-ABC123', 3.5, { batch_size: 3 }),
      finish('RQ-BATCH-ABC123', 1.5, { wall_s: 7200, batch_size: 3 }),
      claim('MEMBER-A'), member('MEMBER-A', 'done'),
      event('publish', 1, { job: 'MEMBER-A', url: pr(7) }),
      claim('MEMBER-B'), member('MEMBER-B', 'failed'),
      claim('MEMBER-C'), // claimed but not yet reaped: unfinished
      event('task_outcome', 1, { job: 'ORPHAN', outcome: 'done' }), // no claim: ignored
      { event: 'batch_claim', ts: stamp(1) }, // missing job: ignored row
    ]);
    expect(m.sourceState).toBe('degraded');
    expect(m.ignoredRows).toBe(1);
    expect(m.totals).toMatchObject({ jobs: 3, finished: 2, finishRate: 2 / 3,
      medianDuration: 3600, estCost: null, samples: { pr: 1, published: 1, duration: 2, cost: 0 } });
    expect(m.byLane).toEqual([expect.objectContaining({ name: 'codex', jobs: 3, finished: 2 })]);
    expect(m.byModelTier).toEqual([expect.objectContaining({ model: 'model-a', tier: 'work', jobs: 3 })]);
  });
  it('counts a requeued batch member\'s next claim as a new attempt', () => {
    const claim = (hours: number) => event('batch_claim', hours,
      { job: 'MEMBER-A', batch: 'RQ-BATCH-ABC123', lane: 'codex' });
    const member = (outcome: string, hours: number) => event('task_outcome', hours,
      { job: 'MEMBER-A', batch: 'RQ-BATCH-ABC123', outcome });
    const m = build([claim(5), member('failed', 4), claim(3), member('done', 2),
      event('publish', 1, { job: 'MEMBER-A', url: pr(8) })]);
    expect(m.totals).toMatchObject({ jobs: 2, finished: 2, finishRate: 1,
      samples: { pr: 1, published: 1 } });
    expect(m.sourceState).toBe('healthy');
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
  it('defaults to the typed hourly series for people and JSON callers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of [[], ['--json'], ['series', '--json']]) {
      expect(await cmdFleetMetrics(args, { read: async () => '', now: () => nowMs })).toBe(0);
      if (args.includes('--json')) expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'fleet.metrics-series.v1', mergesLastHour: 0 });
    }
    expect(await cmdFleetMetrics(['--json'], { read: async () => null, now: () => nowMs })).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ known: false, mergesLastHour: null });
  });
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
  it('marks a cut ledger tail degraded instead of claiming complete coverage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(async () => ({ text: measuredFleet().map(e => JSON.stringify(e)).join('\n'), truncated: true }));
    expect(await cmdFleetMetrics(['report', '--json'], { read, now: () => nowMs })).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ sourceState: 'degraded' });
    expect(await cmdFleetMetrics(['suggest', '--json'], { read, now: () => nowMs })).toBe(1);
    const suggestion = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(suggestion).toMatchObject({ sourceState: 'degraded', laneTargetDeltas: [], tierRoutingHints: [] });
  });
  it('reads the newest tail of an oversized ledger through the default reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-metrics-'));
    try {
      const path = join(dir, 'jobs.jsonl');
      // Whitespace-only lines are filtered before parsing, so the padding keeps
      // ignoredRows at zero and the degraded verdict can only come from the cut.
      const pad = `${' '.repeat(100)}\n`.repeat(168_000);
      const tail = [launch('TAIL', 3, { lane: 'tail-lane' }), finish('TAIL', 2, { cost: 1, empty: false })]
        .map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(path, pad + tail);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdFleetMetrics(['report', '--jobs', path, '--json'], { now: () => nowMs })).toBe(1);
      const report = JSON.parse(log.mock.calls.at(-1)![0] as string);
      expect(report).toMatchObject({ sourceState: 'degraded', ignoredRows: 0,
        totals: { jobs: 1, finished: 1, estCost: 1 } });
      expect(report.byLane).toEqual([expect.objectContaining({ name: 'tail-lane', jobs: 1 })]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses unknown, repeated or out-of-range options before reading inputs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn(async () => '');
    for (const args of [['series', '--hours', '24'], ['apply'], ['report', '--hours', '0'], ['report', '--hours', '2161'],
      ['suggest', '--apply'], ['report', '--jobs'], ['report', '--json', '--json']]) {
      expect(await cmdFleetMetrics(args, { read })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
