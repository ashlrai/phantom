import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCompareSnapshot } from '../src/cli/fleet-job-compare-snapshot.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { jobCompare } from '../src/core/fleet/job-compare.js';
import { jobCompareSnapshot } from '../src/core/fleet/job-compare-snapshot.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const SCRUBBED = 'error: unable to replay job compare snapshot from git';
// The only git verbs the replay may invoke; anything else is a mutation or a fetch.
const READ_ONLY = ['cat-file', 'merge-base', 'rev-parse', 'rev-list', 'log', 'diff-tree', 'ls-tree'];

/** Temporary repo with real git; every helper touches only this directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'job-compare-snapshot-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (subject: string, files: Record<string, string>, remove: string[] = []) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    for (const path of remove) git('rm', '-q', path);
    git('add', '.'); git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  const publish = (oid: string) => git('update-ref', 'refs/remotes/origin/master', oid);
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  return { dir, git, write, commit, publish, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Base has gone.txt. Job 1 (#7) deletes it and writes shared.txt 'one',
 * same.txt 'same' and its own file. A plain commit restores gone.txt and
 * changes same.txt so job 2 (#8) must touch it again: it deletes gone.txt,
 * writes shared.txt 'two' and sets same.txt back to the identical blob. At
 * the pinned tip shared.txt is different, same.txt identical, gone.txt
 * both-absent and the per-job files never overlap.
 */
function pairRepo() {
  const repo = fixture();
  repo.commit('plain base', { 'gone.txt': 'bye' });
  const shaA = repo.commit('bridge(RQ-CMP-1): first job secret words (#7)',
    { 'shared.txt': 'one', 'same.txt': 'same', 'only-a.txt': 'a' }, ['gone.txt']);
  repo.commit('plain restore', { 'gone.txt': 'again', 'same.txt': 'other' });
  const shaB = repo.commit('bridge(RQ-CMP-2): second job (#8)',
    { 'shared.txt': 'two', 'same.txt': 'same', 'only-b.txt': 'b' }, ['gone.txt']);
  const snapshot = repo.git('rev-parse', 'HEAD').trim();
  repo.publish(snapshot);
  return { ...repo, shaA, shaB, snapshot };
}

/** Real git through the injected runner seam; records every argv for mutation checks. */
function recordingRunner(dir: string) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  };
  return { calls, run };
}

it('replays the landed comparison identically after origin/master advances while the live comparison moves', async () => {
  const repo = pairRepo();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.chdir(repo.dir);
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.snapshot, 'RQ-CMP-1', 'RQ-CMP-2', '--json'])).toBe(0);
    const first = log.mock.calls.at(-1)![0] as string;
    const replay = JSON.parse(first);
    expect(replay).toMatchObject({
      schemaVersion: 1, requestedSnapshot: repo.snapshot, resolvedRef: repo.snapshot,
      comparable: true, sharedPathsComplete: true, unmatched: [],
      totals: { shared: 3, identical: 1, different: 1, bothAbsent: 1 },
    });
    expect(replay).not.toHaveProperty('ref');
    expect(replay.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-CMP-1', 'RQ-CMP-2']);
    expect(replay.jobs[0].commit.sha).toBe(repo.shaA);
    expect(replay.jobs[1].commit.sha).toBe(repo.shaB);
    expect(replay.entries.map((entry: { path: string }) => entry.path)).toEqual(['gone.txt', 'same.txt', 'shared.txt']);
    expect(replay.entries[0]).toEqual({ path: 'gone.txt', status: 'both-absent', atFirst: null, atSecond: null });
    expect(replay.caveat).toContain('not current live origin/master');
    expect(replay.caveat).toContain('not semantic equivalence');
    expect(JSON.stringify(replay)).not.toContain('secret words');

    // origin/master moves on: a later bridge commit for the same first job rewrites shared.txt.
    const later = repo.commit('bridge(RQ-CMP-1): recut moves shared (#9)', { 'shared.txt': 'one-recut' });
    repo.publish(later);

    // The pinned replay is byte-identical; the live comparison now sees the recut commit.
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.snapshot, 'RQ-CMP-1', 'RQ-CMP-2', '--json'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe(first);
    const live = await jobCompare('RQ-CMP-1', 'RQ-CMP-2');
    expect(live.resolvedRef).toBe(later);
    expect(live.jobs[0]!.commit!.sha).toBe(later);
    // The recut commit touched only shared.txt, so the live shared set shrank to it.
    expect(live.totals).toEqual({ shared: 1, identical: 0, different: 1, bothAbsent: 0 });
    expect(live.entries[0]!.atFirst!.oid).not.toBe(replay.entries[2].atFirst.oid);

    // Text mode names the pinned snapshot and never calls it current master.
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.snapshot, 'RQ-CMP-1', 'RQ-CMP-2'])).toBe(0);
    const text = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(text).toContain(`Replayed snapshot ${repo.snapshot} (pinned; not current origin/master)`);
    expect(text).toContain('different    shared.txt');
    expect(text).toContain('identical    same.txt');
    expect(text).toContain('both-absent  gone.txt');
    expect(text).toContain('Compared 3 shared literal paths: 1 identical, 1 different, 1 both-absent.');
    expect(text).toContain('not semantic equivalence, safety, correctness or merge authority');
    expect(text).not.toContain('secret words');
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('reports an unmatched job honestly at the pinned snapshot, never as identical', async () => {
  const repo = pairRepo();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.chdir(repo.dir);
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.snapshot, 'RQ-CMP-1', 'RQ-NOPE-9', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({
      requestedSnapshot: repo.snapshot, comparable: false, unmatched: ['RQ-NOPE-9'], entries: [],
      totals: { shared: 0, identical: 0, different: 0, bothAbsent: 0 },
    });
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.snapshot, 'RQ-CMP-1', 'RQ-NOPE-9'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('RQ-NOPE-9: unmatched at the pinned snapshot')
      && line.includes('does not prove the job never landed'))).toBe(true);
    expect(lines.some(line => line.includes('Not compared: RQ-NOPE-9 unmatched')
      && line.includes('never reported as identical'))).toBe(true);
    expect(lines.some(line => line.includes('Compared '))).toBe(false);
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('keeps the omitted-path caveat: a bounded list never proves disjointness', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    // RQ-WIDE-1 touches shared.txt plus 200 filler paths: one path over the 200-path bound.
    const wide: Record<string, string> = { 'shared.txt': 'same' };
    for (let i = 0; i < 200; i++) wide[`zz${String(i).padStart(3, '0')}.txt`] = `f${i}`;
    repo.commit('plain base', { 'seed.txt': 's' });
    repo.commit('bridge(RQ-WIDE-1): wide job (#21)', wide);
    // RQ-WIDE-2 edits shared.txt and zz199.txt — the path the first job's bound omitted.
    repo.commit('bridge(RQ-WIDE-2): narrow job (#22)', { 'shared.txt': 'two', 'zz199.txt': 'b' });
    const snapshot = repo.git('rev-parse', 'HEAD').trim();
    repo.publish(snapshot);
    process.chdir(repo.dir);
    expect(await cmdFleetJobCompareSnapshot(['--at', snapshot, 'RQ-WIDE-1', 'RQ-WIDE-2', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ comparable: true, sharedPathsComplete: false, unmatched: [] });
    expect(out.jobs[0]).toMatchObject({ omittedPaths: 1, pathBound: 200, comparedPaths: 200 });
    // zz199.txt is genuinely shared yet absent from the bounded comparison.
    expect(out.entries).toEqual([{ path: 'shared.txt', status: 'different', atFirst: expect.anything(), atSecond: expect.anything() }]);
    expect(out.caveat).toContain('never proves disjointness');
    expect(await cmdFleetJobCompareSnapshot(['--at', snapshot, 'RQ-WIDE-1', 'RQ-WIDE-2'])).toBe(0);
    const text = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(text).toContain('1 more paths beyond the 200-path bound not compared.');
    expect(text).toContain('Shared list is bounded by omitted paths; absence from it does not prove disjointness.');
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('rejects usage errors with exit 2 before any git call, including outside a repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-compare-snapshot-nogit-'));
  const cwd = process.cwd();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const oid = 'a'.repeat(40);
  try {
    // Not a git repository: exit 2 proves rejection happened before any git call (which would exit 1).
    process.chdir(dir);
    for (const args of [
      [] as string[], ['RQ-A'], ['RQ-A', 'RQ-B'], ['--at', oid], ['--at'], ['--at', oid, 'RQ-A'],
      ['--at', oid, 'RQ-A', 'RQ-B', 'RQ-C'], ['--at', 'HEAD', 'RQ-A', 'RQ-B'],
      ['--at', 'origin/master', 'RQ-A', 'RQ-B'], ['--at', 'master', 'RQ-A', 'RQ-B'],
      ['--at', 'HEAD~1', 'RQ-A', 'RQ-B'], ['--at', `${oid}..${oid}`, 'RQ-A', 'RQ-B'],
      ['--at', oid.slice(0, 12), 'RQ-A', 'RQ-B'], ['--at', oid.toUpperCase(), 'RQ-A', 'RQ-B'],
      ['--at', 'refs/heads/main', 'RQ-A', 'RQ-B'], ['--at', '', 'RQ-A', 'RQ-B'],
      ['--at', oid, '--at', oid, 'RQ-A', 'RQ-B'], ['--at', oid, 'rq-a', 'RQ-B'],
      ['--at', oid, 'RQ-A B', 'RQ-C'], ['--at', oid, '../RQ-A', 'RQ-B'], ['--at', oid, 'RQ-A', 'RQ-A'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--json', '--json'], ['--at', oid, 'RQ-A', 'RQ-B', '--status', 'changed'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--limit', '5'], ['--at', oid, 'RQ-A', 'RQ-B', '--fetch'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--ref', 'HEAD'], ['--at', oid, 'RQ-A', 'RQ-B', '--cwd', dir],
      ['--at', oid, 'RQ-A', 'RQ-B', '--stdin'], ['--at', oid, 'RQ-A', 'RQ-B', '--help'],
    ]) {
      expect(await cmdFleetJobCompareSnapshot(args), JSON.stringify(args)).toBe(2);
    }
    // Input-level checks: only a literal snapshot and two distinct valid ids reach the scan.
    const run = vi.fn(async () => '');
    for (const [snap, a, b] of [
      [oid, 'bad id', 'RQ-B'], [oid, 'RQ-A', 'bad id'], [oid, 'RQ-A', 'RQ-A'],
      ['HEAD', 'RQ-A', 'RQ-B'], ['a'.repeat(39), 'RQ-A', 'RQ-B'], ['A'.repeat(40), 'RQ-A', 'RQ-B'],
      [7, 'RQ-A', 'RQ-B'], [oid, 'RQ-A', null],
    ] as unknown[][]) {
      await expect(jobCompareSnapshot(snap as string, a as string, b as string, run))
        .rejects.toThrow('invalid job compare snapshot arguments');
    }
    expect(run).not.toHaveBeenCalled();
    expect(await cmdFleetJobCompareSnapshot(['--help'])).toBe(0);
    const help = String(log.mock.calls.at(-1)![0]);
    expect(help).toContain('Usage: ashlr fleet job-compare-snapshot --at <full-commit-oid> RQ-A RQ-B [--json]');
    expect(help).toContain('ancestor of origin/master');
    expect(await cmdFleetJobCompareSnapshot(['-h'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('"entries"'))).toBe(false);
  } finally { process.chdir(cwd); error.mockRestore(); log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('job-compare-snapshot refuses non-ancestor, missing, blob and tree objects with a scrubbed exit 1 and no evidence', async () => {
  const repo = pairRepo();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // A commit object that exists but is not reachable from origin/master.
    const side = repo.git('commit-tree', `${repo.snapshot}^{tree}`, '-p', repo.shaA, '-m', 'bridge(RQ-SIDE-9): side').trim();
    const tree = repo.git('rev-parse', `${repo.snapshot}^{tree}`).trim();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.dir, input: 'blob', encoding: 'utf8' }).trim();
    process.chdir(repo.dir);
    for (const oid of [side, sha(1), 'f'.repeat(64), tree, blob]) {
      error.mockClear();
      expect(await cmdFleetJobCompareSnapshot(['--at', oid, 'RQ-CMP-1', 'RQ-CMP-2', '--json']), oid).toBe(1);
      expect(error.mock.calls.at(-1)![0]).toBe(SCRUBBED);
    }
    expect(log.mock.calls.some(call => String(call[0]).includes('"entries"'))).toBe(false);
    // The same validated commit replays once it is reachable from origin/master. Pinning the
    // earlier ancestor proves the scan itself is pinned: job 2 had no bridge commit there yet.
    expect(await cmdFleetJobCompareSnapshot(['--at', repo.shaA, 'RQ-CMP-1', 'RQ-CMP-2', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({
      requestedSnapshot: repo.shaA, resolvedRef: repo.shaA, comparable: false, unmatched: ['RQ-CMP-2'],
    });
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); repo.cleanup(); }
});

it('never mutates the repository, issues only allowlisted read-only argv and pins every read', async () => {
  const repo = pairRepo();
  try {
    const state = () => repo.git('for-each-ref', '--format=%(refname) %(objectname)') + repo.git('status', '--porcelain')
      + repo.git('rev-parse', 'HEAD') + repo.git('reflog', 'show', '--all', '--format=%H %gs');
    const before = state();
    const { calls, run } = recordingRunner(repo.dir);
    const result = await jobCompareSnapshot(repo.snapshot, 'RQ-CMP-1', 'RQ-CMP-2', run);
    expect(result.jobs[0]!.commit!.sha).toBe(repo.shaA);
    expect(result.totals).toEqual({ shared: 3, identical: 1, different: 1, bothAbsent: 1 });
    expect(state()).toBe(before);
    expect(calls.every(args => READ_ONLY.includes(args[0]!))).toBe(true);
    expect(calls.some(args => args.includes('fetch') || args.includes('update-ref'))).toBe(false);
    // Verification uses argv arrays with the OID as a literal element; origin/master's own
    // resolution is answered from the pin and never reaches git.
    expect(calls.slice(0, 2)).toEqual([
      ['cat-file', '-t', repo.snapshot],
      ['merge-base', '--is-ancestor', repo.snapshot, 'origin/master'],
    ]);
    expect(calls.filter(args => args[0] === 'rev-parse')).toEqual([]);
    // One bounded log scan serves both jobs, reading the pinned OID — never a second history.
    expect(calls.filter(args => args[0] === 'log'))
      .toEqual([['log', '-n1000', '--first-parent', '--format=%H%x00%cI%x00%s%x00', repo.snapshot, '--']]);
    expect(calls.filter(args => args[0] === 'diff-tree').map(args => args.at(-2)))
      .toEqual([repo.shaA, repo.shaB]);
    // Every tree read pins to the recorded tip or a matched commit, never the moving ref.
    expect(calls.filter(args => args[0] === 'ls-tree').map(args => args[3]))
      .toEqual([repo.shaA, repo.snapshot, repo.shaB]);
  } finally { repo.cleanup(); }
});

it('surfaces injected git failures as rejections with snapshot-specific messages', async () => {
  const oid = sha(7);
  const ok = async (args: string[]) => {
    if (args[0] === 'cat-file') return 'commit\n';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return `${oid}\n`;
    if (args[0] === 'log') return `${sha(8)}\0d\0plain\0\n`;
    throw new Error('unexpected git call');
  };
  await expect(jobCompareSnapshot(oid, 'RQ-A-1', 'RQ-B-2', async args => args[0] === 'cat-file' ? 'tree\n' : ok(args)))
    .rejects.toThrow('job compare snapshot is not a commit');
  await expect(jobCompareSnapshot(oid, 'RQ-A-1', 'RQ-B-2', async args => {
    if (args[0] === 'merge-base') throw new Error('exit 1');
    return ok(args);
  })).rejects.toThrow('job compare snapshot is not an ancestor of origin/master');
  await expect(jobCompareSnapshot(oid, 'RQ-A-1', 'RQ-B-2', async args => {
    if (args[0] === 'cat-file') throw new Error('fatal: Not a valid object name');
    return ok(args);
  })).rejects.toThrow('Not a valid object name');
  await expect(jobCompareSnapshot(oid, 'RQ-A-1', 'RQ-B-2', async args => {
    if (args[0] === 'log') throw new Error('fatal: bad object');
    return ok(args);
  })).rejects.toThrow('bad object');
  // origin/master's resolution is answered from the pin and never reaches git.
  const seen: string[][] = [];
  await jobCompareSnapshot(oid, 'RQ-A-1', 'RQ-B-2', async args => { seen.push(args); return ok(args); });
  expect(seen.filter(args => args[0] === 'rev-parse')).toEqual([]);
  expect(seen.filter(args => args[0] === 'log')[0]!.at(-2)).toBe(oid);
});

it('job-compare-snapshot resolves the convention verb name for dispatcher discoverability', async () => {
  const resolved = resolveFleetSubcommand('job-compare-snapshot');
  expect(resolved).toEqual({
    module: './fleet-job-compare-snapshot.js', exportName: 'cmdFleetJobCompareSnapshot',
  });
  const mod = await import('../src/cli/fleet-job-compare-snapshot.js') as Record<string, unknown>;
  expect(typeof mod[resolved!.exportName]).toBe('function');
});
