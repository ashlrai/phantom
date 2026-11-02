import { describe, expect, it } from 'vitest';
import {
  cmdFleetWorktrees,
  formatFleetWorktrees,
  parseMergedJobs,
  readFleetWorktrees,
  type FleetWorktreesDeps,
} from '../src/cli/fleet-worktrees.js';

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const WT = '/wt';
const HOUR = 3_600_000;
const du = (pairs: Array<[number, string]>): NonNullable<FleetWorktreesDeps['du']> =>
  () => `${pairs.map(([kb, p]) => `${kb}\t${p}`).join('\n')}\n`;
const GB = 1e9 / 1024; // kb per decimal GB
const jobs = (rows: unknown[]): NonNullable<FleetWorktreesDeps['readJobs']> =>
  () => ({ state: 'healthy', text: rows.map(r => JSON.stringify(r)).join('\n') + '\n' });
const base = (extra: FleetWorktreesDeps = {}): FleetWorktreesDeps => ({
  now: NOW,
  wtRoot: WT,
  runsRoot: '/runs',
  mtimeMs: (p) => ({ '/wt/RQ-A': NOW - 5 * HOUR, '/wt/RQ-B': NOW - 30 * HOUR }[p] ?? null),
  du: du([[Math.round(6 * GB), '/wt'], [Math.round(1 * GB), '/wt/RQ-A'], [Math.round(5 * GB), '/wt/RQ-B']]),
  readJobs: jobs([
    { event: 'outcome', job: 'RQ-A', state: 'MERGED' },
    { event: 'outcome', job: 'RQ-B', state: 'CLOSED' },
    { event: 'publish', job: 'RQ-B', state: 'MERGED' },
  ]),
  ...extra,
});

async function run(argv: string[], deps: FleetWorktreesDeps) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetWorktrees(argv, { ...deps, output: { log: s => logs.push(s), error: s => errors.push(s) } });
  return { code, logs, errors };
}

describe('parseMergedJobs', () => {
  it('counts only outcome rows in state MERGED and skips bad rows', () => {
    const set = parseMergedJobs('not json MERGED\n{"event":"outcome","job":"RQ-1","state":"MERGED"}\n{"event":"publish","job":"RQ-2","state":"MERGED"}\n{"event":"outcome","job":"RQ-3","state":"OPEN"}\n');
    expect([...set]).toEqual(['RQ-1']);
  });
});

describe('readFleetWorktrees', () => {
  it('lists biggest first with age, merged flag and total', async () => {
    const r = await readFleetWorktrees(base());
    expect(r.worktrees).toEqual([
      { name: 'RQ-B', gb: 5, ageHours: 30, merged: false },
      { name: 'RQ-A', gb: 1, ageHours: 5, merged: true },
    ]);
    expect(r.totalGb).toBe(6);
  });

  it('prints unknown merged when the jobs file is unread, never false', async () => {
    const r = await readFleetWorktrees(base({ readJobs: () => ({ state: 'missing', text: '' }) }));
    expect(r.worktrees!.map(w => w.merged)).toEqual([null, null]);
    expect(formatFleetWorktrees(r).join('\n')).toContain('merged: unknown');
  });

  it('treats a throwing jobs reader as unread', async () => {
    const r = await readFleetWorktrees(base({ readJobs: () => { throw new Error('boom'); } }));
    expect(r.jobsSource).toBe('degraded');
    expect(r.worktrees!.every(w => w.merged === null)).toBe(true);
  });

  it('prints unknown sizes and total when du fails, never zero', async () => {
    const r = await readFleetWorktrees(base({ du: () => { throw new Error('du'); } }));
    expect(r.worktrees).toBeNull();
    expect(r.totalGb).toBeNull();
    const text = formatFleetWorktrees(r);
    expect(text).toContain('  unknown');
    expect(text.at(-1)).toBe('total: unknown');
  });

  it('keeps every folder, not just ten, and age unknown without a time', async () => {
    const pairs: Array<[number, string]> = Array.from({ length: 15 }, (_, i) => [1000 + i, `/wt/RQ-${i}`]);
    const r = await readFleetWorktrees(base({ du: du(pairs) }));
    expect(r.worktrees).toHaveLength(15);
    expect(r.worktrees![0]!.ageHours).toBeNull();
  });
});

describe('cmdFleetWorktrees', () => {
  it('--json prints one parseable report', async () => {
    const { code, logs } = await run(['--json'], base());
    expect(code).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe('fleet.worktrees.v1');
    expect(report.worktrees[0]).toMatchObject({ name: 'RQ-B', merged: false });
  });

  it('prints plain lines and a total line', async () => {
    const { logs } = await run([], base());
    expect(logs).toEqual([
      'worktrees under /wt:',
      '  RQ-B: 5 GB, 30 hours old, merged: no',
      '  RQ-A: 1 GB, 5 hours old, merged: yes',
      'total: 6 GB',
    ]);
  });

  it('rejects bad arguments and prints help', async () => {
    expect((await run(['--nope'], base())).code).toBe(2);
    expect((await run(['--json', '--json'], base())).code).toBe(2);
    expect((await run(['--wt-dir', 'rel'], base())).code).toBe(2);
    const help = await run(['--help'], base());
    expect(help.code).toBe(0);
    expect(help.logs[0]).toContain('ashlr fleet worktrees');
  });
});
