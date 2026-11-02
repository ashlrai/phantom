import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStraySlots, type StrayJob, type StrayProcess, type StrayReaders } from '../src/cli/fleet-stray-slots.js';

const job = (id: string, lane: string, finished = true): StrayJob => ({
  id, lane, finished, worktree: `/fake-worktrees/${id}`,
});
const proc = (pid: number, cwd: string | null, command = 'fake-helper'): StrayProcess => ({
  pid, cwd, command, elapsed: '02:00',
});
const jobs = [job('fake-finished', 'devin'), job('fake-active', 'devin', false),
  job('fake-launch', 'devin'), job('fake-other', 'codex')];
const processes = [
  proc(101, '/fake-worktrees/fake-finished'), proc(102, '/fake-worktrees/fake-finished/subdir'),
  proc(103, '/fake-worktrees/fake-active'), proc(104, '/fake-worktrees/fake-launch'),
  proc(105, null, '/fake/bin/launch.sh fake-launch phantom devin work'),
  proc(106, '/fake-worktrees/fake-other'),
];
const readers = (): StrayReaders => ({ readJobs: async () => jobs, readProcesses: async () => processes });
const output = () => ({
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  error: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
});

afterEach(() => vi.restoreAllMocks());

describe('fleet stray-slots check', () => {
  it('fails for a selected lane with one lost slot per job and excludes active workers', async () => {
    const { log } = output();
    expect(await cmdFleetStraySlots(['--check', '--lane', 'devin', '--json'], readers())).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      lanes: [{ lane: 'devin', slotsLost: 1, strays: [
        { job: 'fake-finished', pid: 101, ageSeconds: 120 },
        { job: 'fake-finished', pid: 102, ageSeconds: 120 },
      ] }],
      summary: { slotsLost: 1, selectedLanes: ['devin'], passed: false },
    });
  });

  it('unions and deterministically deduplicates exact lane selections', async () => {
    const { log } = output();
    expect(await cmdFleetStraySlots(['--lane', 'devin', '--lane', 'codex', '--lane', 'devin', '--json', '--check'], readers())).toBe(1);
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.lanes.map((lane: { lane: string }) => lane.lane)).toEqual(['codex', 'devin']);
    expect(report.summary).toEqual({ slotsLost: 2, selectedLanes: ['codex', 'devin'], passed: false });
    expect(report.lanes[1].strays.map((stray: { pid: number }) => stray.pid)).toEqual([101, 102]);
  });

  it('passes when no jobs match and makes the observation limit explicit', async () => {
    const { log } = output();
    expect(await cmdFleetStraySlots(['--lane', 'DevIn', '--check', '--json'], readers())).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      lanes: [], summary: { slotsLost: 0, selectedLanes: ['DevIn'], passed: true },
    });
    expect(await cmdFleetStraySlots(['--lane', 'missing', '--check'], readers())).toBe(0);
    expect(log.mock.calls[1][0]).toContain('Observed 0 lost slot(s): PASS');
    expect(log.mock.calls[1][0]).toContain('not proof a provider is available');
  });

  it('explains the count and the job and PID evidence in text check mode', async () => {
    const { log } = output();
    expect(await cmdFleetStraySlots(['--check', '--lane', 'devin'], readers())).toBe(1);
    expect(log.mock.calls[0][0]).toContain('devin: 1 slots lost');
    expect(log.mock.calls[0][0]).toContain('fake-finished pid=101');
    expect(log.mock.calls[0][0]).toContain('fake-finished pid=102');
    expect(log.mock.calls[0][0]).toContain('Observed 1 lost slot(s): FAIL');
    expect(log.mock.calls[0][0]).not.toContain('fake-active');
    expect(log.mock.calls[0][0]).not.toContain('fake-launch');
  });

  it('keeps default JSON and text output and successful exits unchanged', async () => {
    const { log } = output();
    expect(await cmdFleetStraySlots(['--json'], readers())).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ lanes: [
      { lane: 'codex', slotsLost: 1, strays: [{ job: 'fake-other', pid: 106, ageSeconds: 120 }] },
      { lane: 'devin', slotsLost: 1, strays: [
        { job: 'fake-finished', pid: 101, ageSeconds: 120 },
        { job: 'fake-finished', pid: 102, ageSeconds: 120 },
      ] },
    ] });
    expect(await cmdFleetStraySlots([], readers())).toBe(0);
    expect(log.mock.calls[1][0]).toBe('codex: 1 slots lost\n  fake-other pid=106 age=120s\ndevin: 1 slots lost\n  fake-finished pid=101 age=120s\n  fake-finished pid=102 age=120s');
    expect(await cmdFleetStraySlots(['--lane', 'devin', '--json'], readers())).toBe(0);
    expect(JSON.parse(log.mock.calls[2][0])).toEqual({ lanes: [JSON.parse(log.mock.calls[0][0]).lanes[1]] });
  });

  it('fails closed on either reader failure without exposing its error', async () => {
    const { log, error } = output();
    for (const key of ['readJobs', 'readProcesses'] as const) {
      expect(await cmdFleetStraySlots(['--check', '--json'], {
        ...readers(), [key]: async () => { throw new Error('fake private detail'); },
      })).toBe(1);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('')).not.toContain('fake private detail');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid arguments before collecting evidence', async () => {
    const { error } = output();
    const readJobs = vi.fn(readers().readJobs);
    const readProcesses = vi.fn(readers().readProcesses);
    const invalid = [
      ['--json', '--json'], ['--check', '--check'], ['--lane'], ['--lane', '--check'],
      ['--lane', ''], ['--lane', 'bad/lane'], ['--lane', 'x'.repeat(81)],
      ['--help', '--json'], ['--unknown'], ['devin'], ['--lane=devin'],
    ];
    for (const args of invalid) expect(await cmdFleetStraySlots(args, { readJobs, readProcesses })).toBe(2);
    expect(readJobs).not.toHaveBeenCalled();
    expect(readProcesses).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(invalid.length);
  });

  it('describes observation-only behavior in help without reading sources', async () => {
    const { log } = output();
    const readJobs = vi.fn(readers().readJobs);
    const readProcesses = vi.fn(readers().readProcesses);
    expect(await cmdFleetStraySlots(['--help'], { readJobs, readProcesses })).toBe(0);
    expect(log.mock.calls[0][0]).toContain('never sends signals, mutates slot counts, launches work or releases holds');
    expect(log.mock.calls[0][0]).toContain('not proof a provider is available');
    expect(readJobs).not.toHaveBeenCalled();
    expect(readProcesses).not.toHaveBeenCalled();
  });
});
