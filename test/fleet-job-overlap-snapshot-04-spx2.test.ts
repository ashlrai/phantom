import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobOverlap } from '../src/cli/fleet-job-overlap.js';
import { cmdFleetJobOverlapSnapshot } from '../src/cli/fleet-job-overlap-snapshot.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { jobOverlapSnapshot } from '../src/core/fleet/job-overlap-snapshot.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const record = (n: number, subject: string) => `${sha(n)}\0d${n}\0${subject}\0\n`;
const SCRUBBED = 'error: unable to replay job overlap snapshot from git';
// The only git verbs the replay may invoke; anything else is a mutation or a fetch.
const READ_ONLY = ['cat-file', 'merge-base', 'rev-parse', 'log', 'diff-tree'];

/** Temporary repo with real git; every helper touches only this directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'job-overlap-snapshot-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
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

it('replays an overlap finding identically after origin/master advances, while live overlap changes', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'shared/one.ts': 'a', 'only-a.ts': 'a' });
    const recorded = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'shared/one.ts': 'b' });
    repo.publish(recorded);
    process.chdir(repo.dir);
    expect(await cmdFleetJobOverlapSnapshot(['--at', recorded, 'RQ-AAA-1', 'RQ-BBB-2', '--json'])).toBe(0);
    const first = log.mock.calls.at(-1)![0] as string;
    expect(await cmdFleetJobOverlap(['RQ-AAA-1', 'RQ-CCC-3', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).jobs[1]).toMatchObject({ jobId: 'RQ-CCC-3', commits: 0 });

    // origin/master moves on: a later bridge commit touches the same path.
    const later = repo.commit('bridge(RQ-CCC-3): third job (#13)', { 'shared/one.ts': 'c' });
    repo.publish(later);
    expect(await cmdFleetJobOverlapSnapshot(['--at', recorded, 'RQ-AAA-1', 'RQ-BBB-2', '--json'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe(first);
    const replay = JSON.parse(first);
    expect(replay).toMatchObject({ schemaVersion: 1, requestedSnapshot: recorded, resolvedRef: recorded });
    expect(replay).not.toHaveProperty('ref');
    expect(replay.caveat).toContain('not current live origin/master');
    expect(replay.sharedPaths).toEqual([{ path: 'shared/one.ts', jobIds: ['RQ-AAA-1', 'RQ-BBB-2'] }]);

    // The live overlap reads the moved master and sees the new landed job.
    expect(await cmdFleetJobOverlap(['RQ-AAA-1', 'RQ-CCC-3', '--json'])).toBe(0);
    const live = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(live.resolvedRef).toBe(later);
    expect(live.jobs[1]).toMatchObject({ jobId: 'RQ-CCC-3', commits: 1 });
    expect(live.sharedPaths).toEqual([{ path: 'shared/one.ts', jobIds: ['RQ-AAA-1', 'RQ-CCC-3'] }]);

    // Text mode names the pinned snapshot and never calls it current master.
    expect(await cmdFleetJobOverlapSnapshot(['--at', recorded, 'RQ-AAA-1', 'RQ-BBB-2'])).toBe(0);
    const text = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(text).toContain(`Replayed snapshot ${recorded} (pinned; not current origin/master)`);
    expect(text).toContain('shared/one.ts: RQ-AAA-1, RQ-BBB-2');
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('rejects usage errors exit 2 before any git call, including outside a repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-overlap-snapshot-nogit-'));
  const cwd = process.cwd();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const oid = 'a'.repeat(40);
  try {
    // Not a git repository: exit 2 proves rejection happened before any git call (which would exit 1).
    process.chdir(dir);
    for (const args of [
      [] as string[], ['RQ-A', 'RQ-B'], ['--at', oid], ['--at', oid, 'RQ-A'],
      ['--at', 'HEAD', 'RQ-A', 'RQ-B'], ['--at', 'origin/master', 'RQ-A', 'RQ-B'], ['--at', 'master', 'RQ-A', 'RQ-B'],
      ['--at', 'HEAD~1', 'RQ-A', 'RQ-B'], ['--at', `${oid}..${oid}`, 'RQ-A', 'RQ-B'], ['--at', oid.slice(0, 12), 'RQ-A', 'RQ-B'],
      ['--at', oid.toUpperCase(), 'RQ-A', 'RQ-B'], ['--at', 'refs/heads/main', 'RQ-A', 'RQ-B'], ['--at', '', 'RQ-A', 'RQ-B'],
      ['--at', '-', 'RQ-A', 'RQ-B'], ['--at', oid, '--at', oid, 'RQ-A', 'RQ-B'], ['--at', oid, 'RQ-A', 'RQ-A'],
      ['--at', oid, 'rq-a', 'RQ-B'], ['--at', oid, 'RQ-A B', 'RQ-C'], ['--at', oid, '../RQ-A', 'RQ-B'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--limit', '0'], ['--at', oid, 'RQ-A', 'RQ-B', '--limit', '101'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--limit', 'x'], ['--at', oid, 'RQ-A', 'RQ-B', '--limit'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--limit', '1', '--limit', '2'], ['--at', oid, 'RQ-A', 'RQ-B', '--json', '--json'],
      ['--at', oid, 'RQ-A', 'RQ-B', '--root', dir], ['--at', oid, 'RQ-A', 'RQ-B', '--cwd', dir],
      ['--at', oid, 'RQ-A', 'RQ-B', '--fetch'], ['--at', oid, 'RQ-A', 'RQ-B', '--ref', 'HEAD'],
      ['--at', oid, ...Array.from({ length: 21 }, (_, i) => `RQ-${i}`)],
    ]) {
      expect(await cmdFleetJobOverlapSnapshot(args), JSON.stringify(args)).toBe(2);
    }
    // Input-level exact-id checks: only literal, distinct ids reach the scan.
    await expect(jobOverlapSnapshot(oid, ['RQ-A', 'RQ-B'], 0, vi.fn(async () => ''))).rejects.toThrow('invalid job overlap snapshot arguments');
    expect(await cmdFleetJobOverlapSnapshot(['--help'])).toBe(0);
    const help = String(log.mock.calls.at(-1)![0]);
    expect(help).toContain('Usage: ashlr fleet job-overlap-snapshot --at <full-commit-oid> RQ-ID...');
    expect(help).toContain('pinned snapshot');
    expect(await cmdFleetJobOverlapSnapshot(['-h'])).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('"sharedPaths"'))).toBe(false);
  } finally { process.chdir(cwd); error.mockRestore(); log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses non-ancestor, missing, and non-commit objects with a scrubbed exit 1 and no evidence', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const base = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'shared/one.ts': 'a' });
    const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'shared/one.ts': 'b' });
    repo.publish(tip);
    // A commit object that exists but is not reachable from origin/master.
    const side = repo.git('commit-tree', `${tip}^{tree}`, '-p', base, '-m', 'bridge(RQ-SIDE-9): side').trim();
    const tree = repo.git('rev-parse', `${tip}^{tree}`).trim();
    process.chdir(repo.dir);
    for (const oid of [side, sha(1), 'f'.repeat(64), tree]) {
      error.mockClear();
      expect(await cmdFleetJobOverlapSnapshot(['--at', oid, 'RQ-AAA-1', 'RQ-BBB-2', '--json']), oid).toBe(1);
      expect(error.mock.calls.at(-1)![0]).toBe(SCRUBBED);
    }
    expect(log.mock.calls.some(call => String(call[0]).includes('"sharedPaths"'))).toBe(false);
    // The same validated commit replays once it is reachable from origin/master.
    expect(await cmdFleetJobOverlapSnapshot(['--at', base, 'RQ-AAA-1', 'RQ-BBB-2', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ requestedSnapshot: base, resolvedRef: base });
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); repo.cleanup(); }
});

it('keeps literal paths and reports truncation honestly through the CLI', async () => {
  const repo = fixture();
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    repo.commit('bridge(RQ-LIT-1): one (#21)', { 'lit/[x].ts': 'a' });
    repo.commit('bridge(RQ-LIT-2): two (#22)', { 'lit/[x].ts': 'b' });
    repo.commit('bridge(RQ-LIT-3): three (#23)', { 'lit/x.ts': 'c' });
    const tip = repo.commit('bridge(RQ-LIT-1): again (#24)', { 'lit/[x].ts': 'd' });
    repo.publish(tip);
    process.chdir(repo.dir);
    // Brackets are literal: lit/x.ts never groups with lit/[x].ts.
    expect(await cmdFleetJobOverlapSnapshot(['--at', tip, 'RQ-LIT-1', 'RQ-LIT-2', 'RQ-LIT-3', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).sharedPaths)
      .toEqual([{ path: 'lit/[x].ts', jobIds: ['RQ-LIT-1', 'RQ-LIT-2'] }]);
    // --limit 1 keeps only the newest commit per id and flags the cut.
    expect(await cmdFleetJobOverlapSnapshot(['--at', tip, 'RQ-LIT-1', 'RQ-LIT-2', '--limit', '1', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({
      limit: 1, evidenceMayBeIncomplete: true, jobs: [{ jobId: 'RQ-LIT-1', commits: 1, matchesTruncated: true }, { jobId: 'RQ-LIT-2', commits: 1, matchesTruncated: false }],
    });
    expect(await cmdFleetJobOverlapSnapshot(['--at', tip, 'RQ-LIT-1', 'RQ-LIT-2', '--limit', '1'])).toBe(0);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('more matches than --limit kept');
    expect(await cmdFleetJobOverlapSnapshot(['--at', tip, 'RQ-LIT-1', 'RQ-LIT-2', '--limit', '100', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).evidenceMayBeIncomplete).toBe(false);
  } finally { process.chdir(cwd); log.mockRestore(); repo.cleanup(); }
});

it('never mutates the repository and only issues allowlisted read-only git argv', async () => {
  const repo = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'shared/one.ts': 'a' });
    const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'shared/one.ts': 'b' });
    repo.publish(tip);
    const state = () => repo.git('for-each-ref', '--format=%(refname) %(objectname)') + repo.git('status', '--porcelain')
      + repo.git('rev-parse', 'HEAD') + repo.git('reflog', 'show', '--all', '--format=%H %gs');
    const before = state();
    const { calls, run } = recordingRunner(repo.dir);
    const result = await jobOverlapSnapshot(tip, ['RQ-AAA-1', 'RQ-BBB-2'], 20, run);
    expect(result.sharedPaths).toEqual([{ path: 'shared/one.ts', jobIds: ['RQ-AAA-1', 'RQ-BBB-2'] }]);
    expect(state()).toBe(before);
    expect(calls.every(args => READ_ONLY.includes(args[0]!))).toBe(true);
    expect(calls.some(args => args.includes('fetch') || args.includes('update-ref'))).toBe(false);
    // Verification uses argv arrays with the OID as a literal element; origin/master's own resolution is answered from the pin, never by git.
    expect(calls.slice(0, 2)).toEqual([['cat-file', '-t', tip], ['merge-base', '--is-ancestor', tip, 'origin/master']]);
    expect(calls.filter(args => args[0] === 'rev-parse')).toEqual([]);
    expect(calls.filter(args => args[0] === 'log')).toEqual([['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', tip, '--']]);
  } finally { log.mockRestore(); repo.cleanup(); }
});

it('surfaces injected git failures as rejections and reports bounded scan truncation', async () => {
  const oid = sha(7);
  const ids = ['RQ-A-1', 'RQ-B-2'];
  const ok = async (args: string[]) => {
    if (args[0] === 'cat-file') return 'commit\n';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return `${oid}\n`;
    if (args[0] === 'log') return Array.from({ length: 1000 }, (_, i) => record(i + 10, 'plain')).join('');
    throw new Error('unexpected git call');
  };
  await expect(jobOverlapSnapshot(oid, ids, 20, async args => args[0] === 'cat-file' ? 'tree\n' : ok(args)))
    .rejects.toThrow('job overlap snapshot is not a commit');
  await expect(jobOverlapSnapshot(oid, ids, 20, async args => {
    if (args[0] === 'merge-base') throw new Error('exit 1');
    return ok(args);
  })).rejects.toThrow('job overlap snapshot is not an ancestor of origin/master');
  await expect(jobOverlapSnapshot(oid, ids, 20, async args => {
    if (args[0] === 'cat-file') throw new Error('fatal: Not a valid object name');
    return ok(args);
  })).rejects.toThrow('Not a valid object name');
  await expect(jobOverlapSnapshot(oid, ids, 20, async args => {
    if (args[0] === 'log') throw new Error('fatal: bad object');
    return ok(args);
  })).rejects.toThrow('bad object');
  // A full bounded scan with no matches reports truncation and never fabricates job history.
  const bounded = await jobOverlapSnapshot(oid, ids, 20, ok);
  expect(bounded).toMatchObject({ requestedSnapshot: oid, scanned: 1000, scanMayBeTruncated: true, evidenceMayBeIncomplete: true });
  expect(bounded.jobs).toEqual([
    { jobId: 'RQ-A-1', commits: 0, paths: 0, matchesTruncated: false },
    { jobId: 'RQ-B-2', commits: 0, paths: 0, matchesTruncated: false },
  ]);
  // origin/master's resolution is answered from the pin and never reaches git; the log scan reads the pinned OID.
  const seen: string[][] = [];
  await jobOverlapSnapshot(oid, ids, 20, async args => { seen.push(args); return ok(args); });
  expect(seen.filter(args => args[0] === 'rev-parse')).toEqual([]);
  expect(seen.filter(args => args[0] === 'log')[0]!.at(-2)).toBe(oid);
});

it('resolves the convention verb name and rejects non-canonical snapshot forms in the core', async () => {
  expect(resolveFleetSubcommand('job-overlap-snapshot')).toEqual({
    module: './fleet-job-overlap-snapshot.js', exportName: 'cmdFleetJobOverlapSnapshot',
  });
  const run = vi.fn(async () => '');
  for (const oid of ['HEAD', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41), 'g'.repeat(40), `${'a'.repeat(40)}\n`]) {
    await expect(jobOverlapSnapshot(oid, ['RQ-A-1', 'RQ-B-2'], 20, run)).rejects.toThrow('invalid job overlap snapshot arguments');
  }
  expect(run).not.toHaveBeenCalled();
});
