import { describe, expect, it } from 'vitest';
import { percentiles, summarizeMergeGate } from '../scripts/merge-gate-latency.mjs';

const job = (name: string, seconds: number) => ({ name, conclusion: 'success',
  started_at: '2026-11-02T00:00:00Z', completed_at: new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString() });
const sample = (classify: number, quick: number, secret: number) => ({ jobs: [
  job('Classify PR site lane', classify), job('Quick typecheck', quick), job('Secret-shape scan', secret),
] });

describe('Merge Gate execution latency measurement', () => {
  it('uses nearest ranks without mutating the measurements', () => {
    const values = [100, 10, 30, 20, 50, 40, 60, 90, 70, 80];
    expect(percentiles(values)).toEqual({ n: 10, p50: 50, p90: 90 });
    expect(values[0]).toBe(100);
    expect(percentiles([12])).toEqual({ n: 1, p50: 12, p90: 12 });
  });

  it('models parallel execution with the secret scan still on the critical path', () => {
    const result = summarizeMergeGate([sample(15, 60, 12)]);
    expect(result.serial.p50).toBe(75);
    expect(result.parallel.p50).toBe(60);
    const securityBound = summarizeMergeGate([sample(15, 60, 90)]);
    expect(securityBound.serial.p50).toBe(90);
    expect(securityBound.parallel.p50).toBe(90);
  });

  it('reproduces the merged PR sample without treating execution time as merge latency', () => {
    // Public CI jobs for merged PRs 3114, 3113, 3111, 3110, 3109, 3108,
    // 3107, 3106, 3105, 3104, 3103 and 3102, collected 2026-11-03 UTC.
    const measured = [[13, 62, 12], [15, 52, 10], [11, 62, 12], [14, 52, 11],
      [12, 69, 9], [10, 52, 11], [10, 44, 9], [14, 40, 12],
      [14, 51, 10], [11, 64, 12], [10, 60, 8], [13, 64, 12]];
    const result = summarizeMergeGate(measured.map(([classify, quick, secret]) => sample(classify!, quick!, secret!)));
    expect(result.serial).toEqual({ n: 12, p50: 67, p90: 77 });
    expect(result.parallel).toEqual({ n: 12, p50: 52, p90: 64 });
  });

  it('refuses incomplete, duplicate, failed and invalid measurements', () => {
    for (const values of [[], [-1], [NaN], [Infinity]]) expect(() => percentiles(values)).toThrow();
    expect(() => summarizeMergeGate([])).toThrow();
    for (const mutate of [
      (s: ReturnType<typeof sample>) => { s.jobs.pop(); },
      (s: ReturnType<typeof sample>) => { s.jobs.push(s.jobs[0]!); },
      (s: ReturnType<typeof sample>) => { s.jobs[0]!.conclusion = 'failure'; },
      (s: ReturnType<typeof sample>) => { s.jobs[0]!.completed_at = ''; },
      (s: ReturnType<typeof sample>) => { s.jobs[0]!.completed_at = 'invalid'; },
      (s: ReturnType<typeof sample>) => { s.jobs[0]!.completed_at = '2026-11-01T00:00:00Z'; },
    ]) {
      const value = sample(15, 60, 12); mutate(value);
      expect(() => summarizeMergeGate([value])).toThrow();
    }
  });
});
