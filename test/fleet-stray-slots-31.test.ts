import { describe, expect, it, vi } from 'vitest';
import { cmdFleetStraySlots, readStraySlots, type StrayJob, type StrayProcess, type StrayReaders } from '../src/cli/fleet-stray-slots.js';

const job = (id: string, finished = true, lane = 'devin'): StrayJob => ({ id, lane, finished, worktree: `/wt/${id}` });
const proc = (pid: number, command: string, cwd: string | null = null): StrayProcess => ({ pid, command, cwd, elapsed: '3-00:00:00' });
const readers = (jobs: StrayJob[], processes: StrayProcess[]): StrayReaders => ({
  readJobs: async () => jobs, readProcesses: async () => processes,
});

describe('fleet stray-slots', () => {
  it('names leftover test and esbuild PIDs and counts one lost slot per affected job', async () => {
    const result = await readStraySlots(readers([job('RQ-A'), job('RQ-B')], [
      proc(31, '/wt/RQ-A/target/debug/locus-mcp'), proc(32, 'esbuild --service=0.28', '/wt/RQ-B'),
      proc(33, 'node helper', '/wt/RQ-A/subdir'),
    ]));
    expect(result).toEqual({ lanes: [{ lane: 'devin', slotsLost: 2, strays: [
      { job: 'RQ-A', pid: 31, ageSeconds: 259200 }, { job: 'RQ-A', pid: 33, ageSeconds: 259200 },
      { job: 'RQ-B', pid: 32, ageSeconds: 259200 },
    ] }] });
  });

  it('excludes live jobs and finished jobs that still have a live launch process', async () => {
    const result = await readStraySlots(readers([job('RQ-A', false), job('RQ-B')], [
      proc(31, 'esbuild', '/wt/RQ-A'), proc(32, '/bin/bash /home/u/.ashlr-runs/bin/launch.sh RQ-B phantom devin work'),
      proc(33, 'esbuild', '/wt/RQ-B'),
    ]));
    expect(result.lanes).toEqual([{ lane: 'devin', slotsLost: 0, strays: [] }]);
  });

  it('reports zero for a finished job with no process', async () => {
    expect((await readStraySlots(readers([job('RQ-A')], []))).lanes[0].slotsLost).toBe(0);
  });

  it('requires a path boundary in both cwd and command', async () => {
    expect((await readStraySlots(readers([job('RQ-A')], [
      proc(31, '/wt/RQ-AB/target/debug/locus-mcp'), proc(32, 'esbuild', '/wt/RQ-AB'),
      proc(33, '/other/wt/RQ-A/bin/test'), proc(34, '/wt/RQ-A/../RQ-AB/bin/test'),
      proc(35, 'esbuild', '/wt/RQ-A/../RQ-AB'),
    ]))).lanes[0].strays).toEqual([]);
  });

  it('accepts quoted paths and flag values, deduplicates PIDs, and keeps lanes separate', async () => {
    const result = await readStraySlots(readers([job('RQ-A'), job('RQ-B', true, 'codex-personal')], [
      proc(31, 'node --dir=/wt/RQ-A/src'), proc(31, 'node --dir=/wt/RQ-A/src'),
      { ...proc(32, '"/wt/RQ-B/bin/test"'), elapsed: 'unknown' },
    ]));
    expect(result.lanes.map(l => [l.lane, l.slotsLost, l.strays.length])).toEqual([
      ['codex-personal', 1, 1], ['devin', 1, 1],
    ]);
    expect(result.lanes[0].strays[0].ageSeconds).toBeNull();
  });

  it('prints JSON with injected readers and refuses unknown options before reading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const source = readers([job('RQ-A')], [proc(31, 'esbuild', '/wt/RQ-A')]);
      expect(await cmdFleetStraySlots(['--json'], source)).toBe(0);
      expect(JSON.parse(log.mock.calls[0][0]).lanes[0].slotsLost).toBe(1);
      const readJobs = vi.fn(source.readJobs);
      expect(await cmdFleetStraySlots(['--kill'], { ...source, readJobs })).toBe(2);
      expect(readJobs).not.toHaveBeenCalled();
      expect(await cmdFleetStraySlots(['--json'], { ...source, readJobs: async () => { throw new Error('private source'); } })).toBe(1);
      expect(stderr.mock.calls.flat().join('')).not.toContain('private source');
    } finally { log.mockRestore(); stderr.mockRestore(); }
  });
});
