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
    expect(() => calibrateRouting(jobs + row({ event: 'launch', job_id: 'TEST-job-1', arm: 'codex' }))).toThrow('Duplicate launch');
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
