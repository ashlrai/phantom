import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runJobChanges, type JobChangesDependencies } from '../examples/agents/job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'agent-changes-'));
  roots.push(homeDir);
  const runsDir = join(homeDir, 'runs');
  const worktree = join(homeDir, 'worktree');
  await mkdir(runsDir);
  await mkdir(worktree);
  await writeFile(join(runsDir, 'RQ-TEST.base'), `abcdef0 branch ${worktree}\n`);
  return { homeDir, runsDir, worktree };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
async function command(args: string[], deps: JobChangesDependencies = {}) {
  let output = '';
  const code = await runJobChanges(args, { ...deps, write: text => { output += text; } });
  return { code, output, json: JSON.parse(output) };
}

it('returns the desktop projection for renamed and binary files through a fake git runner', async () => {
  const { homeDir, runsDir } = await fixture();
  const runner = vi.fn<GitRunner>(async (_bin, args) => ok(args[0] === 'diff'
    ? '3\t1\t\0old name.ts\0new name.ts\0-\t-\timage.bin\0'
    : '2 R. N... 100644 100644 100644 abc abc R100 new name.ts\0old name.ts\0'));
  const result = await command(['--job', 'RQ-TEST'], { readerOptions: { homeDir, runsDir, runner } });
  expect(result.code).toBe(0);
  expect(result.json).toMatchObject({ schema: 'fleet.job.changes.v1', job: 'RQ-TEST', state: 'live', baseSha: 'abcdef0', truncated: false,
    files: [{ path: 'new name.ts', status: 'renamed', added: 3, removed: 1 }, { path: 'image.bin', status: 'modified', added: null, removed: null }],
    totals: { files: 2, added: 3, removed: 1 } });
  expect(result.output).not.toContain(homeDir);
  expect(runner).toHaveBeenCalledTimes(2);
});

it('distinguishes a clean tree, a missing job and a degraded read', async () => {
  const { homeDir, runsDir } = await fixture();
  const runner: GitRunner = async () => ok();
  const readerOptions = { homeDir, runsDir, runner };
  const clean = await command(['--job', 'RQ-TEST'], { readerOptions });
  expect(clean.code).toBe(0);
  expect(clean.json).toMatchObject({ state: 'live', files: [], totals: { files: 0, added: 0, removed: 0 } });
  const missing = await command(['--job', 'RQ-MISSING'], { readerOptions });
  expect(missing.code).toBe(1);
  expect(missing.json).toMatchObject({ state: 'missing', files: [] });
  const degraded = await command(['--job', 'RQ-TEST'], { readerOptions: { homeDir, runsDir,
    runner: async (_bin, args) => args[0] === 'diff' ? ok('2\t0\tfile.ts\0') : { ...ok(), code: 1 } } });
  expect(degraded.code).toBe(1);
  expect(degraded.json).toMatchObject({ state: 'degraded', files: [{ path: 'file.ts', added: 2 }] });
  const truncated = await command(['--job', 'RQ-TEST'], { readerOptions: { homeDir, runsDir,
    runner: async () => ({ ...ok(), truncated: true }) } });
  expect(truncated.code).toBe(1);
  expect(truncated.json).toMatchObject({ state: 'degraded', truncated: true });
});

it('rejects invalid input without calling the reader or accepting a path', async () => {
  const read = vi.fn<NonNullable<JobChangesDependencies['read']>>();
  for (const args of [[], ['--job'], ['--job', '../bad'], ['--job', 'RQ-TEST', '--path', '/tmp'], ['--job', 'RQ-TEST', '--job', 'OTHER']]) {
    const result = await command(args, { read });
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ error: 'usage: --job <fleet-job-id>' });
  }
  expect(read).not.toHaveBeenCalled();
});

it('does not disclose unexpected reader errors', async () => {
  const result = await command(['--job', 'RQ-TEST'], { read: async () => { throw new Error('private path'); } });
  expect(result.code).toBe(1);
  expect(result.json).toEqual({ error: 'job changes unavailable' });
  expect(result.output).not.toContain('private path');
});

it('runs directly as a standalone script with an isolated home', async () => {
  const { homeDir } = await fixture();
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('examples/agents/job-changes.ts'), '--job', 'RQ-MISSING'],
    { env: { PATH: process.env.PATH, HOME: homeDir }, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ job: 'RQ-MISSING', state: 'missing' });
});
