import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';
import type { JobPrecheckGit } from '../src/core/fleet/job-precheck.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-precheck-batch-'));
  dirs.push(dir);
  return dir;
}

function draft(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
}

/** Fake adapter: paths in `master` exist; each maps to its last-commit subject. */
function fakeGit(master: Record<string, string>): JobPrecheckGit & { exists: ReturnType<typeof vi.fn>; lastCommit: ReturnType<typeof vi.fn> } {
  return {
    exists: vi.fn(async (path: string) => Object.prototype.hasOwnProperty.call(master, path)),
    lastCommit: vi.fn(async (path: string) => {
      const subject = master[path];
      return subject ? { sha: 'abc1234', subject } : null;
    }),
  };
}

const BRIDGED = { 'src/done.ts': 'bridge(RQ-PHX-SP4B1): landed' };

it('reports mixed verdicts in input order, counts them and exits 2 when a draft errors', async () => {
  const dir = tempDir();
  const files = [
    draft(dir, 'done.md', 'Edit src/done.ts and add test/more.test.ts\n'),
    draft(dir, 'fresh.md', 'Create src/new.ts\n'),
    draft(dir, 'partial.md', 'Touch src/done.ts and src/wip.ts\n'),
    join(dir, 'absent.md'),
  ];
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', ...files, '--json'], { git: fakeGit(BRIDGED), log: c.log, error: c.error });
  expect(code).toBe(2);
  expect(c.out).toHaveLength(1);
  const body = JSON.parse(c.out[0]!) as {
    schema: string;
    results: Array<{ file: string; verdict?: string; error?: string; newTestFiles?: string[] }>;
    counts: Record<string, number>;
  };
  expect(body.schema).toBe('fleet.job-precheck-batch.v1');
  expect(body.results.map(r => r.file)).toEqual(files);
  expect(body.results.map(r => r.verdict ?? 'error')).toEqual(['likely-done', 'fresh', 'partly-on-master', 'error']);
  expect(body.results[0]!.newTestFiles).toEqual(['test/more.test.ts']);
  expect(body.results[3]!.error).toContain('cannot read');
  expect(body.results[3]!.verdict).toBeUndefined();
  expect(body.counts).toEqual({ fresh: 1, 'partly-on-master': 1, 'likely-done': 1, errors: 1 });
});

it('exits 3 when an error-free batch has a likely-done draft, 0 when none does', async () => {
  const dir = tempDir();
  const done = draft(dir, 'done.md', 'Edit src/done.ts\n');
  const fresh = draft(dir, 'fresh.md', 'Create src/new.ts\n');
  const c = capture();
  expect(await cmdFleetJobPrecheck(['--batch', done, fresh, '--json'], { git: fakeGit(BRIDGED), log: c.log, error: c.error })).toBe(3);
  expect((JSON.parse(c.out[0]!) as { counts: Record<string, number> }).counts).toEqual({ fresh: 1, 'partly-on-master': 0, 'likely-done': 1, errors: 0 });
  const c2 = capture();
  expect(await cmdFleetJobPrecheck(['--batch', fresh, '--json'], { git: fakeGit(BRIDGED), log: c2.log, error: c2.error })).toBe(0);
});

it('probes each shared path once across overlapping drafts', async () => {
  const dir = tempDir();
  const git = fakeGit({ 'src/done.ts': 'bridge(RQ-PHX-SP4B1): landed', 'test/x.test.ts': 'older test' });
  const a = draft(dir, 'a.md', 'src/done.ts test/x.test.ts\n');
  const b = draft(dir, 'b.md', 'Again src/done.ts plus test/x.test.ts\n');
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', a, b, '--json'], { git, log: c.log, error: c.error });
  expect(code).toBe(3);
  expect(git.exists.mock.calls.map(call => call[0])).toEqual(['src/done.ts', 'test/x.test.ts']);
  expect(git.lastCommit.mock.calls.map(call => call[0])).toEqual(['src/done.ts', 'test/x.test.ts']);
});

it('keeps a cached probe failure a failure for every draft, not a missing path', async () => {
  const dir = tempDir();
  const git: JobPrecheckGit & { exists: ReturnType<typeof vi.fn> } = {
    exists: vi.fn(async (path: string) => {
      if (path === 'src/boom.ts') throw new Error('fatal: not a git repository');
      return false;
    }),
    lastCommit: vi.fn(async () => null),
  };
  const a = draft(dir, 'a.md', 'src/boom.ts\n');
  const b = draft(dir, 'b.md', 'src/boom.ts src/new.ts\n');
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', a, b, '--json'], { git, log: c.log, error: c.error });
  expect(code).toBe(2);
  const body = JSON.parse(c.out[0]!) as { results: Array<{ verdict?: string; error?: string }>; counts: Record<string, number> };
  expect(body.results.map(r => r.error)).toEqual(['fatal: not a git repository', 'fatal: not a git repository']);
  expect(body.results.map(r => r.verdict)).toEqual([undefined, undefined]);
  expect(body.counts).toEqual({ fresh: 0, 'partly-on-master': 0, 'likely-done': 0, errors: 2 });
  expect(git.exists.mock.calls.map(call => call[0])).toEqual(['src/boom.ts']);
});

it('keeps checking a later draft after an unreadable middle one', async () => {
  const dir = tempDir();
  const a = draft(dir, 'a.md', 'Create src/new.ts\n');
  const missing = join(dir, 'absent.md');
  const b = draft(dir, 'b.md', 'Create src/other.ts\n');
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', a, missing, b], {
    git: fakeGit({}), log: c.log, error: c.error,
  });
  expect(code).toBe(2);
  expect(c.out).toEqual([
    `== ${a}`,
    'src/new.ts missing',
    'verdict: fresh',
    `== ${missing}`,
    `error: cannot read ${missing}`,
    `== ${b}`,
    'src/other.ts missing',
    'verdict: fresh',
    'batch: fresh=2 partly-on-master=0 likely-done=0 errors=1',
  ]);
});

it('reports a failed git probe as an error while a missing path stays fresh', async () => {
  const dir = tempDir();
  const git: JobPrecheckGit = {
    async exists(path: string) {
      if (path === 'src/boom.ts') throw new Error('fatal: bad revision');
      return false;
    },
    async lastCommit() { return null; },
  };
  const boom = draft(dir, 'boom.md', 'src/boom.ts\n');
  const fresh = draft(dir, 'fresh.md', 'src/new.ts\n');
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', boom, fresh, '--json'], { git, log: c.log, error: c.error });
  expect(code).toBe(2);
  const body = JSON.parse(c.out[0]!) as { results: Array<{ verdict?: string; error?: string }> };
  expect(body.results[0]).toMatchObject({ error: 'fatal: bad revision' });
  expect(body.results[0]!.verdict).toBeUndefined();
  expect(body.results[1]).toMatchObject({ verdict: 'fresh' });
  expect(body.results[1]!.error).toBeUndefined();
});

it('refuses malformed and over-limit batches without reading files or probing git', async () => {
  const readFile = vi.fn(async () => 'src/new.ts');
  const git = { exists: vi.fn(async () => false), lastCommit: vi.fn(async () => null) };
  const c = capture();
  const bad: string[][] = [
    ['--batch'],
    ['--batch', '--json'],
    ['--batch', 'a.md', '--batch', 'b.md'],
    ['--batch', 'a.md', '--bogus'],
    ['--batch', 'a.md', '--ref'],
    ['--batch', 'a.md', '--ref', 'bad ref!!'],
    ['--batch', 'a.md', '--json', '--json'],
    ['--batch', ''],
    ['a.md', 'b.md'],
    ['--batch', ...Array.from({ length: 21 }, (_, i) => `d${i}.md`)],
  ];
  for (const args of bad) {
    expect(await cmdFleetJobPrecheck(args, { readFile, git, log: c.log, error: c.error }), JSON.stringify(args)).toBe(2);
  }
  expect(readFile).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
  expect(git.lastCommit).not.toHaveBeenCalled();
  expect(c.out).toEqual([]);
  expect(c.err.length).toBe(bad.length);
  expect(c.err[0]).toContain('--batch');
  c.err.length = 0;
  const twenty = Array.from({ length: 20 }, (_, i) => `d${i}.md`);
  expect(await cmdFleetJobPrecheck(['--batch', ...twenty], { readFile, git, log: c.log, error: c.error })).toBe(0);
  expect(readFile).toHaveBeenCalledTimes(20);
});

it('keeps single-file syntax, output and exit codes unchanged', async () => {
  const dir = tempDir();
  const file = draft(dir, 'job.md', 'Edit src/done.ts and add test/more.test.ts\n');
  const c = capture();
  expect(await cmdFleetJobPrecheck([file, '--json'], { git: fakeGit(BRIDGED), log: c.log, error: c.error })).toBe(3);
  expect(JSON.parse(c.out[0]!)).toMatchObject({ schema: 'fleet.job-precheck.v1', verdict: 'likely-done', newTestFiles: ['test/more.test.ts'] });
  const c2 = capture();
  const fresh = draft(dir, 'fresh.md', 'src/new.ts test/new.test.ts\n');
  expect(await cmdFleetJobPrecheck([fresh], { git: fakeGit({}), log: c2.log, error: c2.error })).toBe(0);
  expect(c2.out).toEqual(['src/new.ts missing', 'test/new.test.ts missing', 'verdict: fresh']);
  const c3 = capture();
  expect(await cmdFleetJobPrecheck([join(dir, 'absent.md')], { git: fakeGit({}), log: c3.log, error: c3.error })).toBe(2);
  expect(c3.err[0]).toContain('error: cannot read');
});

it('checks a batch against a real temp repo with a bridge commit and a genuinely new test path', async () => {
  const dir = tempDir();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Precheck',
    GIT_AUTHOR_EMAIL: 'precheck@example.com',
    GIT_COMMITTER_NAME: 'Precheck',
    GIT_COMMITTER_EMAIL: 'precheck@example.com',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'done.ts'), 'export const done = true;\n');
  git(['add', 'src/done.ts']);
  git(['-c', 'user.name=Precheck', '-c', 'user.email=precheck@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'bridge(RQ-PHX-SP4B1): landed']);
  const done = draft(dir, 'done.md', 'Edit src/done.ts and add test/brand-new-spb1.test.ts\n');
  const fresh = draft(dir, 'fresh.md', 'Create src/never-landed-spb1.ts\n');
  const c = capture();
  const code = await cmdFleetJobPrecheck(['--batch', done, fresh, '--ref', 'HEAD', '--json'], {
    cwd: dir, readFile: (path) => readFile(path, 'utf8'), log: c.log, error: c.error,
  });
  expect(code).toBe(3);
  expect(c.err).toEqual([]);
  const body = JSON.parse(c.out[0]!) as {
    schema: string;
    results: Array<{ file: string; verdict: string; facts: Array<{ path: string; onMaster: boolean; lastCommit?: { subject: string } }>; newTestFiles: string[] }>;
    counts: Record<string, number>;
  };
  expect(body.schema).toBe('fleet.job-precheck-batch.v1');
  expect(body.results.map(r => r.file)).toEqual([done, fresh]);
  expect(body.results[0]!.verdict).toBe('likely-done');
  expect(body.results[0]!.facts[0]).toMatchObject({ path: 'src/done.ts', onMaster: true });
  expect(body.results[0]!.facts[0]!.lastCommit?.subject).toContain('bridge(RQ-PHX-SP4B1)');
  expect(body.results[0]!.newTestFiles).toEqual(['test/brand-new-spb1.test.ts']);
  expect(body.results[1]!.verdict).toBe('fresh');
  expect(body.counts).toEqual({ fresh: 1, 'partly-on-master': 0, 'likely-done': 1, errors: 0 });
});
