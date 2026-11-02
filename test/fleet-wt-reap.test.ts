import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetWtReap, readFleetWtReap, type WtReapDeps } from '../src/cli/fleet-wt-reap.js';
const now = Date.parse('2026-11-02T12:00:00Z');
const finish = (job: string, hours: number, empty = false) => ({ event: 'finish', job, empty, ts: new Date(now - hours * 3_600_000).toISOString() });
const outcome = (job: string, state: string) => ({ event: 'outcome', job, state });
const deps = (rows: unknown[], dirs = ['A', 'B', 'C', 'D']): WtReapDeps => ({ now, runsRoot: '/runs', readers: {
  listDirs: async path => { expect(path).toBe('/runs/wt'); return dirs; },
  readJobs: async path => { expect(path).toBe('/runs/metrics/jobs.jsonl'); return rows.map(r => JSON.stringify(r)).join('\n') + '\nbroken\nnull\n[]'; },
} });

describe('fleet wt-reap', () => {
  it('joins the last outcome and finish per job and totals all states', async () => {
    const r = await readFleetWtReap(deps([
      outcome('A', 'OPEN'), outcome('A', 'MERGED'), finish('A', 5), finish('A', 2),
      finish('B', 3, true), finish('C', 4, true), outcome('C', 'OPEN'),
    ]));
    expect(r.worktrees).toEqual([
      { id: 'A', ageHours: 2, state: 'merged', reapable: true },
      { id: 'B', ageHours: 3, state: 'empty', reapable: true },
      { id: 'C', ageHours: 4, state: 'open', reapable: false },
      { id: 'D', ageHours: null, state: 'none', reapable: false },
    ]);
    expect(r.totals).toEqual({ worktrees: 4, merged: 1, empty: 1, open: 1, none: 1, reapable: 2 });
  });
  it('protects exact boundary, recent, future, invalid and missing finish times', async () => {
    const r = await readFleetWtReap(deps([
      finish('A', 1, true), finish('B', -1, true), outcome('C', 'MERGED'),
      { ...finish('D', 3, true), ts: 'invalid' }, finish('E', 0.5, true),
      finish('F', 2, true), finish('F', 2, false), outcome('G', 'MERGED'), outcome('G', 'CLOSED'),
    ], ['A', 'B', 'C', 'D', 'E', 'F', 'G']));
    expect(r.worktrees.every(w => !w.reapable)).toBe(true);
    expect(r.worktrees.at(-1)?.state).toBe('none');
  });
  it('reports unread sources and rejects invalid CLI options', async () => {
    const logs: string[] = [];
    const d = { readers: { listDirs: async () => { throw Error('private'); }, readJobs: async () => { throw Error('private'); } }, output: { log: (s: string) => logs.push(s), error: (s: string) => logs.push(s) } };
    expect(await cmdFleetWtReap(['--json'], d)).toBe(1);
    expect(JSON.parse(logs[0]!).sources).toEqual({ worktrees: false, jobs: false });
    for (const args of [['--apply'], ['--json', '--json']]) expect(await cmdFleetWtReap(args, d)).toBe(2);
    expect(await cmdFleetWtReap(['--help'], d)).toBe(0);
    expect(logs.join('\n')).not.toContain('private');
  });
  it('reads real directories, ignores files and symlinks, and leaves everything intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wt-reap-'));
    try {
      await mkdir(join(root, 'wt', 'A'), { recursive: true });
      await mkdir(join(root, 'metrics'));
      await writeFile(join(root, 'wt', 'file'), 'keep');
      await symlink(join(root, 'wt', 'A'), join(root, 'wt', 'link'));
      await writeFile(join(root, 'metrics', 'jobs.jsonl'), JSON.stringify(finish('A', 2, true)));
      const logs: string[] = [];
      const d = { runsRoot: root, now, output: { log: (s: string) => logs.push(s), error: () => {} } };
      expect(await cmdFleetWtReap(['--json'], d)).toBe(0);
      expect(JSON.parse(logs.pop()!).worktrees).toEqual([{ id: 'A', ageHours: 2, state: 'empty', reapable: true }]);
      expect(await cmdFleetWtReap([], d)).toBe(0);
      expect(logs.at(-1)).toContain('Totals: 1 worktrees');
      expect(await readdir(join(root, 'wt'))).toEqual(['A', 'file', 'link']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
