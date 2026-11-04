import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDoctor, runFleetDoctor, type FleetDoctorOptions } from '../src/cli/fleet-doctor.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
function fixtures(readLaneStatus: () => Promise<string>): FleetDoctorOptions {
  return {
    now: () => NOW,
    leader: { readEvents: async () => '', now: NOW },
    heartbeat: { queueStatus: async () => JSON.stringify({ last_tick: new Date(NOW).toISOString() }), supervisorStatuses: async () => [] },
    readJobs: async () => '',
    worktreeFs: { listDirs: async () => [], mtimeMs: async () => null },
    worktreeRoot: '/fixture/wt',
    readLaneStatus,
  };
}
const status = (held: boolean, queued: number) => async () => JSON.stringify({ lanes: { devin: { held, running: 5, target: 8, queued } } });
afterEach(() => vi.restoreAllMocks());

describe('fleet doctor lanes', () => {
  it('reports ok with no queued work', async () => {
    const report = await runFleetDoctor(fixtures(status(false, 0)));
    expect(report.checks.at(-1)).toEqual({ name: 'lanes', level: 'ok', reason: 'no queued work waiting' });
  });

  it('goes red and exits 1 when queued work has room to run', async () => {
    const opts = fixtures(status(false, 11));
    const report = await runFleetDoctor(opts);
    expect(report.checks.at(-1)).toEqual({ name: 'lanes', level: 'red', reason: 'room and queued work: devin 5/8 running, 11 queued' });
    expect(report.level).toBe('red');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetDoctor([], opts)).toBe(1);
    expect(log).toHaveBeenCalledWith('red lanes: room and queued work: devin 5/8 running, 11 queued');
  });

  it('warns for held-only queued work', async () => {
    const report = await runFleetDoctor(fixtures(status(true, 3)));
    expect(report.checks.at(-1)).toEqual({ name: 'lanes', level: 'warn', reason: 'held with queued work: devin (3)' });
    expect(report.level).toBe('warn');
  });

  it.each([
    ['invalid JSON', async () => '{'],
    ['invalid shape', async () => '{"lanes":[]}'],
    ['rejecting reader', async () => { throw new Error('unreadable'); }],
  ] as const)('warns without crashing on %s', async (_name, read) => {
    const report = await runFleetDoctor(fixtures(read));
    expect(report.checks.at(-1)).toMatchObject({ name: 'lanes', level: 'warn', reason: expect.stringContaining('could not read (') });
    expect(report.level).toBe('warn');
  });
});
