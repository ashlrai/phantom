import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { computeIdleAllowance, type IdleJob, type IdleSnapshot } from '../src/core/metrics/idle-allowance.js';
import { cmdMetrics } from '../src/cli/metrics.js';

const status = 'test/fixtures/idle/status.json';
const jobsFile = 'test/fixtures/idle/jobs.jsonl';
const snapshots = JSON.parse(readFileSync(status, 'utf8')) as IdleSnapshot[];
const jobs = readFileSync(jobsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as IdleJob);

describe('idle allowance', () => {
  it('integrates deficits, accounts for pauses and detects strictly over twice the lane median', () => {
    const report = computeIdleAllowance([...snapshots].reverse(), jobs);
    expect(report.lanes).toEqual([
      { lane: 'fast', idleSlotMinutes: 30, pausedSlotMinutes: 20, pausedReasons: { quota: 20 } },
      { lane: 'slow', idleSlotMinutes: 10, pausedSlotMinutes: 0, pausedReasons: {} },
    ]);
    expect(report.medianWallMinutesByLane).toEqual({ fast: 10 });
    expect(report.stuckJobs).toEqual([{ id: 'long', lane: 'fast', elapsedMinutes: 21, medianWallMinutes: 10 }]);
  });
  it('rejects duplicate observations and invalid capacities', () => {
    expect(() => computeIdleAllowance([snapshots[0]!, snapshots[0]!], [])).toThrow();
    expect(() => computeIdleAllowance([{ ...snapshots[0]!, lanes: [{ lane: 'fast', target: -1, running: 0 }] }, snapshots[1]!], [])).toThrow();
    expect(() => computeIdleAllowance([snapshots[0]!], [])).toThrow();
  });
  it('exposes JSON through the command and fails closed on malformed input', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(cmdMetrics(['idle', '--status', status, '--jobs', jobsFile, '--json'])).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]![0])).stuckJobs).toHaveLength(1);
      expect(cmdMetrics(['idle', '--status', 'missing', '--jobs', jobsFile])).toBe(1);
      expect(cmdMetrics(['idle', '--status'])).toBe(2);
    } finally { out.mockRestore(); err.mockRestore(); }
  });
});
