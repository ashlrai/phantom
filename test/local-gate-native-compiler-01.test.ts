import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLocalGate, type LocalGateDeps, type LocalGateExecResult } from '../src/core/fleet/local-gate.js';

type Call = [command: string, args: string[], cwd: string];
const sha = (letter: string) => letter.repeat(40);

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'local-gate-native-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

/** A throwaway worktree layout; only the presence of node_modules/.bin/tsgo varies. */
async function fakeRepo(name: string, withTsgo: boolean): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '// installed tsc\n');
  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
  if (withTsgo) await writeFile(join(dir, 'node_modules', '.bin', 'tsgo'), '#!/bin/sh\n');
  return dir;
}

/** Records every child call; git answers fixed SHAs, other steps use isOk. */
function harness(isOk: (command: string, args: string[]) => boolean = () => true) {
  const calls: Call[] = [];
  const exec = vi.fn(async (command: string, args: string[], cwd: string): Promise<LocalGateExecResult> => {
    calls.push([command, args, cwd]);
    return { ok: isOk(command, args), stdout: command === 'git' ? sha(args[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
  });
  const deps = (cwd: string): LocalGateDeps =>
    ({ exec, cwd, metricsPath: join(root, 'metrics.jsonl'), appendMetric: vi.fn(async () => {}) });
  return { exec, calls, deps };
}

describe('local-gate native compiler selection', () => {
  it('invokes the installed tsgo with literal argv and no npx when the worktree has it', async () => {
    const dir = await fakeRepo('repo', true);
    const { exec, calls, deps } = harness();
    const report = await runLocalGate(180, deps(dir));
    expect(report.verdict).toBe('pass');
    expect(report.steps.map(step => step.name)).toEqual(['typecheck', 'verify-changed']);
    expect(calls).toEqual([
      ['git', ['rev-parse', 'HEAD'], dir],
      ['git', ['merge-base', 'HEAD', 'origin/master'], dir],
      [join(dir, 'node_modules', '.bin', 'tsgo'), ['--noEmit', '-p', 'tsconfig.json'], dir],
      ['node', ['scripts/verify-changed.mjs'], dir],
    ]);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(calls.map(call => call[0])).not.toContain('npx');
  });

  it('runs the installed tsc entrypoint under node when tsgo is absent', async () => {
    const dir = await fakeRepo('repo', false);
    const { calls, deps } = harness();
    const report = await runLocalGate(180, deps(dir));
    expect(report.verdict).toBe('pass');
    expect(calls).toEqual([
      ['git', ['rev-parse', 'HEAD'], dir],
      ['git', ['merge-base', 'HEAD', 'origin/master'], dir],
      ['node', [join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], dir],
      ['node', ['scripts/verify-changed.mjs'], dir],
    ]);
  });

  it('resolves the compiler from each gate cwd rather than shared tooling', async () => {
    const native = await fakeRepo('native', true);
    const plain = await fakeRepo('plain', false);
    const { calls, deps } = harness();
    expect((await runLocalGate(180, deps(native))).verdict).toBe('pass');
    expect((await runLocalGate(180, deps(plain))).verdict).toBe('pass');
    expect(calls[2]).toEqual([join(native, 'node_modules', '.bin', 'tsgo'), ['--noEmit', '-p', 'tsconfig.json'], native]);
    expect(calls[6]).toEqual(['node', [join(plain, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], plain]);
  });

  it('keeps a nonzero tsgo result as a failed gate without retrying tsc', async () => {
    const dir = await fakeRepo('repo', true);
    const tsgo = join(dir, 'node_modules', '.bin', 'tsgo');
    const { exec, calls, deps } = harness(command => command !== tsgo);
    const report = await runLocalGate(180, deps(dir));
    expect(report.verdict).toBe('fail');
    expect(report.steps).toEqual([
      { name: 'typecheck', ok: false, seconds: expect.any(Number) },
      { name: 'verify-changed', ok: true, seconds: expect.any(Number) },
    ]);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(calls.filter(call => call[0] === 'node')).toEqual([['node', ['scripts/verify-changed.mjs'], dir]]);
  });

  it('keeps a tsgo launch failure as a failed gate without retrying tsc', async () => {
    const dir = await fakeRepo('repo', true);
    const tsgo = join(dir, 'node_modules', '.bin', 'tsgo');
    const { exec, calls, deps } = harness();
    exec.mockImplementation(async (command, args, cwd) => {
      calls.push([command, args, cwd]);
      if (command === tsgo) throw new Error('spawn EACCES');
      return { ok: true, stdout: command === 'git' ? sha(args[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
    });
    const report = await runLocalGate(180, deps(dir));
    expect(report.verdict).toBe('fail');
    expect(report.steps.map(step => [step.name, step.ok])).toEqual([['typecheck', false], ['verify-changed', true]]);
    expect(calls.filter(call => call[0] === 'node')).toEqual([['node', ['scripts/verify-changed.mjs'], dir]]);
  });

  it('keeps a nonzero tsc result as a failed gate', async () => {
    const dir = await fakeRepo('repo', false);
    const { deps } = harness((_command, args) => !args.includes('--noEmit'));
    const report = await runLocalGate(180, deps(dir));
    expect(report.verdict).toBe('fail');
    expect(report.steps[0]).toMatchObject({ name: 'typecheck', ok: false });
    expect(report.steps[1]).toMatchObject({ name: 'verify-changed', ok: true });
  });

  it('keeps git identity, budget and metric-row semantics unchanged', async () => {
    const dir = await fakeRepo('repo', true);
    let elapsed = 0;
    const exec = vi.fn(async (command: string, args: string[]) => {
      elapsed += 1;
      return { ok: true, stdout: command === 'git' ? sha(args[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
    });
    const appendMetric = vi.fn(async () => {});
    const metricsPath = join(root, 'metrics.jsonl');
    const report = await runLocalGate(3, { exec, cwd: dir, now: () => elapsed, metricsPath, appendMetric });
    expect(report).toMatchObject({ verdict: 'fail', headSha: sha('a'), baseSha: sha('b') });
    expect(report.steps.at(-1)).toEqual({ name: 'budget', ok: false, seconds: 4 });
    expect(appendMetric).toHaveBeenCalledExactlyOnceWith(metricsPath, JSON.stringify(report) + '\n');
  });
});
