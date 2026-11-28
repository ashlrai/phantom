import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectFleetMachine, readFleetMachine } from '../src/core/fleet/machine.js';

describe('fleet machine projection', () => {
  it('projects a normal dispatcher snapshot', () => {
    expect(projectFleetMachine({ admission: { load1: 18, ncpu: 18, swap_gb: 2, worktrees: 3, running: 4 }, autopilot: { disk: { free_gb: 100 } } })).toEqual({
      schema: 'fleet.machine.v1', load1: 18, cpus: 18, loadPerCpu: 1, overloaded: false, swapGb: 2, diskFreeGb: 100, worktrees: 3, runningWorkers: 4,
    });
  });
  it('warns only above four times CPU count', () => {
    expect(projectFleetMachine({ admission: { load1: 204, ncpu: 18 } }).overloaded).toBe(true);
    expect(projectFleetMachine({ admission: { load1: 72, ncpu: 18 } }).overloaded).toBe(false);
  });
  it('keeps missing and invalid data unknown', async () => {
    expect(await readFleetMachine('/nonexistent/fleet-machine-status.json')).toEqual(projectFleetMachine(null));
    expect(projectFleetMachine({ admission: { load1: -1, ncpu: 0, running: 1.5 } })).toEqual(projectFleetMachine(null));
  });

  it('reports only current machine measurements from the dispatcher file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-machine-'));
    const path = join(dir, 'status.json');
    const now = Date.parse('2026-11-26T17:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const tick = new Date(now - 60_000).toISOString();
    const snapshot = { last_tick: tick, admission: { ts: tick, load1: 90, ncpu: 18, running: 4 }, swap_gb: 2 };
    try {
      await writeFile(path, JSON.stringify(snapshot));
      expect(await readFleetMachine(path)).toEqual(projectFleetMachine(snapshot));

      const legacy = { ...snapshot, admission: { load1: 90, ncpu: 18, running: 4 } };
      await writeFile(path, JSON.stringify(legacy));
      expect(await readFleetMachine(path)).toEqual(projectFleetMachine(legacy));

      for (const stale of [
        { ...legacy, last_tick: new Date(now - 60_001).toISOString() },
        { ...legacy, last_tick: new Date(now + 1).toISOString() },
        { ...legacy, last_tick: 'invalid' },
        { ...legacy, last_tick: undefined },
        { ...snapshot, last_tick: new Date(now).toISOString() },
      ]) {
        await writeFile(path, JSON.stringify(stale));
        expect(await readFleetMachine(path)).toEqual(projectFleetMachine(null));
      }
    } finally {
      clock.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
