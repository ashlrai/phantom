import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDoctor, runFleetDoctor, type FleetDoctorOptions, type FleetDoctorReport } from '../src/cli/fleet-doctor.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const localStamp = (minAgo: number) => {
  const d = new Date(NOW - minAgo * 60_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const row = (o: Record<string, unknown>) => JSON.stringify(o);

/** All-green fixtures; each test overrides the slow-prs or kept reader. */
function healthy(over: FleetDoctorOptions = {}): FleetDoctorOptions {
  return {
    now: () => NOW,
    leader: { readEvents: async () => `${localStamp(30)} OPUS-LEADER rc=0\n` },
    heartbeat: { queueStatus: async () => JSON.stringify({ last_tick: at(5) }), supervisorStatuses: async () => [] },
    readJobs: async () => '',
    readKeptStatus: async () => keptStatus(0),
    readLaneStatus: async () => JSON.stringify({ lanes: {} }),
    worktreeFs: { listDirs: async () => [], mtimeMs: async () => null },
    worktreeRoot: '/fixture/wt',
    ...over,
  };
}

/** A ledger whose newest row is `at(0)`: every PR opened at `at(45)` is 45 min old, so slow. */
const slowJobs = (n: number) => [
  ...Array.from({ length: n }, (_, i) => row({ job: `J${i}`, class: 'pr', ts: at(45), url: `https://github.com/a/b/pull/${i + 1}` })),
  row({ job: 'J0', event: 'tick', ts: at(0) }),
].join('\n');

const keptStatus = (n: number) => JSON.stringify({ kept_worktrees: Array.from({ length: n }, (_, i) => `J${i}`) });
const named = (report: FleetDoctorReport, name: string) => report.checks.find(c => c.name === name)!;

let out: string[];
beforeEach(() => { out = []; vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('fleet doctor slow-prs', () => {
  it('is ok with no slow PR', async () => {
    const report = await runFleetDoctor(healthy());
    expect(named(report, 'slow-prs')).toEqual({ name: 'slow-prs', level: 'ok', reason: 'no PR open over 30 min' });
    expect(report.level).toBe('ok');
  });

  it('warns at one slow PR', async () => {
    const report = await runFleetDoctor(healthy({ readJobs: async () => slowJobs(1) }));
    expect(named(report, 'slow-prs')).toEqual({ name: 'slow-prs', level: 'warn', reason: '1 PR open over 30 min (see fleet slow-prs)' });
    expect(report.level).toBe('warn');
  });

  it('stays warn below five and goes red at five, exiting 1', async () => {
    expect(named(await runFleetDoctor(healthy({ readJobs: async () => slowJobs(4) })), 'slow-prs').level).toBe('warn');
    const report = await runFleetDoctor(healthy({ readJobs: async () => slowJobs(5) }));
    expect(named(report, 'slow-prs')).toEqual({ name: 'slow-prs', level: 'red', reason: '5 PRs open over 30 min (see fleet slow-prs)' });
    expect(report.level).toBe('red');
    expect(await cmdFleetDoctor([], healthy({ readJobs: async () => slowJobs(5) }))).toBe(1);
    expect(out).toContain('red slow-prs: 5 PRs open over 30 min (see fleet slow-prs)');
  });

  it('warns when the jobs ledger is unreadable', async () => {
    expect(named(await runFleetDoctor(healthy({ readJobs: async () => null })), 'slow-prs'))
      .toEqual({ name: 'slow-prs', level: 'warn', reason: 'jobs ledger unreadable' });
  });
});

describe('fleet doctor kept', () => {
  it.each([[0, 'no kept worktrees'], [1, '1 kept worktree'], [19, '19 kept worktrees']])('is ok at %i kept', async (n, reason) => {
    const report = await runFleetDoctor(healthy({ readKeptStatus: async () => keptStatus(n) }));
    expect(named(report, 'kept')).toEqual({ name: 'kept', level: 'ok', reason });
    expect(report.level).toBe('ok');
  });

  it('warns at twenty kept and stays warn below sixty', async () => {
    const report = await runFleetDoctor(healthy({ readKeptStatus: async () => keptStatus(20) }));
    expect(named(report, 'kept')).toEqual({ name: 'kept', level: 'warn', reason: '20 kept worktrees (see fleet kept)' });
    expect(report.level).toBe('warn');
    expect(named(await runFleetDoctor(healthy({ readKeptStatus: async () => keptStatus(59) })), 'kept').level).toBe('warn');
  });

  it('goes red at sixty kept, exiting 1', async () => {
    const opts = healthy({ readKeptStatus: async () => keptStatus(60) });
    const report = await runFleetDoctor(opts);
    expect(named(report, 'kept')).toEqual({ name: 'kept', level: 'red', reason: '60 kept worktrees (see fleet kept)' });
    expect(report.level).toBe('red');
    expect(await cmdFleetDoctor([], opts)).toBe(1);
    expect(out).toContain('red kept: 60 kept worktrees (see fleet kept)');
  });

  it.each([
    ['invalid json', async () => '{'],
    ['missing list', async () => '{}'],
    ['unsafe id', async () => '{"kept_worktrees":["../x"]}'],
    ['rejecting reader', async () => { throw new Error('boom'); }],
  ] as const)('warns without crashing on %s', async (_name, readKeptStatus) => {
    const report = await runFleetDoctor(healthy({ readKeptStatus }));
    expect(named(report, 'kept').level).toBe('warn');
    expect(report.level).toBe('warn');
  });

  it('keeps its count when the jobs ledger is unreadable', async () => {
    const report = await runFleetDoctor(healthy({ readJobs: async () => null, readKeptStatus: async () => keptStatus(25) }));
    expect(named(report, 'kept')).toEqual({ name: 'kept', level: 'warn', reason: '25 kept worktrees (see fleet kept)' });
  });
});
