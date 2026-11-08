import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWorktreeStale, type FleetWorktreeStaleDeps } from '../src/cli/fleet-worktree-stale.js';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const H = 3_600_000;
const ROOT = '/wt';

const row = (job: string, hoursAgo: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ job, ts: new Date(NOW - hoursAgo * H).toISOString(), event: 'launch', ...extra });

function setup(dirs: Record<string, number>, jobs: string[], git = vi.fn(async (argv: string[]) => (argv.includes('rev-parse') ? '/repo/.git\n' : ''))) {
  const deps: FleetWorktreeStaleDeps = {
    now: () => NOW,
    fs: {
      listDirs: async () => Object.keys(dirs),
      mtimeMs: async p => (dirs[p.slice(ROOT.length + 1)] === undefined ? null : NOW - dirs[p.slice(ROOT.length + 1)]! * H),
    },
    readJobs: async () => jobs.join('\n'),
    git,
  };
  return { deps, git };
}

async function run(args: string[], deps: FleetWorktreeStaleDeps) {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => ((out += s), true)) as never);
  const code = await cmdFleetWorktreeStale(['--root', ROOT, '--json', ...args], deps);
  return { code, view: JSON.parse(out) };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet worktree-stale', () => {
  const dirs = { 'RQ-NEW': 1, 'RQ-OLD': 200, 'RQ-MERGED': 5, 'RQ-QUIET': 100, 'guardian-x': 500 };
  const jobs = [row('RQ-MERGED', 6), row('RQ-MERGED', 5, { event: 'outcome', state: 'MERGED' }), row('RQ-QUIET', 90), row('RQ-NEW', 1)];

  it('lists merged and quiet dirs oldest first, skipping live ones', async () => {
    const { deps } = setup(dirs, jobs);
    const { code, view } = await run([], deps);
    expect(code).toBe(0);
    expect(view.stale.map((s: { job: string }) => s.job)).toEqual(['RQ-OLD', 'RQ-QUIET', 'RQ-MERGED']);
    expect(view.stale.map((s: { reason: string }) => s.reason)).toEqual(['no-row', 'no-row', 'merged']);
  });

  it('never lists or removes guardian-* dirs, even when merged', async () => {
    const { deps, git } = setup(dirs, [...jobs, row('guardian-x', 1, { event: 'outcome', state: 'MERGED' })]);
    const { view } = await run(['--apply'], deps);
    expect(JSON.stringify(view)).not.toContain('guardian');
    expect(git.mock.calls.flat(2).join(' ')).not.toContain('guardian');
  });

  it('dry run makes no git call', async () => {
    const { deps, git } = setup(dirs, jobs);
    const { view } = await run([], deps);
    expect(view.apply).toBe(false);
    expect(git).not.toHaveBeenCalled();
  });

  it('--apply removes only MERGED worktrees, without --force', async () => {
    const { deps, git } = setup(dirs, jobs);
    const { code, view } = await run(['--apply'], deps);
    expect(code).toBe(0);
    expect(git).toHaveBeenCalledWith(['-C', '/repo', 'worktree', 'remove', '/wt/RQ-MERGED']);
    expect(git.mock.calls.filter(c => c[0].includes('remove'))).toHaveLength(1);
    expect(git.mock.calls.flat(2)).not.toContain('--force');
    expect(view.stale.find((s: { job: string }) => s.job === 'RQ-MERGED').removed).toBe(true);
  });

  it('reports a failed removal and exits 1', async () => {
    const git = vi.fn(async (argv: string[]) => {
      if (argv.includes('remove')) throw new Error('contains modified files');
      return '/repo/.git\n';
    });
    const { deps } = setup(dirs, jobs, git);
    const { code, view } = await run(['--apply'], deps);
    expect(code).toBe(1);
    expect(view.stale.find((s: { job: string }) => s.job === 'RQ-MERGED').error).toContain('modified');
  });

  it('rejects unknown and duplicate options without reading anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, git } = setup(dirs, jobs);
    expect(await cmdFleetWorktreeStale(['--force'], deps)).toBe(2);
    expect(await cmdFleetWorktreeStale(['--apply', '--apply'], deps)).toBe(2);
    expect(git).not.toHaveBeenCalled();
  });
});

it('removes a URL-linked merged job once and does not reuse an earlier attempt', async () => {
  const { mkdtemp, mkdir, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'stale-convergence-'));
  try {
    const repo = join(root, 'repo');
    const wtRoot = join(root, 'wt');
    const job = 'RQ-LOCUSMCPLEAKQ7';
    await mkdir(repo);
    await mkdir(wtRoot);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', '--detach', join(wtRoot, job));
    const url = 'https://github.com/ashlrai/locus/pull/101';
    const ledger = [row(job, 5), JSON.stringify({ event: 'publish', jobId: job, prUrl: url + '/', outcome: 'PUBLISHED' }),
      JSON.stringify({ event: 'outcome', url, state: 'MERGED' })];
    const deps: FleetWorktreeStaleDeps = { now: () => NOW, readJobs: async () => ledger.join('\n') };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdFleetWorktreeStale(['--root', wtRoot, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).stale[0]).toMatchObject({ job, reason: 'merged', removed: true });
    expect(await readdir(wtRoot)).toEqual([]);
    expect(await cmdFleetWorktreeStale(['--root', wtRoot, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).stale).toEqual([]);
    git('worktree', 'add', '--detach', join(wtRoot, job));
    ledger.push(row(job, 0));
    expect(await cmdFleetWorktreeStale(['--root', wtRoot, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).stale).toEqual([]);
    expect(await readdir(wtRoot)).toEqual([job]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not remove a retry when an older PR merges after the new launch', async () => {
  const oldUrl = 'https://github.com/ashlrai/locus/pull/101';
  const { deps, git } = setup({ 'RQ-RETRY': 1 }, [
    row('RQ-RETRY', 5), row('RQ-RETRY', 4, { event: 'publish', url: oldUrl }),
    row('RQ-RETRY', 2), row('RQ-RETRY', 1, { event: 'publish', url: 'https://github.com/ashlrai/locus/pull/102' }),
    row('RQ-RETRY', 0, { event: 'outcome', url: oldUrl, state: 'MERGED' }),
  ]);
  const { view } = await run(['--apply'], deps);
  expect(view.stale).toEqual([]);
  expect(git).not.toHaveBeenCalled();
});
