import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDoctor, runFleetDoctor, type FleetDoctorOptions } from '../src/cli/fleet-doctor.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const localStamp = (minAgo: number) => {
  const d = new Date(NOW - minAgo * 60_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** All-green fixtures; each test overrides one reader. */
function healthy(over: FleetDoctorOptions = {}): FleetDoctorOptions {
  return {
    now: () => NOW,
    leader: { readEvents: async () => `${localStamp(30)} OPUS-LEADER rc=0\n` },
    heartbeat: { queueStatus: async () => JSON.stringify({ last_tick: at(5) }), supervisorStatuses: async () => [] },
    readJobs: async () => '',
    readKeptStatus: async () => '{"kept_worktrees":[]}',
    readLaneStatus: async () => JSON.stringify({ lanes: {} }),
    worktreeFs: { listDirs: async () => [], mtimeMs: async () => null },
    worktreeRoot: '/fixture/wt',
    ...over,
  };
}
const row = (o: Record<string, unknown>) => JSON.stringify(o);

let out: string[];
beforeEach(() => { out = []; vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('fleet doctor', () => {
  it('prints one ok line per check and exits 0 when healthy', async () => {
    expect(await cmdFleetDoctor([], healthy())).toBe(0);
    expect(out).toHaveLength(8);
    expect(out.every(l => l.startsWith('ok '))).toBe(true);
  });

  it('exits 1 when the queue heartbeat is dead', async () => {
    const heartbeat = { queueStatus: async () => JSON.stringify({ last_tick: at(120) }), supervisorStatuses: async () => [] };
    expect(await cmdFleetDoctor([], healthy({ heartbeat }))).toBe(1);
    expect(out).toContain('red heartbeat: queue tick 120 min old');
  });

  it('exits 1 after three leader failures but only warns after one', async () => {
    const fails = (n: number) => ({ readEvents: async () => Array.from({ length: n }, (_, i) => `${localStamp(60 - i)} OPUS-LEADER rc=1`).join('\n') });
    expect((await runFleetDoctor(healthy({ leader: fails(1) }))).checks[0]).toMatchObject({ level: 'warn' });
    const report = await runFleetDoctor(healthy({ leader: fails(3) }));
    expect(report.checks[0]).toEqual({ name: 'leader', level: 'red', reason: '3 failures in a row' });
    expect(report.level).toBe('red');
  });

  it('warns on stuck PRs and goes red at five', async () => {
    const jobs = (n: number) => Array.from({ length: n }, (_, i) => [
      row({ job: `J${i}`, ts: at(300), url: `https://github.com/a/b/pull/${i + 1}` }),
      row({ job: `J${i}`, ts: at(299), event: 'outcome', outcome: 'OPEN' }),
    ].join('\n')).join('\n');
    expect((await runFleetDoctor(healthy({ readJobs: async () => jobs(2) }))).checks[2]).toMatchObject({ level: 'warn', reason: '2 PRs open over 60 min' });
    expect((await runFleetDoctor(healthy({ readJobs: async () => jobs(5) }))).checks[2].level).toBe('red');
  });

  it('warns when the ledger is unreadable and when waste appears', async () => {
    const report = await runFleetDoctor(healthy({ readJobs: async () => null }));
    expect(report.checks.filter(c => c.level === 'warn').map(c => c.name)).toEqual(['stuck-prs', 'slow-prs', 'waste']);
    expect(report.level).toBe('warn');
    const waste = row({ job: 'J1', ts: at(10), event: 'finish', pool_error: 'quota' });
    const w = await runFleetDoctor(healthy({ readWaste: async () => waste }));
    expect(w.checks[4].name).toBe('waste');
    expect(w.checks[4]).toMatchObject({ level: 'warn', reason: '1 pool errors, 0 empty, 0 without a PR in 6h' });
  });

  it('degrades a throwing reader to warn instead of crashing, and lists stale worktrees (dry run)', async () => {
    const report = await runFleetDoctor(healthy({
      heartbeat: { queueStatus: async () => { throw new Error('boom'); }, supervisorStatuses: async () => [] },
      worktreeFs: { listDirs: async () => ['OLD1'], mtimeMs: async () => NOW - 100 * 3_600_000 },
    }));
    expect(report.checks[1].level).toBe('red'); // a missing queue status is a dead tick
    expect(report.checks[6]).toMatchObject({ level: 'warn', reason: expect.stringContaining('1 stale worktree') });
  });

  it('--json prints the typed report', async () => {
    expect(await cmdFleetDoctor(['--json'], healthy())).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({ v: 1, level: 'ok' });
    expect(parsed.checks.map((c: { name: string }) => c.name)).toEqual(['leader', 'heartbeat', 'stuck-prs', 'slow-prs', 'waste', 'kept', 'worktrees', 'lanes']);
  });

  it('rejects bad usage with 2 and prints help with 0', async () => {
    expect(await cmdFleetDoctor(['--nope'])).toBe(2);
    expect(await cmdFleetDoctor(['--json', '--json'])).toBe(2);
    expect(await cmdFleetDoctor(['--help'])).toBe(0);
  });
});
