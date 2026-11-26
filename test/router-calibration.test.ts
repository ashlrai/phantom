import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { calibrateRouting, calibrationMarkdown, readCalibration } from '../src/core/routing/calibration.js';
import { cmdRouterCalibration } from '../src/cli/router-calibration.js';

const jobsPath = 'test/fixtures/calibration/jobs.jsonl';
const exportPath = 'test/fixtures/calibration/posthog.json';
const jobs = readFileSync(jobsPath, 'utf8');
const row = (value: object): string => JSON.stringify(value) + '\n';

describe('router calibration', () => {
  it('joins ledger and PostHog by job, and scores only resolved matched predictions', () => {
    const report = readCalibration(jobsPath, exportPath);
    expect(report.unmatchedPosthogRuns).toBe(1);
    expect(report.arms[0]).toMatchObject({ arm: 'codex', jobs: 2, resolved: 2,
      mergeRate: { actual: 0.5, paired: 2 },
      tokens: { predicted: 200, actual: 180, paired: 2 },
      wallTimeMs: { predicted: 2500, actual: 2500, paired: 2 } });
    expect(report.arms[0]!.mergeRate.predicted).toBeCloseTo(0.6);
    expect(report.arms[0]!.brier).toBeCloseTo(0.1);
    expect(report.arms[1]).toMatchObject({ arm: 'other', jobs: 1, resolved: 0,
      brier: null, mergeRate: { predicted: null, actual: null, paired: 0 } });
    expect(calibrationMarkdown(report)).toContain('| codex | 2 | 2 | 0.6 / 0.5 (2) | 0.1 | 200 / 180 (2) | 2500 / 2500 (2) | 0.5 |');
  });
  it('works without the export and only averages matched measurements', () => {
    const report = calibrateRouting(jobs);
    expect(report.arms[0]!.tokens).toEqual({ predicted: 300, actual: 240, paired: 1 });
    expect(report.unmatchedPosthogRuns).toBe(0);
  });
  it('calibrates dispatcher measurements against a reconciled merge in the jobs ledger', () => {
    const report = calibrateRouting(
      row({ event: 'launch', job: 'RQ-A', lane: 'codex', ts: '2026-01-01T00:00:00+0000' }) +
      row({ event: 'finish', job: 'RQ-A', lane: 'codex', ts: '2026-01-01T00:00:03+0000',
        wall_s: 2.5, tokens_total: 240 }) +
      row({ event: 'publish', jobId: 'RQ-A', outcome: 'MERGED', source: 'metrics-outcomes-reconciler' }) +
      row({ event: 'launch', job: 'RQ-B', lane: 'codex', ts: '2026-01-01T00:00:00+0000',
        predicted_wall_time_ms: 2000 }) +
      row({ event: 'finish', job: 'RQ-B', ts: '2026-01-01T00:00:02+0000' }) +
      row({ event: 'publish', jobId: 'RQ-B', outcome: 'MERGED' }) +
      row({ event: 'launch', job: 'RQ-C', lane: 'codex' }) +
      row({ jobId: 'RQ-C', outcome: 'CLOSED' }) +
      row({ event: 'launch', job: 'RQ-BATCH-A', lane: 'codex' }) +
      row({ event: 'launch', job: 'node-attempt', jobId: 'RQ-A', schema: 'fleet.session-pool.v1' }),
      JSON.stringify([{ job_id: 'RQ-A', predicted_merge_rate: 0.8, predicted_tokens: 300,
        predicted_wall_time_ms: 2000 }]),
    );
    expect(report.arms).toMatchObject([{ arm: 'codex', jobs: 3, resolved: 2, observedMergeRate: 0.5,
      mergeRate: { predicted: 0.8, actual: 1, paired: 1 },
      tokens: { predicted: 300, actual: 240, paired: 1 },
      wallTimeMs: { predicted: 2000, actual: 2250, paired: 2 } }]);
    expect(report.unmatchedPosthogRuns).toBe(0);
  });
  it('rejects ambiguous, malformed, contradictory and invalid evidence', () => {
    expect(() => calibrateRouting(jobs + row({ event: 'launch', job_id: 'TEST-job-1', arm: 'codex' }))).toThrow('Duplicate launch');
    expect(() => calibrateRouting(jobs + row({ event: 'outcome', job_id: 'TEST-job-1', outcome: 'closed' }))).toThrow('Conflicting merged');
    expect(() => calibrateRouting(jobs + '{')).toThrow('Invalid JSON');
    expect(() => calibrateRouting(row({ event: 'unexpected', id: 'TEST-a' }))).toThrow('No recognized dispatch events');
    expect(() => calibrateRouting(row({ event: 'finish', job_id: 'TEST-missing' }))).toThrow('no matching launch');
    expect(() => calibrateRouting(row({ event: 'launch', job_id: 'TEST-bad', arm: 'a', predicted_merge_rate: 1.2 }))).toThrow('Invalid');
    expect(() => calibrateRouting(jobs, JSON.stringify([{ job_id: 'TEST-job-2', total_tokens: 999 }]))).toThrow('Conflicting tokens');
    expect(() => calibrateRouting(jobs, '{}')).toThrow('PostHog export');
  });
  it('excludes dispatcher receipts for work that never launched', () => {
    const skipped = row({ event: 'outcome', state: 'DONE-NOOP', job: 'RQ-SKIP', lane: 'codex', launched: false });
    const exportJson = JSON.stringify([{ job_id: 'RQ-SKIP', total_tokens: 10 }]);
    expect(calibrateRouting(skipped, exportJson)).toMatchObject({ arms: [], unmatchedPosthogRuns: 1 });

    const launch = row({ event: 'launch', job: 'RQ-RUN', lane: 'codex', predicted_tokens: 120 });
    const declined = row({ event: 'outcome', state: 'DONE-NOOP', job: 'RQ-RUN', launched: false, tokens_total: 0 });
    const finish = row({ event: 'finish', job: 'RQ-RUN', tokens_total: 100 });
    expect(calibrateRouting(skipped + declined + launch + finish).arms).toMatchObject([
      { arm: 'codex', jobs: 1, resolved: 0, tokens: { predicted: 120, actual: 100, paired: 1 } },
    ]);
  });
  it('calibrates a batch member from its claim and reconciled verdict', () => {
    const report = calibrateRouting(
      row({ event: 'batch_claim', job: 'RQ-MEMBER', batch: 'RQ-BATCH-A',
        lane: 'codex', lane_hint: 'other', ts: '2026-01-01T00:00:00Z' }) +
      row({ event: 'launch', job: 'RQ-BATCH-A', lane: 'codex' }) +
      row({ event: 'finish', job: 'RQ-MEMBER', ts: '2026-01-01T00:00:03Z' }) +
      row({ event: 'publish', jobId: 'RQ-MEMBER', outcome: 'MERGED', source: 'metrics-outcomes-reconciler' }),
      JSON.stringify([{ job_id: 'RQ-MEMBER', predicted_merge_rate: 0.8, predicted_wall_time_ms: 3000 }]),
    );
    expect(report.unmatchedPosthogRuns).toBe(0);
    expect(report.arms).toMatchObject([{ arm: 'codex', jobs: 1, resolved: 1,
      mergeRate: { actual: 1, paired: 1 }, wallTimeMs: { actual: null, paired: 0 } }]);
  });
  it('uses a standalone launch after a batch claim and withholds ambiguous batch lanes', () => {
    const report = calibrateRouting(
      row({ event: 'batch_claim', job: 'RQ-SOLO', lane: 'other' }) +
      row({ event: 'launch', job: 'RQ-SOLO', lane: 'codex' }) +
      row({ event: 'batch_claim', job: 'RQ-AMBIGUOUS', lane: 'other' }) +
      row({ event: 'batch_claim', job: 'RQ-AMBIGUOUS', lane: 'codex' }) +
      row({ jobId: 'RQ-AMBIGUOUS', outcome: 'CLOSED' }) +
      row({ event: 'batch_claim', job: 'RQ-NO-LANE', lane_hint: 'other' }),
    );
    expect(report.arms).toMatchObject([
      { arm: 'codex', jobs: 1, resolved: 0 },
      { arm: 'unknown', jobs: 2, resolved: 1 },
    ]);
  });
  it('does not treat publish or an unknown outcome as a negative merge', () => {
    const report = calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a', predicted_merge_rate: 0.5 }) +
      row({ event: 'publish', id: 'TEST-a', status: 'published' }) + row({ event: 'outcome', id: 'TEST-a', outcome: 'pending' }));
    expect(report.arms[0]).toMatchObject({ resolved: 0, observedMergeRate: null, brier: null });
  });
  it('skips unknown arm aliases and groups launches with no arm evidence as unknown', () => {
    const report = calibrateRouting(
      row({ event: 'launch', job: 'RQ-SOLO', arm: ' Unknown ', lane: 'codex' }) +
      row({ event: 'batch_claim', job: 'RQ-MEMBER', lane: 'UNKNOWN', pool: 'codex' }) +
      row({ event: 'launch', job: 'RQ-NO-ARM' }),
    );
    expect(report.arms).toMatchObject([
      { arm: 'codex', jobs: 2 },
      { arm: 'unknown', jobs: 1, observedMergeRate: null },
    ]);
  });
  it('rejects reverse time and escapes markdown arm names', () => {
    expect(() => calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a', timestamp: '2026-01-02T00:00:00Z' }) +
      row({ event: 'finish', id: 'TEST-a', timestamp: '2026-01-01T00:00:00Z' }))).toThrow('Finish precedes');
    const report = calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a|b\nc' }));
    expect(calibrationMarkdown(report)).toContain('| a b c |');
  });
  it('handles CLI output, help, usage errors and invalid files', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdRouterCalibration(['--jobs', jobsPath, '--posthog', exportPath, '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).arms[0].arm).toBe('codex');
      expect(await cmdRouterCalibration(['--jobs', jobsPath])).toBe(0);
      expect(log.mock.calls.at(-1)?.[0]).toContain('# Router calibration');
      expect(await cmdRouterCalibration(['--help'])).toBe(0);
      expect(await cmdRouterCalibration(['--jobs'])).toBe(2);
      expect(await cmdRouterCalibration(['--jobs', jobsPath, '--bad'])).toBe(2);
      expect(await cmdRouterCalibration(['--jobs', 'TEST-missing'])).toBe(1);
      expect(error.mock.calls.at(-1)?.[0]).toBe('error: Could not read input file');
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
