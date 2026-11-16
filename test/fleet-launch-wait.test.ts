import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetLaunchWait, fleetLaunchWait } from '../src/cli/fleet-launch-wait.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Local-time "now" so HH:MM claim lines are timezone independent.
const now = new Date(2026, 5, 10, 12, 0).getTime();
const at = (h: number, m: number, day = 10) => new Date(2026, 5, day, h, m).toISOString();
const claim = (hhmm: string, id: string) => `- CLAIMED ${hhmm} w lane ${id} (P1, pool=x): t.`;
const launch = (id: string, ts: string) => JSON.stringify({ event: 'launch', job: id, ts });

describe('fleet launch-wait', () => {
  it('is registered', () => expect(FLEET_SUBCOMMAND_LOADERS['launch-wait']).toBeTypeOf('function'));

  it('splits filler from real with median and p90', () => {
    const queue = [claim('10:00', 'RQ-WORK1'), claim('10:00', 'RQ-WORK2'), claim('10:00', 'RQ-FILLQ8'), claim('10:00', 'RQ-FOOA')].join('\n');
    const jobs = [launch('RQ-WORK1', at(10, 10)), launch('RQ-WORK2', at(10, 30)), launch('RQ-FILLQ8', at(10, 5)), launch('RQ-FOOA', at(10, 15))].join('\n');
    const r = fleetLaunchWait(queue, jobs, 6, now);
    expect(r.real).toEqual({ count: 2, median_minutes: 10, p90_minutes: 30 });
    expect(r.filler).toEqual({ count: 2, median_minutes: 5, p90_minutes: 15 });
  });

  it('wraps a claim made before midnight and honors the window', () => {
    const queue = [claim('23:50', 'RQ-LATE'), claim('01:00', 'RQ-OLD')].join('\n');
    const jobs = [launch('RQ-LATE', at(0, 10, 10)), launch('RQ-OLD', at(2, 0, 10))].join('\n');
    const r = fleetLaunchWait(queue, jobs, 12, now);
    expect(r.real.count).toBe(2);
    expect(r.real.median_minutes).toBe(20);
    expect(fleetLaunchWait(queue, jobs, 11, now).real.count).toBe(1);
  });

  it('skips launches without a claim, duplicates and bad rows', () => {
    const jobs = [launch('RQ-NONE', at(10, 5)), launch('RQ-X', at(10, 5)), launch('RQ-X', at(10, 9)), 'not json', '{"event":"finish","job":"RQ-X"}'].join('\n');
    const r = fleetLaunchWait(claim('10:00', 'RQ-X'), jobs, 6, now);
    expect(r.real).toEqual({ count: 1, median_minutes: 5, p90_minutes: 5 });
  });

  it('prints plain and json output from ASHLR_RUNS_DIR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-wait-'));
    try {
      await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
      await writeFile(join(dir, 'queue', 'router-queue.md'), claim('10:00', 'RQ-W') + '\n');
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'), launch('RQ-W', at(10, 12)) + '\n');
      vi.stubEnv('ASHLR_RUNS_DIR', dir);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdFleetLaunchWait([], undefined, now)).toBe(0);
      expect(String(log.mock.calls[0]![0])).toContain('real:   median 12 min, p90 12 min, n=1');
      expect(String(log.mock.calls[0]![0])).toContain('filler: no launches');
      expect(await cmdFleetLaunchWait(['--json', '--hours', '2'], undefined, now)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[1]![0])).real.count).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('exits 2 on bad flags or unreadable input', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetLaunchWait(['--hours', '0'])).toBe(2);
    expect(await cmdFleetLaunchWait(['--bogus'])).toBe(2);
    const bad = async () => { throw new Error('x'); };
    expect(await cmdFleetLaunchWait([], { queue: bad, jobs: bad })).toBe(2);
  });
});
