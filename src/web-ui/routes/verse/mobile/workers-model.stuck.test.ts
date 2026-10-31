import { describe, expect, it } from 'vitest';
import { ageStateText, laneAgeThresholds } from '../fleet/worker-age-state.js';
import { stuckCount, workerRows } from './workers-model.js';

describe('mobile worker age states', () => {
  it('uses the desktop lane thresholds and counts only stuck workers', () => {
    const lane = 'codex-personal';
    const { longSec, stuckSec } = laneAgeThresholds(lane);
    const workers = [
      { job: 'stuck', ageSeconds: 3 * 60 * 60 },
      { job: 'long', ageSeconds: longSec + 1 },
      { job: 'stuck-boundary', ageSeconds: stuckSec },
      { job: 'long-boundary', ageSeconds: longSec },
      { job: '25-min', ageSeconds: 25 * 60 },
      { job: 'normal', ageSeconds: 5 * 60 },
      { job: 'unknown', ageSeconds: null },
    ].map(worker => ({ ...worker, lane, tier: 'work' }));
    const { rows } = workerRows({ workers }, 0);
    const byJob = Object.fromEntries(rows.map(row => [row.job, row]));

    expect(byJob.stuck.ageState).toBe('stuck');
    expect(byJob.long.ageState).toBe('long');
    expect(byJob['stuck-boundary'].ageState).toBe('long');
    expect(byJob['long-boundary'].ageState).toBe('normal');
    expect(byJob['25-min'].ageState).toBe('normal');
    expect(byJob.normal.ageState).toBe('normal');
    expect(byJob.unknown.ageState).toBe('normal');
    expect(byJob.stuck.ageNote).toBe(ageStateText('stuck', lane));
    expect(byJob.long.ageNote).toBe(ageStateText('long', lane));
    expect(byJob.normal.ageNote).toBeNull();
    expect(stuckCount(rows)).toBe(1);
    expect(stuckCount([])).toBe(0);
  });

  it('uses the individual lane for workers of the same age', () => {
    const { rows } = workerRows({ workers: ['codex-personal', 'codex-local', 'devin'].map(lane => ({
      job: lane, lane, tier: 'work', ageSeconds: 75 * 60,
    })) }, 0);
    expect(Object.fromEntries(rows.map(row => [row.job, row.ageState]))).toEqual({
      'codex-personal': 'stuck', 'codex-local': 'long', devin: 'normal',
    });
    expect(stuckCount(rows)).toBe(1);
  });
});
