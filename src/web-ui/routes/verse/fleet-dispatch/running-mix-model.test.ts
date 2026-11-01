import { describe, expect, it } from 'vitest';
import { classifyLaneJob } from '../../../../core/fleet/lane-class-share.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fillerTellPrefill, mixHeadline, runningMix } from './running-mix-model.js';

const worker = (job: string, lane = 'codex-personal') => ({ job, lane, repo: 'fake/repo', tier: 'mid', ageSeconds: 10 });
const claim = (job: string, lane = 'codex-personal') => ({ job, lane, tier: 'mid', at: '2026-10-31T00:00:00Z' });
const snapshot = (workers: ReturnType<typeof worker>[], claimed: ReturnType<typeof claim>[] = []) =>
  ({ ...fleetRunsFixture({ claudeLane: null }), workers, claimed }) as FleetRuns;

describe('running mix', () => {
  it('uses the shared classifier for workers and keeps claims separate', () => {
    const jobs = ['RQ-PHX-ONE', 'RQ-FIXUP-ONE', 'FIXUP-TWO', 'RQ-ABC1A20261031Q8', 'RQ-OTHER'];
    const rows = runningMix(snapshot([...jobs.map(job => worker(job)), worker('RQ-PHX-TWO', 'other-lane')], [
      claim('RQ-PHX-CLAIM'), claim('RQ-FIXUP-CLAIM'), claim('RQ-PHX-WAIT', 'claim-only'),
    ]));
    const counts = { phx: 0, fixup: 0, filler: 0, other: 0 };
    jobs.forEach(job => { counts[classifyLaneJob(job)]++; });
    expect(rows.map(row => row.lane)).toEqual(['codex-personal', 'other-lane', 'claim-only']);
    expect(rows[0]).toEqual({ lane: 'codex-personal', running: 5, ...counts, fillerPct: 20, claimedPhx: 1, claimedOther: 1 });
    expect(rows[2]).toMatchObject({ running: 0, fillerPct: null, claimedPhx: 1, claimedOther: 0 });
  });

  it('handles empty and claim-only snapshots without a running headline', () => {
    expect(runningMix(null)).toEqual([]);
    expect(mixHeadline([])).toBe('nothing running');
    expect(mixHeadline(runningMix(snapshot([], [claim('RQ-PHX-WAIT')])))).toBe('nothing running');
  });

  it('formats the busiest lane and applies the threshold before rounding', () => {
    const row = runningMix(snapshot([...Array.from({ length: 12 }, (_, i) => worker(`RQ-PHX-${i}`)), ...Array.from({ length: 4 }, (_, i) => worker(`RQ-ABC${i}A20261031Q8`))]))[0]!;
    expect(mixHeadline([row])).toBe('16 running on codex-personal: 12 Phantom, 4 filler (25%)');
    expect(fillerTellPrefill(row)).toBeNull();
    expect(fillerTellPrefill({ ...row, running: 10, filler: 3, fillerPct: 30 })).toBe('Lane codex-personal is running 3 filler jobs of 10 (30%). Prefer Phantom drop jobs; keep 20+ PHX lines in ready.');
    expect(fillerTellPrefill({ ...row, fillerPct: 29.9 })).toBeNull();
    expect(fillerTellPrefill({ ...row, fillerPct: null })).toBeNull();
  });
});
