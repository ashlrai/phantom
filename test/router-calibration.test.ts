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
    expect(calibrationMarkdown(report)).toContain('| codex | 2 | 2 | 0.6 / 0.5 (2) | 0.1 | 200 / 180 (2) | 2500 / 2500 (2) |');
  });
  it('works without the export and only averages matched measurements', () => {
    const report = calibrateRouting(jobs);
    expect(report.arms[0]!.tokens).toEqual({ predicted: 300, actual: 240, paired: 1 });
    expect(report.unmatchedPosthogRuns).toBe(0);
  });
  it('rejects ambiguous, malformed, contradictory and invalid evidence', () => {
    // A launch recorded after the job's verdict is a later attempt: it must
    // not steal the resolved outcome's arm attribution.
    const relaunched = calibrateRouting(jobs + row({ event: 'launch', job_id: 'TEST-job-1', arm: 'other', timestamp: '2026-01-03T00:00:00Z' }));
    expect(relaunched.arms[0]).toMatchObject({ arm: 'codex', jobs: 2, resolved: 2 });
    expect(() => calibrateRouting(jobs + row({ event: 'outcome', job_id: 'TEST-job-1', outcome: 'closed' }))).toThrow('Conflicting merged');
    expect(() => calibrateRouting(jobs + '{')).toThrow('Invalid JSON');
    expect(() => calibrateRouting(row({ event: 'unexpected', id: 'TEST-a' }))).toThrow('No recognized dispatch events');
    expect(() => calibrateRouting(row({ event: 'finish', job_id: 'TEST-missing' }))).toThrow('no matching launch');
    expect(() => calibrateRouting(row({ event: 'launch', job_id: 'TEST-bad', arm: 'a', predicted_merge_rate: 1.2 }))).toThrow('Invalid');
    expect(() => calibrateRouting(jobs, JSON.stringify([{ job_id: 'TEST-job-2', total_tokens: 999 }]))).toThrow('Conflicting tokens');
    expect(() => calibrateRouting(jobs, '{}')).toThrow('PostHog export');
  });
  it('does not treat publish or an unknown outcome as a negative merge', () => {
    const report = calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a', predicted_merge_rate: 0.5 }) +
      row({ event: 'publish', id: 'TEST-a', status: 'published' }) + row({ event: 'outcome', id: 'TEST-a', outcome: 'pending' }));
    expect(report.arms[0]).toMatchObject({ resolved: 0, brier: null });
  });
  it('rejects reverse time and escapes markdown arm names', () => {
    expect(() => calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a', timestamp: '2026-01-02T00:00:00Z' }) +
      row({ event: 'finish', id: 'TEST-a', timestamp: '2026-01-01T00:00:00Z' }))).toThrow('Finish precedes');
    const report = calibrateRouting(row({ event: 'launch', id: 'TEST-a', arm: 'a|b\nc' }));
    expect(calibrationMarkdown(report)).toContain('| a b c |');
  });
  it('reads the fleet jobs-ledger dialect and pairs the attempt that produced the outcome', () => {
    const ledger = [
      // dispatchd rows: job/ts/lane, wall_s and tokens_total on finish.
      row({ event: 'launch', job: 'RQ-FLEET-1', ts: '2026-01-01T00:00:00-0500', lane: 'devin', tier: 'work', model: 'm', predicted_merge_rate: 0.9, predicted_tokens: 500, predicted_wall_time_ms: 60000 }),
      row({ event: 'finish', job: 'RQ-FLEET-1', ts: '2026-01-01T00:10:00-0500', wall_s: 600, tokens_total: 42000 }),
      row({ event: 'publish', job: 'RQ-FLEET-1', ts: '2026-01-01T00:11:00-0500' }),
      row({ event: 'outcome', job: 'RQ-FLEET-1', state: 'MERGED', ts: '2026-01-01T00:30:00-0500', mergedAt: '2026-01-01T00:29:00-0500' }),
      // A retry is a second attempt: the dispatch before the outcome wins.
      row({ event: 'launch', job: 'RQ-FLEET-2', ts: '2026-01-01T01:00:00-0500', lane: 'codex', predicted_merge_rate: 0.5 }),
      row({ event: 'finish', job: 'RQ-FLEET-2', ts: '2026-01-01T01:05:00-0500', wall_s: 300 }),
      row({ event: 'launch', job: 'RQ-FLEET-2', ts: '2026-01-01T02:00:00-0500', lane: 'devin', predicted_merge_rate: 0.7 }),
      row({ event: 'finish', job: 'RQ-FLEET-2', ts: '2026-01-01T02:10:00-0500', wall_s: 500, tokens_total: 9000 }),
      row({ event: 'outcome', job: 'RQ-FLEET-2', state: 'CLOSED', ts: '2026-01-01T03:00:00-0500' }),
      // Batch members dispatch through batch_claim/task_outcome; the
      // reconciler resolves them on a publish-shaped row.
      row({ event: 'batch_claim', job: 'RQ-FLEET-3', ts: '2026-01-01T03:50:00-0500', lane: 'devin' }),
      row({ event: 'task_outcome', job: 'RQ-FLEET-3', ts: '2026-01-01T03:59:00-0500', outcome: 'done', wall_s: 540 }),
      row({ event: 'publish', jobId: 'RQ-FLEET-3', source: 'metrics-outcomes-reconciler', outcome: 'MERGED', mergedAt: '2026-01-01T04:00:00-0500', ts: '2026-01-01T04:01:00-0500' }),
      // Session machinery, batch session ids, pre-launch skips and
      // operational rows are not routing evidence.
      row({ schema: 'fleet.session-pool.v1', event: 'session_start', job: 'RQ-FLEET-9', jobId: 'RQ-FLEET-3', ts: '2026-01-01T03:40:00-0500' }),
      row({ event: 'launch', job: 'RQ-BATCH-7', ts: '2026-01-01T03:41:00-0500', lane: 'devin' }),
      row({ event: 'outcome', job: 'RQ-NOOP-1', state: 'DONE-NOOP', ts: '2026-01-01T05:00:00-0500', launched: false }),
      row({ event: 'claim', job: 'RQ-FLEET-1', ts: '2026-01-01T00:00:00-0500', launch_dedupe: true }),
      row({ event: 'enqueue', job: 'RQ-FLEET-4', ts: '2026-01-01T05:30:00-0500' }),
    ].join('');
    const report = calibrateRouting(ledger);
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]).toMatchObject({ arm: 'devin', jobs: 3, resolved: 3,
      mergeRate: { actual: 0.5, paired: 2 },
      tokens: { predicted: 500, actual: 42000, paired: 1 },
      wallTimeMs: { predicted: 60000, actual: 600000, paired: 1 } });
    expect(report.arms[0]!.mergeRate.predicted).toBeCloseTo(0.8);
    expect(report.arms[0]!.brier).toBeCloseTo(0.25);
  });
  it('counts a merge a later revert postdates as not held', () => {
    const ledger = [
      row({ event: 'launch', job: 'RQ-REV-1', ts: '2026-01-01T00:00:00Z', lane: 'devin', predicted_merge_rate: 0.8 }),
      row({ event: 'finish', job: 'RQ-REV-1', ts: '2026-01-01T00:10:00Z' }),
      row({ event: 'outcome', job: 'RQ-REV-1', state: 'MERGED', ts: '2026-01-01T01:00:00Z' }),
      row({ event: 'revert', job: 'RQ-REV-1', ts: '2026-01-01T02:00:00Z' }),
    ].join('');
    const report = calibrateRouting(ledger);
    expect(report.arms[0]).toMatchObject({ arm: 'devin', jobs: 1, resolved: 1,
      mergeRate: { actual: 0, paired: 1 } });
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
