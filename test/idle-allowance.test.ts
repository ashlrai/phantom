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
    const io = { out: vi.fn(), err: vi.fn() };
    expect(cmdMetrics(['idle', '--status', status, '--jobs', jobsFile, '--json'], io)).toBe(0);
    expect(JSON.parse(String(io.out.mock.calls[0]![0])).stuckJobs).toHaveLength(1);
    expect(cmdMetrics(['idle', '--status', 'missing', '--jobs', jobsFile], io)).toBe(1);
    expect(cmdMetrics(['idle', '--status'], io)).toBe(2);
  });
  it('integrates idle into the existing metrics command without replacing its subcommands', () => {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(cmdMetrics(['idle', '--status', status, '--jobs', jobsFile, '--json'], io)).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0]![0] as string).lanes[0].idleSlotMinutes).toBe(30);
    expect(cmdMetrics(['idle', '--status', status, '--jobs', jobsFile, '--jobs', jobsFile], io)).toBe(2);
    expect(cmdMetrics(['idle', '--status', status, '--jobs', jobsFile, '--unknown'], io)).toBe(2);
    expect(cmdMetrics(['--help'], io)).toBe(0);
    expect(io.out).toHaveBeenLastCalledWith(expect.stringContaining('summary|dashboard'));
    expect(io.out).toHaveBeenLastCalledWith(expect.stringContaining('idle --status'));
  });
});
