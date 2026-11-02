import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRouterCalibration } from '../src/cli/router-calibration.js';
import { calibrationMarkdown, readCalibration } from '../src/core/routing/calibration.js';

const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');

describe('router calibration baseline comparison', () => {
  let root: string;
  let baseline: string;
  let current: string;
  let posthog: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'calibration-comparison-'));
    baseline = join(root, 'baseline.jsonl'); current = join(root, 'current.jsonl'); posthog = join(root, 'posthog.json');
    writeFileSync(baseline, jsonl([
      { event: 'launch', id: 'b1', arm: 'shared', predictedMergeRate: 0.8, predictedTokens: 100 },
      { event: 'outcome', id: 'b1', merged: true },
      { event: 'launch', id: 'b2', arm: 'shared', predictedMergeRate: 0.4 },
      { event: 'outcome', id: 'b2', merged: false },
      { event: 'launch', id: 'b3', arm: 'retired' },
    ]));
    writeFileSync(current, jsonl([
      { event: 'launch', id: 'c1', arm: 'shared', predictedMergeRate: 0.5, predictedTokens: 200, tokens: 180 },
      { event: 'outcome', id: 'c1', merged: true },
      { event: 'launch', id: 'c2', arm: 'shared', predictedMergeRate: 0.9 },
      { event: 'outcome', id: 'c2', merged: true },
      { event: 'launch', id: 'c3', arm: 'shared', predictedMergeRate: 0.3 },
      { event: 'outcome', id: 'c3', merged: false },
      { event: 'launch', id: 'c4', arm: 'new|arm' },
    ]));
    writeFileSync(posthog, JSON.stringify([{ jobId: 'b1', tokens: 80 }, { jobId: 'missing', tokens: 1 }]));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('compares real reports, preserving populations and paired denominators', async () => {
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs', baseline, '--baseline-posthog', posthog, '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(result.baseline).toEqual({ posthogProvided: true, report: readCalibration(baseline, posthog) });
    expect(result.current).toEqual({ posthogProvided: false, report: readCalibration(current) });
    expect(result.baseline.report.unmatchedPosthogRuns).toBe(1);
    expect(result.baseline.report.arms.find((a: { arm: string }) => a.arm === 'shared')).toMatchObject({
      jobs: 2, resolved: 2, mergeRate: { paired: 2 }, tokens: { predicted: 100, actual: 80, paired: 1 },
    });
    expect(result.current.report.arms.find((a: { arm: string }) => a.arm === 'shared')).toMatchObject({
      jobs: 3, resolved: 3, mergeRate: { paired: 3 }, tokens: { predicted: 200, actual: 180, paired: 1 },
    });
    const shared = result.comparisons.find((a: { arm: string }) => a.arm === 'shared');
    expect(shared.population).toBe('both');
    expect(shared.delta.mergeRate.predicted).toBeCloseTo((0.5 + 0.9 + 0.3) / 3 - 0.6);
    expect(shared.delta.mergeRate.actual).toBeCloseTo(2 / 3 - 0.5);
    expect(shared.delta.brier).toBeCloseTo((0.25 + 0.01 + 0.09) / 3 - 0.1);
    expect(shared.delta.tokens).toEqual({ predicted: 100, actual: 100 });
    expect(shared.delta.wallTimeMs).toEqual({ predicted: null, actual: null });
    expect(result.comparisons.find((a: { arm: string }) => a.arm === 'retired')).toMatchObject({
      population: 'baseline-only', delta: { brier: null, tokens: { actual: null, predicted: null } },
    });
    expect(result.comparisons.find((a: { arm: string }) => a.arm === 'new|arm').population).toBe('current-only');
  });

  it('names populations and unavailable values in text when optional evidence is missing', async () => {
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs', baseline])).toBe(0);
    const output = String(log.mock.calls.at(-1)?.[0]);
    expect(output).toContain('## Baseline (PostHog not provided)');
    expect(output).toContain('## Current (PostHog not provided)');
    expect(output).toContain('| shared | 2 | 2 |');
    expect(output).toContain('| shared | 3 | 3 |');
    expect(output).toContain('| retired | baseline-only | n/a / n/a |');
    expect(output).toContain('| new arm | current-only | n/a / n/a |');
    expect(output).toContain('Populations and denominators can differ');
    expect(output).toContain('differences do not establish causation');
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs', baseline, '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(result.comparisons.find((a: { arm: string }) => a.arm === 'shared').delta.tokens).toEqual({ predicted: null, actual: null });
  });

  it('fails closed on an unreadable baseline and rejects invalid flags', async () => {
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs', join(root, 'private-missing'), '--json'])).toBe(1);
    expect(error.mock.calls.at(-1)?.[0]).toBe('error: Could not read input file');
    expect(log).not.toHaveBeenCalled();
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-posthog', posthog])).toBe(2);
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs'])).toBe(2);
    expect(await cmdRouterCalibration(['--jobs', current, '--baseline-jobs', baseline, '--baseline-jobs', baseline])).toBe(2);
  });

  it('preserves the original single-report JSON and text', async () => {
    const report = readCalibration(current);
    expect(await cmdRouterCalibration(['--jobs', current, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(report);
    expect(await cmdRouterCalibration(['--jobs', current])).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toBe(calibrationMarkdown(report).trimEnd());
  });
});
