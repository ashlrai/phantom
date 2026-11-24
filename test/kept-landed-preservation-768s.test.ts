import { expect, it, vi } from 'vitest';
import { readKeptLanded } from '../src/core/fleet/kept-landed.js';
import { cmdFleetKeptLanded } from '../src/cli/fleet-kept-landed.js';
import type { WtAuditFs } from '../src/core/fleet/wt-audit.js';

const hash = 'a'.repeat(40);
const now = 1_000_000_000;
function fixtures(names: string[]) {
  const fs: WtAuditFs = {
    dirs: async () => names, entries: async () => [], real: async () => null,
    text: async p => p.includes('badbase') ? 'invalid' : hash,
    mtime: async p => p.endsWith('.base') ? null : p.includes('new') ? now : now - 100 * 3_600_000,
  };
  const git = (dir: string, args: string[], input?: string): string => {
    if (dir.endsWith('broken')) throw new Error('git failure');
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') return hash;
    if (args.includes('--numstat')) return '1\t1\ta\0';
    if (args.includes('--name-only')) {
      if (args.includes('origin/master')) return '';
      const masterComparison = args.includes(hash) && args.at(-2) === hash && args.includes('-z');
      // The base and master IDs are equal in this fixture; distinguish by call sequence below.
      void masterComparison;
      return 'a\0b\0';
    }
    if (args[0] === 'patch-id') return input === 'patch' && dir.endsWith('patch') ? 'id 1' : '';
    if (args[0] === 'log') return 'history';
    return 'patch';
  };
  const counts = new Map<string, number>();
  const boundary = (dir: string, args: string[], input?: string) => {
    if (args.includes('--name-only')) {
      const n = (counts.get(dir) ?? 0) + 1; counts.set(dir, n);
      if (n % 2 === 0) return dir.endsWith('yes') ? '' : dir.endsWith('partial') ? 'b\0' : 'a\0b\0';
    }
    if (args[0] === 'patch-id' && input === 'history' && dir.endsWith('patch')) return 'id 2';
    return git(dir, args, input);
  };
  return { fs, git: boundary, measure: () => ({ bytes: 12, complete: false }) };
}

it('reports tracked post-images, patch fallback, failures, ordering and partial size', async () => {
  const deps = fixtures(['no', 'partial', 'yes', 'patch', 'broken', 'badbase', 'new']);
  const report = await readKeptLanded({ ...deps, wtRoot: '/wt', runsRoot: '/runs', now });
  expect(report.worktrees[0]?.job).toBe('new');
  expect(Object.fromEntries(report.worktrees.map(r => [r.job, r.landed]))).toEqual({ new: 'no', no: 'no', partial: 'partial', yes: 'yes', patch: 'yes', broken: 'unknown', badbase: 'unknown' });
  expect(report.summary).toContain('partial size');
  expect(report.worktrees.find(r => r.job === 'yes')).toMatchObject({ filesChanged: 2, linesChanged: 2, sizeComplete: false });
  const filtered = await readKeptLanded({ ...fixtures(['new', 'no']), wtRoot: '/wt', runsRoot: '/runs', now, olderThanHours: 72 });
  expect(filtered.worktrees.map(r => r.job)).toEqual(['no']);
  expect(filtered.skipped).toBe(1);
});

it('bounds the candidate list and reports missing roots and refs', async () => {
  const names = Array.from({ length: 601 }, (_, i) => `job${i}`);
  const report = await readKeptLanded({ ...fixtures(names), wtRoot: '/wt', runsRoot: '/runs', now });
  expect(report.worktrees).toHaveLength(600); expect(report.skipped).toBe(1);
  const deps = fixtures(['x']);
  await expect(readKeptLanded({ ...deps, fs: { ...deps.fs, dirs: async () => null } })).rejects.toThrow();
  const missing = await readKeptLanded({ ...deps, git: () => '', wtRoot: '/wt', runsRoot: '/runs', now });
  expect(missing.worktrees[0]?.landed).toBe('unknown');
});

it('validates flags before reading and renders consistent output', async () => {
  const report = await readKeptLanded({ ...fixtures(['yes']), wtRoot: '/wt', runsRoot: '/runs', now });
  const read = vi.fn(async () => report);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await cmdFleetKeptLanded(['--older-than', '2h', '--older-than', '3h'], read)).toBe(2);
    expect(await cmdFleetKeptLanded(['--json', '--json'], read)).toBe(2);
    expect(await cmdFleetKeptLanded(['--older-than', 'no'], read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(await cmdFleetKeptLanded(['--json'], read)).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual(report);
    expect(await cmdFleetKeptLanded([], read)).toBe(0);
    expect(log.mock.calls[1]![0]).toBe(report.summary);
  } finally { log.mockRestore(); error.mockRestore(); }
});

it('keeps empty tracked changes unknown and retains the global scan deadline', async () => {
  const deps = fixtures(['x']);
  const empty = await readKeptLanded({ ...deps, git: (_dir, args) => args[0] === 'rev-parse' ? hash : '', wtRoot: '/wt', runsRoot: '/runs', now });
  expect(empty.worktrees[0]).toMatchObject({ filesChanged: 0, landed: 'unknown', evidence: 'unknown' });
  expect(empty.limitation).toContain('untracked content is not assessed');
  const bounded = await readKeptLanded({ ...deps, wtRoot: '/wt', runsRoot: '/runs', now, scanBudgetMs: 0 });
  expect(bounded.worktrees).toEqual([]);
  expect(bounded.skipped).toBe(1);
});

it('loads the kept-landed command through the generated fleet registry', async () => {
  const { FLEET_SUBCOMMAND_LOADERS } = await import('../src/cli/fleet-subcommand-registry.js');
  const module = await FLEET_SUBCOMMAND_LOADERS['kept-landed']!();
  expect(module.cmdFleetKeptLanded).toBe(cmdFleetKeptLanded);
});
