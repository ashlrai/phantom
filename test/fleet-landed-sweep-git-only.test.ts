import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLandedSweep } from '../src/cli/fleet-landed-sweep.js';
import { describeGhFailure, gitOnlyLanded } from '../src/core/fleet/landed-git-only.js';

const dirs: string[] = [];
beforeEach(() => {
  // Keep fixtures independent of an operator's secrets CLI that wraps `git fetch`.
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
  vi.stubEnv('PATH', [dirname(gitPath), '/usr/bin', '/bin'].join(delimiter));
});
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An origin and a clone: `shipped` is merged into master, `pending` has a commit master lacks. */
function clone(): string {
  const root = mkdtempSync(join(tmpdir(), 'landed-git-only-')); dirs.push(root);
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'origin.git'); const work = join(root, 'work');
  run(root, 'init', '-q', '--bare', '-b', 'master', origin);
  run(root, 'clone', '-q', origin, work);
  run(work, 'config', 'user.email', 'test@example.com'); run(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'a.txt'), 'first\n'); run(work, 'add', '.'); run(work, 'commit', '-qm', 'first');
  run(work, 'checkout', '-qb', 'shipped'); writeFileSync(join(work, 'a.txt'), 'shipped\n'); run(work, 'commit', '-qam', 'shipped');
  run(work, 'checkout', '-q', 'master'); run(work, 'merge', '-q', '--ff-only', 'shipped');
  run(work, 'checkout', '-qb', 'pending'); writeFileSync(join(work, 'b.txt'), 'pending\n'); run(work, 'add', '.'); run(work, 'commit', '-qm', 'pending');
  run(work, 'checkout', '-q', 'master');
  run(work, 'push', '-q', 'origin', 'master');
  return work;
}

const ghDown = (stderr: string) => async () => ({ ok: false, stdout: '', stderr });

async function sweep(args: string[], deps: Parameters<typeof cmdFleetLandedSweep>[1]) {
  const out: string[] = [];
  const code = await cmdFleetLandedSweep(['--json', ...args], { output: t => out.push(t), error: () => {}, ...deps });
  return { code, report: JSON.parse(out.at(-1)!) as Record<string, unknown> };
}

describe('describeGhFailure', () => {
  it('names the cause in plain words', () => {
    expect(describeGhFailure({ stderr: '', missing: true }).reason).toBe('gh not installed');
    expect(describeGhFailure({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).reason).toBe('gh not signed in');
    expect(describeGhFailure({ stderr: 'dial tcp: lookup api.github.com: could not resolve host' }).reason).toBe('network unreachable');
    expect(describeGhFailure({ stderr: '\nGraphQL: repository not found\nmore' })).toEqual({ kind: 'error', reason: 'gh failed: GraphQL: repository not found' });
  });
});

describe('gitOnlyLanded', () => {
  it('marks a branch landed when origin/master already has all its commits, and not otherwise', async () => {
    const result = await gitOnlyLanded({ repoDir: clone() });
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    const byName = Object.fromEntries(result.branches.map(b => [b.name, b]));
    expect(byName['shipped']).toMatchObject({ landed: true, ahead: 0 });
    expect(byName['pending']).toMatchObject({ landed: false, ahead: 1 });
    expect(byName['master']).toBeUndefined();
  });

  it('is skipped outside a git clone and failed when the fetch fails', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'landed-plain-')); dirs.push(plain);
    expect(await gitOnlyLanded({ repoDir: plain })).toEqual({ state: 'skipped', reason: `not a git clone: ${plain}` });
    const work = clone();
    execFileSync('git', ['remote', 'set-url', 'origin', join(work, 'no-such-remote')], { cwd: work });
    const failed = await gitOnlyLanded({ repoDir: work });
    expect(failed.state).toBe('failed');
    expect(failed.state === 'failed' && failed.reason).toMatch(/^git fetch failed: \S/);
  });
});

describe('landed-sweep without gh', () => {
  it('gh missing: uses git only, step ok, reports the landed branch', async () => {
    const { code, report } = await sweep([], { gh: ghDown('gh: command not found'), repoDir: clone() });
    expect(code).toBe(0);
    expect(report).toMatchObject({ state: 'ok', mode: 'git-only', landed: 1, inspected: 2, landedBranches: ['shipped'], reason: 'gh not installed; used git' });
  });

  it('gh signed out: same git-only path with its own reason', async () => {
    const { code, report } = await sweep([], { gh: ghDown('run gh auth login'), repoDir: clone() });
    expect(code).toBe(0);
    expect(report).toMatchObject({ mode: 'git-only', reason: 'gh not signed in; used git' });
  });

  it('gh missing and no git clone: skipped with a reason, not failed', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'landed-plain-')); dirs.push(plain);
    const { code, report } = await sweep([], { gh: ghDown('gh: command not found'), repoDir: plain });
    expect(code).toBe(0);
    expect(report).toMatchObject({ state: 'skipped', mode: 'git-only' });
    expect(report['reason']).toMatch(/^gh not installed; not a git clone/);
  });

  it('gh error: the reason is surfaced and the step fails', async () => {
    const { code, report } = await sweep([], { gh: ghDown('GraphQL: repository not found'), repoDir: clone() });
    expect(code).toBe(1);
    expect(report).toMatchObject({ state: 'failed', mode: 'gh', error: 'gh failed: GraphQL: repository not found' });
  });

  it('git fetch failure on the fallback path is a failed step with the first line', async () => {
    const work = clone();
    execFileSync('git', ['remote', 'set-url', 'origin', join(work, 'no-such-remote')], { cwd: work });
    const { code, report } = await sweep([], { gh: ghDown('could not resolve host'), repoDir: work });
    expect(code).toBe(1);
    expect(String(report['error'])).toMatch(/^network unreachable; git fetch failed: \S/);
  });
});
