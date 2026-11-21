import { describe, expect, it, vi } from 'vitest';
import { cmdLocal } from '../src/cli/local-capacity.js';
import { clampLocalTarget, computeLocalCapacity, readLocalCapacity } from '../src/core/fleet/local-capacity.js';
import { autopilotLanes, type FleetAutopilotState } from '../src/core/fleet/autopilot.js';

const GIB = 1024 ** 3;

describe('local capacity', () => {
  it('has room for several workers when memory is plentiful', () => {
    const r = computeLocalCapacity({ freeGb: 41, ceiling: 8, now: 0 });
    expect(r).toMatchObject({ schema: 'local.capacity.v1', workers: 4, fitsByMemory: 4, perWorkerGb: 6, perWorkerSource: 'default', spareGb: 17 });
    expect(r.summary).toBe('Room for 4 local workers (41 GB free, about 6 GB each, keeping 17 GB spare)');
  });

  it('has no room when memory is tight', () => {
    const r = computeLocalCapacity({ freeGb: 7, ceiling: 8 });
    expect(r.workers).toBe(0);
    expect(r.summary).toBe('No room for a local worker right now (7 GB free, about 6 GB each, keeping 30% spare)');
  });

  it('uses the configured default when samples are missing or too few', () => {
    expect(computeLocalCapacity({ freeGb: 40, defaultWorkerGb: 10, samplesGb: [3, 4] })).toMatchObject({ perWorkerGb: 10, perWorkerSource: 'default', sampleCount: 2, workers: 2 });
    expect(computeLocalCapacity({ freeGb: 40 }).perWorkerGb).toBe(6);
  });

  it('uses the median of recent samples, never under 1 GB each, ignoring junk', () => {
    const r = computeLocalCapacity({ freeGb: 40, samplesGb: [2, 8, 4, Number.NaN, -1, 0] });
    expect(r).toMatchObject({ perWorkerGb: 4, perWorkerSource: 'samples', sampleCount: 3, workers: 7 });
    expect(computeLocalCapacity({ freeGb: 40, samplesGb: [0.1, 0.2, 0.3] }).perWorkerGb).toBe(1);
  });

  it('clamps to the lane ceiling and says so', () => {
    const r = computeLocalCapacity({ freeGb: 100, ceiling: 2 });
    expect(r).toMatchObject({ workers: 2, fitsByMemory: 11, ceiling: 2 });
    expect(r.summary).toBe('Room for 2 local workers (100 GB free, about 6 GB each, keeping 88 GB spare; lane ceiling is 2)');
    expect(computeLocalCapacity({ freeGb: 100, ceiling: 0 }).workers).toBe(0);
  });

  it('says one worker in the singular and unknown memory as unknown', () => {
    expect(computeLocalCapacity({ freeGb: 10 }).summary).toMatch(/^Room for 1 local worker \(/);
    const r = computeLocalCapacity({ freeGb: null });
    expect(r.workers).toBeNull();
    expect(r.summary).toMatch(/unknown/);
  });

  it('leaves a lane target alone when the room is unknown, else holds it to the room', () => {
    expect(clampLocalTarget(7, { workers: null })).toBe(7);
    expect(clampLocalTarget(7, { workers: 3 })).toBe(3);
    expect(clampLocalTarget(2, { workers: 3 })).toBe(2);
    expect(clampLocalTarget(null, { workers: 3 })).toBeNull();
  });

  it('reads free memory from vm_stat and the ceiling from the lane row', async () => {
    const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages speculative:                        1000.\n`;
    // 2000 pages * 16 KiB = 31.25 MiB of 64 MiB total = about 48.8% free.
    const r = await readLocalCapacity({ vmStat: async () => vmStat, totalBytes: 64 * 1024 * 1024, samplesGb: async () => [], ceiling: async () => 5, defaultWorkerGb: async () => 0.01 });
    expect(r.freeGb).toBe(0);
    const big = await readLocalCapacity({ vmStat: async () => vmStat, totalBytes: 64 * GIB, samplesGb: async () => [], ceiling: async () => 1, defaultWorkerGb: async () => 2 });
    expect(big.ceiling).toBe(1);
    expect(big.workers).toBe(0);
    const none = await readLocalCapacity({ vmStat: async () => null, samplesGb: async () => [], ceiling: async () => null, defaultWorkerGb: async () => undefined });
    expect(none.workers).toBeNull();
  });

  it('prints the sentence or schema JSON and rejects bad usage', async () => {
    const report = computeLocalCapacity({ freeGb: 41, ceiling: 8, now: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await cmdLocal(['capacity'], { read: async () => report })).toBe(0);
      expect(log).toHaveBeenLastCalledWith(report.summary);
      expect(await cmdLocal(['capacity', '--json'], { read: async () => report })).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string).schema).toBe('local.capacity.v1');
      expect(await cmdLocal([])).toBe(2);
      expect(await cmdLocal(['capacity', '--bogus'])).toBe(2);
      expect(await cmdLocal(['--help'])).toBe(0);
    } finally { log.mockRestore(); err.mockRestore(); }
  });

  it('makes the room the local lane ceiling for the planner', () => {
    const state = (localWorkers: number | null): FleetAutopilotState => ({
      generatedAt: '2026-01-01T00:00:00.000Z', sources: { status: 'missing', queue: 'missing', slots: 'healthy', rebase: 'unconfigured' },
      admission: null, queue: null, rebase: null, localWorkers,
      slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [
        { lane: 'codex-local', target: 7, floor: 0, ceiling: 8, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null },
        { lane: 'claude', target: 3, floor: 0, ceiling: 8, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null }] },
    });
    const target = (s: FleetAutopilotState, lane: string) => autopilotLanes(s).find(l => l.lane === lane)?.target;
    expect(target(state(2), 'codex-local')).toBe(2);
    expect(target(state(2), 'claude')).toBe(3);
    expect(target(state(null), 'codex-local')).toBe(7);
  });
});
