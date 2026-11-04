import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';

const draft = 'Edit src/done.ts and test/new.test.ts\n';
const bytes = (value: string) => Buffer.from(value, 'utf8');
const stream = (value: Uint8Array) => async function* () { yield value; };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function capture() {
  const out: string[] = [];
  const errors: string[] = [];
  return { out, errors, log: (line: string) => out.push(line), error: (line: string) => errors.push(line) };
}
function fakeGit() {
  return {
    exists: vi.fn(async (path: string) => path === 'src/done.ts'),
    lastCommit: vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-PHX-TEST1): landed' })),
  };
}

it('matches the file report, exit and exact job identity evidence', async () => {
  const git = fakeGit();
  const a = capture();
  const b = capture();
  const options = ['--ref', 'feature/test', '--job-id', 'RQ-PHX-TEST1', '--json'];
  const fromFile = await cmdFleetJobPrecheck(['draft.md', ...options], { ...a, git, readFile: async () => draft });
  const fromStdin = await cmdFleetJobPrecheck(['-', ...options], { ...b, git, readStdin: stream(bytes(draft)) });
  expect(fromStdin).toBe(fromFile);
  expect(fromStdin).toBe(3);
  expect(b.out).toEqual(a.out);
  expect(JSON.parse(b.out[0]!)).toMatchObject({ jobId: 'RQ-PHX-TEST1', facts: [{ jobIdMatch: true }, { jobIdMatch: null }], newTestFiles: ['test/new.test.ts'] });
});

it('rejects bad arguments and batch stdin before reading or probing; help never reads', async () => {
  const readStdin = vi.fn(stream(bytes(draft)));
  const readFile = vi.fn(async () => draft);
  const git = fakeGit();
  const c = capture();
  expect(await cmdFleetJobPrecheck(['--help'], { ...c, readStdin, readFile, git })).toBe(0);
  expect(c.out[0]).toContain('8000 bytes');
  for (const args of [[], ['--batch', '-'], ['-', '--batch'], ['--batch', 'a.md', '-'], ['-', '--bad'], ['-', '--ref', '-bad'], ['-', '--job-id', 'bad'], ['-', '--json', '--json']]) {
    expect(await cmdFleetJobPrecheck(args, { ...c, readStdin, readFile, git })).toBe(2);
  }
  expect(readStdin).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
});

it('retains file and batch behavior', async () => {
  const readFile = vi.fn(async () => draft);
  const readStdin = vi.fn(stream(bytes(draft)));
  const git = fakeGit();
  const c = capture();
  expect(await cmdFleetJobPrecheck(['draft.md', '--json'], { ...c, readFile, readStdin, git })).toBe(3);
  expect(await cmdFleetJobPrecheck(['--batch', 'one.md', 'two.md', '--json'], { ...c, readFile, readStdin, git })).toBe(3);
  expect(JSON.parse(c.out[1]!).results).toHaveLength(2);
  expect(readFile).toHaveBeenCalledTimes(3);
  expect(readStdin).not.toHaveBeenCalled();
});

it('enforces byte boundaries, valid UTF-8, nonempty input and read errors without git', async () => {
  const git = fakeGit();
  const c = capture();
  const valid = 'é'.repeat(4000);
  expect(await cmdFleetJobPrecheck(['-'], { ...c, git, readStdin: stream(bytes(valid)) })).toBe(0);
  let continued = false;
  async function* oversized() { yield bytes(valid); yield bytes('é'); continued = true; yield bytes(draft); }
  async function* broken(): AsyncGenerator<Uint8Array> { yield bytes('partial'); throw new Error('secret draft text'); }
  for (const source of [oversized, stream(bytes(' ')), stream(new Uint8Array([0xff])), broken]) {
    expect(await cmdFleetJobPrecheck(['-'], { ...c, git, readStdin: source })).toBe(2);
  }
  expect(continued).toBe(false);
  expect(git.exists).not.toHaveBeenCalled();
  expect(c.errors.join(' ')).not.toContain('secret draft text');
});

it('pipes into the source CLI using the requested ref in an isolated repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-stdin-'));
  dirs.push(dir);
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/done.ts'), 'done\n');
  git(['add', 'src/done.ts']);
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'bridge(RQ-PHX-TEST1): landed']);
  const cli = resolve('src/cli/index.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const result = spawnSync(tsx, [cli, 'fleet', 'job-precheck', '-', '--ref', 'HEAD', '--job-id', 'RQ-PHX-TEST1', '--json'], { cwd: dir, env, input: draft, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'likely-done', facts: [{ jobIdMatch: true }, { jobIdMatch: null }], newTestFiles: ['test/new.test.ts'] });
});
