import { describe, expect, it } from 'vitest';
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
});
