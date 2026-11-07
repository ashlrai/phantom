import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaunchStall } from '../src/cli/fleet-launch-stall.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

describe('fleet launch-stall', () => {
  let dir: string;
  const tick = (time: string, q: number, launched: number, reap: number) => `2026-11-03 ${time} tick run={"work": 1, "fast": 2} q=${q} launched=${launched} reap=${reap} pause=False wall=1s`;
  const write = (...lines: string[]) => writeFileSync(join(dir, 'dispatchd.log'), lines.join('\n'));
  const report = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-stall-'));
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  it('reports the current run and its last queue and reap counts', async () => {
    write(tick('10:00:00', 4, 0, 0), tick('10:31:00', 3, 1, 0), tick('11:00:00', 7, 0, 1), 'other log message', tick('11:31:00', 8, 0, 2));
    expect(await cmdFleetLaunchStall(['--json'])).toBe(1);
    expect(report()).toMatchObject({ minutes: 31, lastQ: 8, lastReap: 2, min: 30, stalled: true });
    expect(report().startTime).toContain('2026-11-03T11:00:00');
  });
  it('uses a strict threshold and supports a custom limit', async () => {
    write(tick('11:00:00', 1, 0, 0), tick('11:30:00', 2, 0, 3));
    expect(await cmdFleetLaunchStall(['--json'])).toBe(0);
    expect(report().minutes).toBe(30);
    expect(await cmdFleetLaunchStall(['--min', '29.5', '--json'])).toBe(1);
    expect(report().min).toBe(29.5);
  });
  it.each([tick('11:40:00', 0, 0, 0), tick('11:40:00', 1, 1, 0), '2026-11-03 11:40:00 tick run={bad} q=? launched=0 reap=0'])('breaks the run on %s', async line => {
    write(tick('11:00:00', 1, 0, 0), tick('11:35:00', 1, 0, 0), line);
    expect(await cmdFleetLaunchStall(['--json'])).toBe(0);
    expect(report()).toMatchObject({ startTime: null, minutes: null, lastQ: null, lastReap: null });
  });
  it('starts a new run after a reversed timestamp', async () => {
    write(tick('11:30:00', 1, 0, 0), tick('11:00:00', 2, 0, 1));
    expect(await cmdFleetLaunchStall(['--json'])).toBe(0);
    expect(report()).toMatchObject({ minutes: 0, lastQ: 2 });
  });
  it('handles missing logs and invalid arguments', async () => {
    expect(await cmdFleetLaunchStall([])).toBe(2);
    for (const args of [['--min'], ['--min', '-1'], ['--min', 'NaN'], ['--json', '--json'], ['--unknown']]) expect(await cmdFleetLaunchStall(args)).toBe(2);
    expect(await cmdFleetLaunchStall(['--help'])).toBe(0);
  });
  it('prints a human-readable report and registers the command', async () => {
    write(tick('11:00:00', 2, 0, 1));
    expect(await cmdFleetLaunchStall([])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('queued: 2; reaped: 1'));
    expect((await FLEET_SUBCOMMAND_LOADERS['launch-stall']!()).cmdFleetLaunchStall).toBe(cmdFleetLaunchStall);
  });
});
