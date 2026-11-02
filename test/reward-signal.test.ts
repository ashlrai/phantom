/** Inert fixtures only. No provider calls, native profiles or credentials. */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRewardSignalV1, latestRewardSignals, readRewardSignals, rewardSignalPath,
  usageCostFromReadings, writeRewardSignal, type RewardSignalInput, type RewardSignalV1,
} from '../src/core/metrics/reward-signal.js';
import { calibrateRouting } from '../src/core/routing/calibration.js';
import type { UsageReading } from '../src/core/fabric/usage-signal-writer.js';

const START = '2026-10-28T12:00:00.000Z';
const DISPATCHED = '2026-10-28T10:00:00.000Z';
const MERGED = '2026-10-28T11:30:00.000Z';
let directory: string;
let path: string;
let clock: number;
const now = () => new Date(clock);
const lines = (): string[] => {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter((line) => line.trim()); }
  catch { return []; }
};
const rows = (): RewardSignalV1[] => lines().map((line) => JSON.parse(line) as RewardSignalV1);

const fixture = (patch: Partial<RewardSignalInput> = {}): RewardSignalInput => ({
  jobId: 'RQ-SELFOPT-REWARD-SIGNALS', pool: 'devin', repo: 'ashlrai/phantom',
  merged: true, dispatchedAt: DISPATCHED, mergedAt: MERGED, ciWallMs: 1_200_000, costUsd: 1.85,
  ...patch,
});
const run = (input: RewardSignalInput = fixture(), extra: Record<string, unknown> = {}) =>
  writeRewardSignal(input, { path, now, ...extra });
const reading = (pool: UsageReading['pool'], pctUsed: number, at: string,
  resetAt: string | null = '2026-11-02T12:00:00.000Z'): UsageReading => ({
  pool, pctUsed, resetAt, source: `${pool}-reader`, fetchedAt: at,
  writtenAt: at, event: 'manual-reading', burnRatePctPerHour: null, projected100At: null, cutActive: false,
});

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'reward-signal-')));
  chmodSync(directory, 0o700);
  path = join(directory, 'reward-signals.jsonl');
  clock = Date.parse(START);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('writeRewardSignal', () => {
  it('writes exactly one row for a fixture job', () => {
    const result = run();
    expect(result.status).toBe('recorded');
    expect(lines()).toHaveLength(1);
    expect(rows()[0]).toEqual({
      v: 1, jobId: 'RQ-SELFOPT-REWARD-SIGNALS', pool: 'devin', repo: 'ashlrai/phantom',
      merged: true, dispatchedAt: DISPATCHED, mergedAt: MERGED, timeToMergeMs: 5_400_000,
      ciWallMs: 1_200_000,
      cost: { pool: 'devin', pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null, costUsd: 1.85 },
      recordedAt: START,
    });
    expect(isRewardSignalV1(rows()[0])).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('accepts router-queue job ids that embed a 64-hex hash', () => {
    expect(run(fixture({ jobId: `rq-${'a'.repeat(64)}` })).status).toBe('recorded');
  });

  it('appends additional jobs and replays the same outcome as a duplicate', () => {
    expect(run().status).toBe('recorded');
    expect(run(fixture({ jobId: 'RQ-OTHER-JOB' })).status).toBe('recorded');
    const replay = run();
    expect(replay.status).toBe('duplicate');
    expect(replay.row.jobId).toBe('RQ-SELFOPT-REWARD-SIGNALS');
    expect(lines()).toHaveLength(2);
  });

  it('refuses a conflicting outcome for a recorded job', () => {
    run();
    expect(() => run(fixture({ merged: false, mergedAt: null }))).toThrow();
    expect(() => run(fixture({ mergedAt: '2026-10-28T11:45:00.000Z' }))).toThrow();
    expect(lines()).toHaveLength(1);
  });

  it('records a terminal non-merge with null timing fields', () => {
    const result = run(fixture({ merged: false, mergedAt: null, ciWallMs: null, costUsd: null }));
    expect(result.row).toMatchObject({ merged: false, mergedAt: null, timeToMergeMs: null, ciWallMs: null });
    expect(result.row.cost).toEqual({ pool: 'devin', pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null, costUsd: null });
  });

  it.each([
    { jobId: '' }, { jobId: 'has space' }, { jobId: 'sk-' + 'x'.repeat(60) },
    { pool: 'UPPER' }, { repo: 'no-slash' }, { dispatchedAt: 'not-a-date' },
    { dispatchedAt: '2026-10-28' }, { dispatchedAt: '2026-10-30T00:00:00.000Z' },
    { mergedAt: '2026-10-28T09:00:00.000Z' }, { mergedAt: 'bogus' },
    { merged: false }, { merged: true, mergedAt: null }, { ciWallMs: -1 }, { costUsd: Number.NaN },
  ])('rejects invalid input %j', (patch) => {
    expect(() => run(fixture(patch))).toThrow();
    expect(rows()).toHaveLength(0);
  });

  it('refuses a credential-shaped jobId without recording it', () => {
    expect(() => run(fixture({ jobId: 'sk-' + 'x'.repeat(60) }))).toThrow(/Refused/);
    expect(rows()).toHaveLength(0);
  });

  it('canonicalizes offset and no-millis timestamps', () => {
    const result = run(fixture({ dispatchedAt: '2026-10-28T05:00:00-05:00', mergedAt: '2026-10-28T11:30:00Z' }));
    expect(result.row.dispatchedAt).toBe(DISPATCHED);
    expect(result.row.mergedAt).toBe(MERGED);
  });

  it('meters job cost from the existing usage readers', () => {
    const log = join(directory, 'usage-readings.log');
    writeFileSync(log, [
      reading('codex-cmp', 10, '2026-10-28T09:00:00.000Z'),
      reading('codex-cmp', 12, '2026-10-28T10:30:00.000Z'),
      reading('codex-cmp', 31, '2026-10-28T11:59:00.000Z'),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    const result = run(fixture(), { usageLogPath: log, usagePool: 'codex-cmp' });
    expect(result.row.cost).toEqual({ pool: 'codex-cmp', pctUsedStart: 10, pctUsedEnd: 31, pctUsedDelta: 21, costUsd: 1.85 });
  });

  it('leaves the delta unknown when the pool window resets inside the job', () => {
    const readings = [
      reading('codex-cmp', 90, '2026-10-28T09:00:00.000Z', '2026-10-28T10:00:00.000Z'),
      reading('codex-cmp', 5, '2026-10-28T11:00:00.000Z', '2026-11-04T10:00:00.000Z'),
    ];
    const result = run(fixture(), { usageReadings: readings, usagePool: 'codex-cmp' });
    expect(result.row.cost).toMatchObject({ pctUsedStart: 90, pctUsedEnd: 5, pctUsedDelta: null });
  });
});

describe('usageCostFromReadings', () => {
  const window = { start: Date.parse(DISPATCHED), end: Date.parse(START) };
  it('brackets the job window with the nearest pre-dispatch and pre-record readings', () => {
    const cost = usageCostFromReadings(
      [reading('codex-cmp', 40, '2026-10-28T08:00:00.000Z'),
       reading('codex-cmp', 55, '2026-10-28T11:00:00.000Z'),
       reading('codex-cmp', 95, '2026-10-28T13:00:00.000Z')],
      'codex-cmp', window.start, window.end);
    expect(cost).toMatchObject({ pctUsedStart: 40, pctUsedEnd: 55, pctUsedDelta: 15 });
  });
  it('ignores other pools and stays unknown without readings', () => {
    expect(usageCostFromReadings([reading('terra', 5, '2026-10-28T11:00:00.000Z')], 'codex-cmp', window.start, window.end))
      .toMatchObject({ pool: 'codex-cmp', pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null });
  });
});

describe('readRewardSignals / latestRewardSignals', () => {
  it('reads appended rows, skips torn lines, and collapses to one row per job', () => {
    run(fixture());
    run(fixture({ jobId: 'RQ-A' }));
    expect(readRewardSignals(path)).toHaveLength(2);
    expect(latestRewardSignals(path).map((r) => r.jobId)).toEqual(['RQ-SELFOPT-REWARD-SIGNALS', 'RQ-A']);
    const parsed = readFileSync(path, 'utf8');
    writeFileSync(path, parsed + '{"v":1,"jobId":', { mode: 0o600 });
    expect(readRewardSignals(path)).toHaveLength(2);
    expect(() => run(fixture({ jobId: 'RQ-B' }))).toThrow();
  });

  it('reads an absent file as empty', () => {
    expect(readRewardSignals(join(directory, 'nope.jsonl'))).toEqual([]);
    expect(latestRewardSignals(join(directory, 'nope.jsonl'))).toEqual([]);
  });

  it('defaults to the metrics ledger under ASHLR_HOME', () => {
    expect(rewardSignalPath('/x/ashlr')).toBe(join('/x/ashlr', 'metrics', 'reward-signals.jsonl'));
  });
});

describe('router consumption', () => {
  it('reads a reward-signal file directly as resolved job outcomes', () => {
    run(fixture());
    run(fixture({ jobId: 'RQ-SECOND', merged: false, mergedAt: null, ciWallMs: 600_000, costUsd: null }));
    const report = calibrateRouting(readFileSync(path, 'utf8'));
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]).toMatchObject({ arm: 'devin', jobs: 2, resolved: 2 });
    // No recorded predictions: the outcome side is present but unpaired.
    expect(report.arms[0]!.mergeRate).toEqual({ predicted: null, actual: null, paired: 0 });
  });

  it('pairs reward outcomes with launch predictions by jobId', () => {
    run(fixture());
    const launch = JSON.stringify({ event: 'launch', job_id: 'RQ-SELFOPT-REWARD-SIGNALS', arm: 'devin',
      timestamp: DISPATCHED, predicted_merge_rate: 0.4 });
    const report = calibrateRouting(`${launch}\n${readFileSync(path, 'utf8')}`);
    expect(report.arms[0]).toMatchObject({ arm: 'devin', jobs: 1, resolved: 1 });
    expect(report.arms[0]!.mergeRate).toEqual({ predicted: 0.4, actual: 1, paired: 1 });
    expect(report.arms[0]!.brier).toBeCloseTo(0.36, 5);
  });

  it('joins a launch event that lands after the reward row in the file', () => {
    run(fixture());
    const launch = JSON.stringify({ event: 'launch', job_id: 'RQ-SELFOPT-REWARD-SIGNALS', arm: 'devin',
      timestamp: DISPATCHED, predicted_merge_rate: 0.4 });
    const report = calibrateRouting(`${readFileSync(path, 'utf8').trim()}\n${launch}`);
    expect(report.arms[0]).toMatchObject({ arm: 'devin', jobs: 1, resolved: 1 });
    expect(report.arms[0]!.mergeRate).toEqual({ predicted: 0.4, actual: 1, paired: 1 });
  });

  it('buckets a reward outcome with no pool under the unknown arm', () => {
    run(fixture({ pool: null, jobId: 'RQ-UNPOOLED' }));
    const report = calibrateRouting(readFileSync(path, 'utf8'));
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]).toMatchObject({ arm: 'unknown', jobs: 1, resolved: 1 });
  });

  it('fails closed when a reward outcome conflicts with a recorded launch', () => {
    run(fixture());
    const launch = JSON.stringify({ event: 'launch', job_id: 'RQ-SELFOPT-REWARD-SIGNALS', arm: 'codex',
      timestamp: DISPATCHED });
    expect(() => calibrateRouting(`${launch}\n${readFileSync(path, 'utf8')}`)).toThrow('Conflicting arm');
  });

  it('fails closed when a later launch claims a conflicting arm', () => {
    run(fixture());
    const launch = JSON.stringify({ event: 'launch', job_id: 'RQ-SELFOPT-REWARD-SIGNALS', arm: 'codex',
      timestamp: DISPATCHED });
    expect(() => calibrateRouting(`${readFileSync(path, 'utf8').trim()}\n${launch}`)).toThrow('Conflicting arm');
  });
});
