import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCurrent } from '../src/cli/fleet-job-current.js';
import { jobCurrent, type JobCurrentReport } from '../src/core/fleet/job-current.js';

const execAsync = promisify(execFile);

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-filter-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('landed-del.txt', 'old'); commit('plain base');
  write('keep.txt', 'keep'); write('edit.txt', 'v1'); write('gone.txt', 'bye');
  rmSync(join(dir, 'landed-del.txt'));
  commit('bridge(RQ-FLT-1): filter secret words (#11)');
  const bridgeSha = git('rev-parse', 'HEAD').trim();
  write('edit.txt', 'v2'); rmSync(join(dir, 'gone.txt'));
  commit('plain later work');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  const run = async (args: string[]) => (await execAsync('git', args,
    { cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return { dir, git, write, commit, run, bridgeSha, oid: git('rev-parse', 'HEAD').trim() };
}

async function runCli(dir: string, args: string[]) {
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(dir);
    const code = await cmdFleetJobCurrent(args);
    return { code, out: log.mock.calls.map(call => String(call[0])), err: error.mock.calls.map(call => String(call[0])) };
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); }
}

it('selects each of the four statuses in text and JSON while the full summary survives', async () => {
  const repo = makeRepo();
  try {
    const full = (await jobCurrent('RQ-FLT-1', repo.run)) as JobCurrentReport;
    expect(full.summary).toEqual({ unchanged: 1, changed: 1, absentNow: 1, absentAtBoth: 1 });
    const want: Record<string, string[]> = {
      'unchanged': ['keep.txt'], 'changed': ['edit.txt'],
      'absent-now': ['gone.txt'], 'absent-at-both': ['landed-del.txt'],
    };
    for (const [status, paths] of Object.entries(want)) {
      const json = await runCli(repo.dir, ['RQ-FLT-1', '--json', '--status', status]);
      expect(json.code).toBe(0);
      const out = JSON.parse(json.out.at(-1)!);
      expect(out.entries.map((entry: { path: string }) => entry.path)).toEqual(paths);
      expect(out.selection).toEqual({ status, returned: paths.length });
      // The unfiltered comparison metadata rides along untouched.
      expect(out.summary).toEqual(full.summary);
      expect(out).toMatchObject({ resolvedRef: repo.oid, scanBound: full.scanBound, scanned: full.scanned,
        scanMayBeTruncated: false, pathBound: full.pathBound, omittedPaths: 0 });
      expect(out.commit).toMatchObject({ sha: repo.bridgeSha, pr: 11 });
      const text = await runCli(repo.dir, ['RQ-FLT-1', '--status', status]);
      expect(text.code).toBe(0);
      const selected = text.out.filter(line => line.startsWith('  ')).map(line => line.trimEnd());
      expect(selected).toEqual(paths.map(path => `  ${status.padEnd(14)} ${path}`));
      expect(text.out.some(line => line.includes(`Selected ${paths.length} ${status}`))).toBe(true);
      expect(text.out.at(-1)).toContain('1 unchanged, 1 changed, 1 absent-now, 1 absent-at-both');
    }
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('keeps default output byte-compatible: no selection key, every entry, unchanged JSON shape', async () => {
  const repo = makeRepo();
  try {
    const res = await runCli(repo.dir, ['RQ-FLT-1', '--json']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out.at(-1)!);
    expect('selection' in out).toBe(false);
    expect(out.entries).toHaveLength(4);
    expect(out.summary).toEqual({ unchanged: 1, changed: 1, absentNow: 1, absentAtBoth: 1 });
    const text = await runCli(repo.dir, ['RQ-FLT-1']);
    expect(text.code).toBe(0);
    expect(text.out.some(line => line.startsWith('Selected'))).toBe(false);
    expect(text.out.filter(line => line.startsWith('  '))).toHaveLength(4);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('distinguishes an empty selection on a real commit from a job with no commit', async () => {
  const repo = makeRepo();
  try {
    // A real bridge commit whose filter matches nothing: empty entries, selection still named.
    repo.write('only.txt', 'x'); repo.commit('bridge(RQ-FLT-2): nothing removed (#12)');
    repo.git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const res = await runCli(repo.dir, ['RQ-FLT-2', '--json', '--status', 'absent-now']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out.at(-1)!);
    expect(out.commit).not.toBeNull();
    expect(out.entries).toEqual([]);
    expect(out.selection).toEqual({ status: 'absent-now', returned: 0 });
    // A filtered empty set is still announced in text, never confused with no landed work.
    const text = await runCli(repo.dir, ['RQ-FLT-2', '--status', 'absent-now']);
    expect(text.code).toBe(0);
    expect(text.out.some(line => line.includes('Newest bridge commit'))).toBe(true);
    expect(text.out.some(line => line.includes('Selected 0 absent-now entries'))).toBe(true);
    // No commit at all: the reader still reports nothing landed, selection names the filter.
    const none = await runCli(repo.dir, ['RQ-NOPE-9', '--json', '--status', 'changed']);
    expect(none.code).toBe(0);
    const nope = JSON.parse(none.out.at(-1)!);
    expect(nope.commit).toBeNull();
    expect(nope.entries).toEqual([]);
    expect(nope.selection).toEqual({ status: 'changed', returned: 0 });
    const nopeText = await runCli(repo.dir, ['RQ-NOPE-9', '--status', 'changed']);
    expect(nopeText.code).toBe(0);
    expect(nopeText.out.at(-1)).toContain('does not prove the job never landed');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('preserves path-bound and scan-truncation evidence under a filter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-filter-bound-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'a.txt'), 'a'); git('add', '-A'); git('commit', '-qm', 'base');
    for (let i = 0; i < 202; i++) writeFileSync(join(dir, `p${String(i).padStart(3, '0')}.txt`), 'x');
    git('add', '-A'); git('commit', '-qm', 'bridge(RQ-BIG-1): many paths (#3)');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const res = await runCli(dir, ['RQ-BIG-1', '--json', '--status', 'unchanged']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out.at(-1)!);
    expect(out).toMatchObject({ pathBound: 200, omittedPaths: 2, scanBound: 1000 });
    expect(out.summary.unchanged).toBe(200);
    expect(out.entries).toHaveLength(200);
    expect(out.selection).toEqual({ status: 'unchanged', returned: 200 });
    const text = await runCli(dir, ['RQ-BIG-1', '--status', 'unchanged']);
    expect(text.code).toBe(0);
    expect(text.out.some(line => line.includes('2 more paths beyond the 200-path bound'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rejects unknown, repeated or missing --status with exit 2 before any reader call', async () => {
  const nogit = mkdtempSync(join(tmpdir(), 'job-current-filter-nogit-'));
  try {
    // Exit 2 in a non-repo proves rejection happened before the reader, which would exit 1.
    for (const args of [
      ['RQ-FLT-1', '--status'], ['RQ-FLT-1', '--status', 'bogus'], ['RQ-FLT-1', '--status', 'CHANGED'],
      ['RQ-FLT-1', '--status', 'absent'], ['RQ-FLT-1', '--status', '--json'],
      ['RQ-FLT-1', '--status', 'changed', '--status', 'changed'],
      ['RQ-FLT-1', '--status', 'changed', '--status', 'absent-now'],
      ['--status', 'changed'], ['RQ-FLT-1', '--status=changed'],
    ]) {
      const res = await runCli(nogit, args);
      expect(res.code).toBe(2);
      expect(res.err.at(-1)).toContain('Usage: ashlr fleet job-current');
      expect(res.out).toEqual([]);
    }
    const help = await runCli(nogit, ['--help']);
    expect(help.code).toBe(0);
    expect(help.out.at(-1)).toContain('--status unchanged|changed|absent-now|absent-at-both');
    expect(help.out.at(-1)).toContain('not behavioral correctness');
  } finally { rmSync(nogit, { recursive: true, force: true }); }
});

it('still exits 1 on reader failure with a valid filter', async () => {
  const nogit = mkdtempSync(join(tmpdir(), 'job-current-filter-nogit-'));
  try {
    const res = await runCli(nogit, ['RQ-FLT-1', '--status', 'changed', '--json']);
    expect(res.code).toBe(1);
    expect(res.err.at(-1)).toContain('unable to read job current state');
    expect(res.out).toEqual([]);
  } finally { rmSync(nogit, { recursive: true, force: true }); }
});
