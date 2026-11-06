import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCurrentSnapshot } from '../src/cli/fleet-job-current-snapshot.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { jobCurrentSnapshot } from '../src/core/fleet/job-current-snapshot.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const SCRUBBED = 'error: unable to replay job current snapshot from git';
// The only git verbs the replay may invoke; anything else is a mutation or a fetch.
const READ_ONLY = ['cat-file', 'merge-base', 'rev-parse', 'rev-list', 'log', 'diff-tree', 'ls-tree'];

/** Temporary repo with real git; every helper touches only this directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-snapshot-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (subject: string, files: Record<string, string>, remove: string[] = []) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    for (const path of remove) git('rm', '-q', path);
    git('add', '.'); git('commit', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  const publish = (oid: string) => git('update-ref', 'refs/remotes/origin/master', oid);
  git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  return { dir, git, write, commit, publish, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

it('replays the recorded audit identically after origin/master advances and a file is deleted', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    repo.commit('bridge(RQ-PRE-0): seed (#10)', { 'gone.ts': 'x' });
    const bridge = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a', 'del.ts': 'd' });
    repo.commit('bridge(RQ-DEL-4): cleanup job (#14)', {}, ['gone.ts']);
    const recorded = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'b' });
    repo.publish(recorded);
    process.chdir(repo.dir);
    expect(await cmdFleetJobCurrentSnapshot(['--at', recorded, 'RQ-AAA-1', '--json'])).toBe(0);
    const first = log.mock.calls.at(-1)![0] as string;
    const replay = JSON.parse(first);
    expect(replay).toMatchObject({ jobId: 'RQ-AAA-1', requestedSnapshot: recorded, resolvedRef: recorded });
    expect(replay).not.toHaveProperty('ref');
    expect(replay.caveat).toContain('not current live origin/master');
    expect(replay.commit.sha).toBe(bridge);
    expect(replay.entries).toEqual([
      { path: 'a.ts', status: 'changed', atCommit: expect.anything(), atCurrent: expect.anything() },
      { path: 'del.ts', status: 'unchanged', atCommit: expect.anything(), atCurrent: expect.anything() },
    ]);
    expect(replay.summary).toMatchObject({ unchanged: 1, changed: 1, absentNow: 0, absentAtBoth: 0 });

    // A landed deletion at the recorded commit is absent-at-both, never missing work.
    expect(await cmdFleetJobCurrentSnapshot(['--at', recorded, 'RQ-DEL-4', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).entries)
      .toEqual([{ path: 'gone.ts', status: 'absent-at-both', atCommit: null, atCurrent: null }]);

    // origin/master moves on: a later bridge commit edits a.ts again and deletes del.ts.
    const later = repo.commit('bridge(RQ-CCC-3): third job (#13)', { 'a.ts': 'c', 'z.ts': 'z' }, ['del.ts']);
    repo.publish(later);
    expect(await cmdFleetJobCurrentSnapshot(['--at', recorded, 'RQ-AAA-1', '--json'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe(first);

    // Text mode names the pinned snapshot and never calls it current master.
    expect(await cmdFleetJobCurrentSnapshot(['--at', recorded, 'RQ-AAA-1'])).toBe(0);
    const text = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(text).toContain(`Replayed snapshot ${recorded} (pinned; not current origin/master)`);
    expect(text).toContain('changed        a.ts');
    expect(text).toContain('unchanged      del.ts');
    expect(text).toContain('1 unchanged, 1 changed, 0 absent-now, 0 absent-at-both');
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('reports no matching commit honestly at the pinned snapshot', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const tip = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a' });
    repo.publish(tip);
    process.chdir(repo.dir);
    expect(await cmdFleetJobCurrentSnapshot(['--at', tip, 'RQ-NONE-9', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({
      jobId: 'RQ-NONE-9', commit: null, requestedSnapshot: tip, entries: [],
    });
    expect(await cmdFleetJobCurrentSnapshot(['--at', tip, 'RQ-NONE-9'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('does not prove the job never landed');
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('rejects usage errors exit 2 before any git call, including outside a repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-snapshot-nogit-'));
  const cwd = process.cwd();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const oid = 'a'.repeat(40);
  try {
    // Not a git repository: exit 2 proves rejection happened before any git call (which would exit 1).
    process.chdir(dir);
    for (const args of [
      [] as string[], ['RQ-A'], ['--at', oid], ['--at'], ['--at', oid, 'RQ-A', 'RQ-B'],
      ['--at', 'HEAD', 'RQ-A'], ['--at', 'origin/master', 'RQ-A'], ['--at', 'master', 'RQ-A'],
      ['--at', 'HEAD~1', 'RQ-A'], ['--at', `${oid}..${oid}`, 'RQ-A'], ['--at', oid.slice(0, 12), 'RQ-A'],
      ['--at', oid.toUpperCase(), 'RQ-A'], ['--at', 'refs/heads/main', 'RQ-A'], ['--at', '', 'RQ-A'],
      ['--at', oid, '--at', oid, 'RQ-A'], ['--at', oid, 'rq-a'], ['--at', oid, 'RQ-A B'],
      ['--at', oid, '../RQ-A'], ['--at', oid, 'RQ-A', '--json', '--json'],
      ['--at', oid, 'RQ-A', '--status', 'changed'], ['--at', oid, 'RQ-A', '--limit', '5'],
      ['--at', oid, 'RQ-A', '--fetch'], ['--at', oid, 'RQ-A', '--ref', 'HEAD'], ['--at', oid, 'RQ-A', '--cwd', dir],
    ]) {
      expect(await cmdFleetJobCurrentSnapshot(args), JSON.stringify(args)).toBe(2);
    }
    // Input-level exact-id checks: only a literal valid id reaches the scan.
    const run = vi.fn(async () => '');
    for (const [snap, job] of [[oid, 'bad id'], ['HEAD', 'RQ-A'], ['a'.repeat(39), 'RQ-A'], ['A'.repeat(40), 'RQ-A']] as const) {
      await expect(jobCurrentSnapshot(snap, job, run)).rejects.toThrow('invalid job current snapshot arguments');
    }
    expect(run).not.toHaveBeenCalled();
    expect(await cmdFleetJobCurrentSnapshot(['--help'])).toBe(0);
    const help = String(log.mock.calls.at(-1)![0]);
    expect(help).toContain('Usage: ashlr fleet job-current-snapshot --at <full-commit-oid> RQ-ID [--json]');
    expect(help).toContain('ancestor of origin/master');
    expect(await cmdFleetJobCurrentSnapshot(['-h'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('"entries"'))).toBe(false);
  } finally { process.chdir(cwd); error.mockRestore(); log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses non-ancestor, missing, blob and tree objects with a scrubbed exit 1 and no evidence', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const base = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a' });
    const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'b' });
    repo.publish(tip);
    // A commit object that exists but is not reachable from origin/master.
    const side = repo.git('commit-tree', `${tip}^{tree}`, '-p', base, '-m', 'bridge(RQ-SIDE-9): side').trim();
    const tree = repo.git('rev-parse', `${tip}^{tree}`).trim();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.dir, input: 'blob', encoding: 'utf8' }).trim();
    process.chdir(repo.dir);
    for (const oid of [side, sha(1), 'f'.repeat(64), tree, blob]) {
      error.mockClear();
      expect(await cmdFleetJobCurrentSnapshot(['--at', oid, 'RQ-AAA-1', '--json']), oid).toBe(1);
      expect(error.mock.calls.at(-1)![0]).toBe(SCRUBBED);
    }
    expect(log.mock.calls.some(call => String(call[0]).includes('"entries"'))).toBe(false);
    // The same validated commit replays once it is reachable from origin/master.
    expect(await cmdFleetJobCurrentSnapshot(['--at', base, 'RQ-AAA-1', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ requestedSnapshot: base, resolvedRef: base });
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); repo.cleanup(); }
});

it('never mutates the repository and only issues allowlisted read-only git argv', async () => {
  const repo = fixture();
  try {
    const bridge = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a' });
    const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'b' });
    repo.publish(tip);
    const state = () => repo.git('for-each-ref', '--format=%(refname) %(objectname)') + repo.git('status', '--porcelain')
      + repo.git('rev-parse', 'HEAD') + repo.git('reflog', 'show', '--all', '--format=%H %gs');
    const before = state();
    const { calls, run } = recordingRunner(repo.dir);
    const result = await jobCurrentSnapshot(tip, 'RQ-AAA-1', run);
    expect(result.commit?.sha).toBe(bridge);
    expect(result.entries).toEqual([{ path: 'a.ts', status: 'changed', atCommit: expect.anything(), atCurrent: expect.anything() }]);
    expect(state()).toBe(before);
    expect(calls.every(args => READ_ONLY.includes(args[0]!))).toBe(true);
    expect(calls.some(args => args.includes('fetch') || args.includes('update-ref'))).toBe(false);
    // Verification uses argv arrays with the OID as a literal element; origin/master's own resolution is answered from the pin, never by git.
    expect(calls.slice(0, 2)).toEqual([['cat-file', '-t', tip], ['merge-base', '--is-ancestor', tip, 'origin/master']]);
    expect(calls.filter(args => args[0] === 'rev-parse')).toEqual([]);
    expect(calls.filter(args => args[0] === 'log')).toEqual([['log', '-n1000', '--first-parent', '--format=%H%x00%cI%x00%s%x00', tip, '--']]);
    // Both tree reads pin to the recorded tip or the matched commit, never the moving ref.
    const trees = calls.filter(args => args[0] === 'ls-tree').map(args => args[3]);
    expect(trees).toEqual([bridge, tip]);
  } finally { repo.cleanup(); }
});

it('surfaces injected git failures as rejections and reports bounded scan truncation', async () => {
  const oid = sha(7);
  const ok = async (args: string[]) => {
    if (args[0] === 'cat-file') return 'commit\n';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return `${oid}\n`;
    if (args[0] === 'log') return Array.from({ length: 1000 }, (_, i) => `${sha(i + 10)}\0d${i}\0plain\0\n`).join('');
    if (args[0] === 'rev-list') return `${sha(1009)} ${sha(5000)}\n`;
    throw new Error('unexpected git call');
  };
  await expect(jobCurrentSnapshot(oid, 'RQ-A-1', async args => args[0] === 'cat-file' ? 'tree\n' : ok(args)))
    .rejects.toThrow('job current snapshot is not a commit');
  await expect(jobCurrentSnapshot(oid, 'RQ-A-1', async args => {
    if (args[0] === 'merge-base') throw new Error('exit 1');
    return ok(args);
  })).rejects.toThrow('job current snapshot is not an ancestor of origin/master');
  await expect(jobCurrentSnapshot(oid, 'RQ-A-1', async args => {
    if (args[0] === 'cat-file') throw new Error('fatal: Not a valid object name');
    return ok(args);
  })).rejects.toThrow('Not a valid object name');
  await expect(jobCurrentSnapshot(oid, 'RQ-A-1', async args => {
    if (args[0] === 'log') throw new Error('fatal: bad object');
    return ok(args);
  })).rejects.toThrow('bad object');
  // A full bounded scan with no matches reports truncation and never fabricates job history.
  const bounded = await jobCurrentSnapshot(oid, 'RQ-A-1', ok);
  expect(bounded).toMatchObject({ requestedSnapshot: oid, scanned: 1000, scanMayBeTruncated: true, commit: null });
  // origin/master's resolution is answered from the pin and never reaches git; the log scan reads the pinned OID.
  const seen: string[][] = [];
  await jobCurrentSnapshot(oid, 'RQ-A-1', async args => { seen.push(args); return ok(args); });
  expect(seen.filter(args => args[0] === 'rev-parse')).toEqual([]);
  expect(seen.filter(args => args[0] === 'log')[0]!.at(-2)).toBe(oid);
});

it('resolves the convention verb name for dispatcher discoverability', async () => {
  const resolved = resolveFleetSubcommand('job-current-snapshot');
  expect(resolved).toEqual({
    module: './fleet-job-current-snapshot.js', exportName: 'cmdFleetJobCurrentSnapshot',
  });
  const mod = await import('../src/cli/fleet-job-current-snapshot.js') as Record<string, unknown>;
  expect(typeof mod[resolved!.exportName]).toBe('function');
});
