import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCurrent } from '../src/cli/fleet-job-current.js';
import { jobCurrent } from '../src/core/fleet/job-current.js';

const execAsync = promisify(execFile);
const sha = (n: number) => n.toString(16).padStart(40, '0');
const OID = 'e'.repeat(40);

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('landed-del.txt', 'old'); write('recreated.txt', 'old'); write('swap', 'file'); commit('plain base');
  write('keep.txt', 'keep'); write('edit.txt', 'v1'); write('gone.txt', 'bye');
  write('dir with spaces/f [x].txt', 's'); write('glob[?].txt', 'g');
  rmSync(join(dir, 'landed-del.txt')); rmSync(join(dir, 'recreated.txt')); rmSync(join(dir, 'swap'));
  write('swap/inner.txt', 'in');
  commit('bridge(RQ-CUR-1): secret subject words (#7)');
  const bridgeSha = git('rev-parse', 'HEAD').trim();
  write('edit.txt', 'v2'); rmSync(join(dir, 'gone.txt')); write('recreated.txt', 'new');
  commit('plain later work');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  const run = async (args: string[]) => (await execAsync('git', args,
    { cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return { dir, git, run, write, commit, bridgeSha, oid: git('rev-parse', 'HEAD').trim() };
}

it('reports object evidence through real git for every status class', async () => {
  const repo = makeRepo();
  try {
    const res = await jobCurrent('RQ-CUR-1', repo.run);
    expect(res).toMatchObject({ jobId: 'RQ-CUR-1', ref: 'origin/master', resolvedRef: repo.oid, omittedPaths: 0 });
    expect(res.commit).toMatchObject({ sha: repo.bridgeSha, pr: 7 });
    const byPath = new Map(res.entries.map(e => [e.path, e]));
    expect([...byPath.keys()]).toEqual([...byPath.keys()].sort());
    expect(byPath.get('keep.txt')!).toMatchObject({ status: 'unchanged', atCommit: { mode: '100644', type: 'blob' } });
    expect(byPath.get('keep.txt')!.atCommit!.oid).toBe(byPath.get('keep.txt')!.atCurrent!.oid);
    expect(byPath.get('edit.txt')!.status).toBe('changed');
    expect(byPath.get('gone.txt')!).toMatchObject({ status: 'absent-now', atCurrent: null });
    expect(byPath.get('landed-del.txt')!).toMatchObject({ status: 'absent-at-both', atCommit: null, atCurrent: null });
    expect(byPath.get('dir with spaces/f [x].txt')!.status).toBe('unchanged');
    expect(byPath.get('glob[?].txt')!.status).toBe('unchanged');
    // re-created after a landed deletion: differs from the absence the commit left.
    expect(byPath.get('recreated.txt')!).toMatchObject({ status: 'changed', atCommit: null });
    // a file swapped for a directory keeps exact tree-entry evidence, never a false absent.
    expect(byPath.get('swap')!).toMatchObject({ status: 'unchanged', atCommit: { mode: '040000', type: 'tree' } });
    expect(byPath.get('swap/inner.txt')!.status).toBe('unchanged');
    expect(res.summary).toEqual({ unchanged: 5, changed: 2, absentNow: 1, absentAtBoth: 1 });
    expect(JSON.stringify(res)).not.toContain('secret subject words');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('pins every comparison to the resolved oid while origin/master moves mid-read', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'moved'); repo.commit('plain moved head');
    const movedOid = repo.git('rev-parse', 'HEAD').trim();
    repo.git('update-ref', 'refs/remotes/origin/master', repo.oid);
    const calls: string[][] = [];
    let moved = false;
    const run = async (args: string[]) => {
      calls.push(args);
      const out = await repo.run(args);
      if (!moved && args[0] === 'ls-tree') { moved = true; repo.git('update-ref', 'refs/remotes/origin/master', movedOid); }
      return out;
    };
    const pinned = await jobCurrent('RQ-CUR-1', run);
    expect(pinned.resolvedRef).toBe(repo.oid);
    for (const call of calls.filter(c => c[0] === 'ls-tree')) expect([repo.oid, repo.bridgeSha]).toContain(call[3]);
    expect(pinned.entries.find(e => e.path === 'keep.txt')!.status).toBe('unchanged');
    const after = await jobCurrent('RQ-CUR-1', repo.run);
    expect(after.resolvedRef).toBe(movedOid);
    expect(after.entries.find(e => e.path === 'keep.txt')!.status).toBe('changed');
    // read-only: no fetch or mutation verbs ever ran.
    expect(new Set(calls.map(c => c[0]))).toEqual(new Set(['rev-parse', 'log', 'diff-tree', 'ls-tree']));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('names the resolved ref with empty evidence when no bridge commit matches', async () => {
  const repo = makeRepo();
  try {
    const res = await jobCurrent('RQ-NOPE-9', repo.run);
    expect(res).toMatchObject({ jobId: 'RQ-NOPE-9', resolvedRef: repo.oid, commit: null, entries: [], omittedPaths: 0 });
    expect(res.scanned).toBe(3);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('bounds the comparison to 200 literal pathspecs and reports the omitted count', async () => {
  const paths = Array.from({ length: 205 }, (_, i) => `p${String(i).padStart(3, '0')}.ts`);
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return `${sha(1)}\0d\0bridge(RQ-BIG-1): many paths (#3)\0\n`;
    if (args[0] === 'diff-tree') return `${paths.join('\0')}\0`;
    if (args[0] === 'ls-tree') {
      expect(args.slice(0, 4)).toEqual(['ls-tree', '-z', '--full-tree', expect.stringMatching(/^[0-9a-f]{40}$/)]);
      expect(args[4]).toBe('--');
      expect(args.slice(5)).toHaveLength(200);
      for (const spec of args.slice(5)) expect(spec.startsWith(':(literal)')).toBe(true);
      return args.slice(5).map(spec => `100644 blob ${sha(9)}\t${spec.slice(10)}\0`).join('');
    }
    throw new Error('unexpected git call');
  });
  const res = await jobCurrent('RQ-BIG-1', run);
  expect(res).toMatchObject({ resolvedRef: OID, omittedPaths: 5 });
  expect(res.entries).toHaveLength(200);
  expect(res.summary.unchanged).toBe(200);
  const trees = run.mock.calls.filter(c => c[0][0] === 'ls-tree').map(c => c[0][3]).sort();
  expect(trees).toEqual([OID, sha(1)].sort());
});

it('serves the CLI: help, flag validation, JSON provenance and git failure', async () => {
  const repo = makeRepo();
  const nogit = mkdtempSync(join(tmpdir(), 'job-current-nogit-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const args of [[], ['nope'], ['rq-cur-1'], ['RQ-'], ['RQ-CUR-1', 'RQ-B-2'],
      ['RQ-CUR-1', '--bogus'], ['RQ-CUR-1', '--json', '--json'], ['--json'], ['RQ-CUR-1', '--help']]) {
      expect(await cmdFleetJobCurrent(args)).toBe(2);
    }
    expect(await cmdFleetJobCurrent(['--help'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('Usage: ashlr fleet job-current');
    process.chdir(repo.dir);
    expect(await cmdFleetJobCurrent(['RQ-CUR-1', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ ref: 'origin/master', resolvedRef: repo.oid, jobId: 'RQ-CUR-1' });
    expect(out.commit).toMatchObject({ sha: repo.bridgeSha, pr: 7 });
    expect(out.entries).toHaveLength(9);
    expect(JSON.stringify(out)).not.toContain('secret subject words');
    expect(await cmdFleetJobCurrent(['RQ-CUR-1'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('evidence only');
    expect(await cmdFleetJobCurrent(['RQ-NOPE-9'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('does not prove the job never landed');
    process.chdir(nogit);
    expect(await cmdFleetJobCurrent(['RQ-CUR-1'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toContain('unable to read job current state');
  } finally {
    process.chdir(cwd); log.mockRestore(); error.mockRestore();
    rmSync(repo.dir, { recursive: true, force: true }); rmSync(nogit, { recursive: true, force: true });
  }
});
