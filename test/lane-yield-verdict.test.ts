import { describe, expect, it } from 'vitest';
import { laneYield, laneYieldAll, lowYieldReason, parseLaneJobs } from '../src/core/fleet/lane-yield-verdict.js';
import { routeToEligibleLane } from '../src/core/fleet/lane-route-eligibility.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const jobs = (lane: string, n: number, empty: number, at = 1000) =>
  Array.from({ length: n }, (_, i) => ({ job: `${lane}${i}`, lane, at, empty: i < empty, merged: i >= empty && i < empty + 3 }));

const row = (lane: string): LaneTargetRow => ({ lane, target: 4, floor: 0, ceiling: 8, held: false, heldUntil: null, heldReason: null } as unknown as LaneTargetRow);
const targets = { sourceState: 'healthy', lanes: [row('claude'), row('zai')] } as unknown as LaneTargetsV1;

describe('laneYield', () => {
  it('99 finished with 92 empty is low-yield', () => {
    expect(laneYield(jobs('zai', 99, 92), 'zai')).toEqual({ jobs: 99, empty: 92, merged: 3, empty_rate: 0.929, merged_per_job: 0.03, verdict: 'low-yield' });
  });
  it('5 jobs is unknown, even when all are empty', () => {
    expect(laneYield(jobs('zai', 5, 5), 'zai')).toMatchObject({ jobs: 5, verdict: 'unknown' });
  });
  it('a busy lane that merges is productive; 10 to 19 jobs never reach low-yield', () => {
    expect(laneYield(jobs('claude', 100, 10), 'claude').verdict).toBe('productive');
    expect(laneYield(jobs('zai', 19, 19), 'zai').verdict).toBe('productive');
  });
  it('skips malformed rows instead of failing', () => {
    const rows = [null, 7, 'x', [], {}, { lane: 'zai' }, { lane: 'zai', at: 'soon', empty: true }, ...jobs('zai', 20, 20)];
    expect(laneYield(rows, 'zai')).toMatchObject({ verdict: 'low-yield' });
  });
  it('applies the window', () => {
    const rows = [...jobs('zai', 30, 30, 10), ...jobs('zai', 12, 0, 5000)];
    expect(laneYield(rows, 'zai', { since: 1000 }).jobs).toBe(12);
  });
});

describe('parseLaneJobs', () => {
  it('folds ledger rows, skips junk lines and reverted merges', () => {
    const lines = [
      'not json', '[]', JSON.stringify({ event: 'launch', job: 'a', lane: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'finish', job: 'a', empty: true, ts: '2026-11-20T10:05:00Z' }),
      JSON.stringify({ event: 'launch', job: 'b', lane: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'b', state: 'MERGED' }),
      JSON.stringify({ event: 'launch', job: 'c', lane: 'zai', ts: '2026-11-20T10:00:00Z' }),
    ].join('\n');
    const out = parseLaneJobs(lines);
    expect(out.map(j => [j.job, j.empty, j.merged])).toEqual([['a', true, false], ['b', false, true]]);
    expect(laneYieldAll(out, ['claude']).map(l => l.lane)).toEqual(['claude', 'zai']);
  });

  it('folds the jobs-ledger dialect: reconciler merges, alias fields and empty phases count', () => {
    const lines = [
      // Launch via jobId/pool/timestamp; merge arrives only as an eventless
      // metrics-outcomes reconciler row — invisible to the narrow reader.
      JSON.stringify({ type: 'launch', jobId: 'a', pool: 'zai', timestamp: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ jobId: 'a', prUrl: 'https://github.com/o/r/pull/1', outcome: 'MERGED', mergedAt: '2026-11-20T12:00:00Z', source: 'metrics-outcomes-reconciler' }),
      // Launch via job_id/lane/ts; a DONE-NOOP outcome phase is an empty finish.
      JSON.stringify({ event: 'launch', job_id: 'b', lane: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'b', status: 'DONE-NOOP' }),
      // A publish row keeping event:'publish' with resolved MERGED phase counts too.
      JSON.stringify({ kind: 'launch', id: 'c', lane: 'zai', at: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'publish', jobId: 'c', prUrl: 'https://github.com/o/r/pull/3', outcome: 'MERGED', source: 'metrics-outcomes-reconciler' }),
      // Resolved non-merge outcomes still do not count as finished jobs.
      JSON.stringify({ event: 'launch', job: 'd', lane: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'd', state: 'CLOSED' }),
    ].join('\n');
    const out = parseLaneJobs(lines);
    expect(out.map(j => [j.job, j.lane, j.empty, j.merged])).toEqual([
      ['a', 'zai', false, true],
      ['b', 'zai', true, false],
      ['c', 'zai', false, true],
    ]);
    expect(out.find(j => j.job === 'a')!.at).toBe(Date.parse('2026-11-20T12:00:00Z'));
  });

  it('reads arm lanes and phase/result/conclusion outcome spellings', () => {
    const lines = [
      // arm is the lane alias; phase carries a merge verdict.
      JSON.stringify({ kind: 'launch', job: 'a', arm: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'finish', job: 'a', empty: false, ts: '2026-11-20T10:05:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'a', phase: 'MERGED' }),
      // result carries an empty verdict; conclusion resolves closed.
      JSON.stringify({ kind: 'launch', job: 'b', arm: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'b', result: 'DONE-NOOP' }),
      JSON.stringify({ kind: 'launch', job: 'c', arm: 'zai', ts: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'c', conclusion: 'CLOSED' }),
    ].join('\n');
    const out = parseLaneJobs(lines);
    expect(out.map(j => [j.job, j.lane, j.empty, j.merged])).toEqual([
      ['a', 'zai', false, true],
      ['b', 'zai', true, false],
    ]);
  });
});

describe('routing skips low-yield lanes', () => {
  const verdicts = { zai: laneYield(jobs('zai', 99, 92), 'zai'), claude: laneYield(jobs('claude', 5, 5), 'claude') };
  it('remap skips zai with a plain reason', () => {
    const out = routeToEligibleLane({ targets, verdicts, prefer: ['zai'] });
    expect(out.lane).toBe('claude');
    expect(out.skipped).toContainEqual({ lane: 'zai', kind: 'low-yield', reason: 'skipped zai: 92 of 99 recent jobs ended empty' });
    expect(lowYieldReason('zai', verdicts.zai)).toBe('skipped zai: 92 of 99 recent jobs ended empty');
  });
  it('a job that names the lane still gets it', () => {
    expect(routeToEligibleLane({ targets, verdicts, named: 'zai', prefer: ['zai'] }).lane).toBe('zai');
  });
  it('an unknown lane (5 jobs) is not skipped', () => {
    const out = routeToEligibleLane({ targets, verdicts, exclude: ['zai'] });
    expect(out.lane).toBe('claude');
    expect(out.skipped.some(s => s.lane === 'claude')).toBe(false);
  });
});
