import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctorBuild } from '../src/cli/doctor-build.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { readBuildLive } from '../src/core/fleet/build-live.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'build-fetch-743s-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(branch = 'master') {
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const publisher = join(root, 'publisher');
  git(root, 'init', '--bare', '-q', '-b', branch, origin);
  git(root, 'clone', '-q', origin, work);
  writeFileSync(join(work, 'tracked'), 'original\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial');
  git(work, 'push', '-q', 'origin', branch);
  git(root, 'clone', '-q', origin, publisher);
  writeFileSync(join(publisher, 'new'), 'shipped\n');
  git(publisher, 'add', '.'); git(publisher, 'commit', '-qm', 'shipped');
  git(publisher, 'push', '-q', 'origin', branch);
  const read = (opts: { fetch: boolean }) => readBuildLive({
    codeDir: work, readBuiltSha: () => null, ...opts,
  });
  return { origin, work, read };
}

function snapshot(work: string) {
  return {
    head: git(work, 'rev-parse', 'HEAD'),
    branch: git(work, 'symbolic-ref', 'HEAD'),
    index: readFileSync(join(work, '.git', 'index')).toString('base64'),
    staged: git(work, 'diff', '--cached', '--binary'),
    unstaged: git(work, 'diff', '--binary'),
    untracked: readFileSync(join(work, 'untracked'), 'utf8'),
  };
}

describe('build fetch recovery through the reader and CLI', () => {
  it('keeps default offline and reveals hidden shipped commits without changing dirty state', async () => {
    const { work, read } = fixture();
    // An explicit destination must work even without remote.origin.fetch configuration.
    git(work, 'config', '--unset-all', 'remote.origin.fetch');
    writeFileSync(join(work, 'tracked'), 'staged\n'); git(work, 'add', 'tracked');
    writeFileSync(join(work, 'tracked'), 'unstaged\n');
    writeFileSync(join(work, 'untracked'), 'keep me\n');
    const before = snapshot(work);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { output.push(s); });
    const stale = git(work, 'rev-parse', 'origin/master');
    expect(await cmdDoctorBuild(['--json'], read)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ refFreshness: 'local', behind: { count: 0 } });
    expect(git(work, 'rev-parse', 'origin/master')).toBe(stale);
    expect(await cmdDoctorBuild(['--fetch', '--json'], read)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ refFreshness: 'fetched', behind: { count: 1, ref: 'origin/master' } });
    expect(git(work, 'rev-parse', 'origin/master')).not.toBe(stale);
    expect(snapshot(work)).toEqual(before);
  });

  it('counts the fetched main ref even when an obsolete local master ref exists', () => {
    const { work, read } = fixture('main');
    git(work, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    expect(read({ fetch: true })).toMatchObject({ refFreshness: 'fetched', behind: { count: 1, ref: 'origin/main' } });
  });

  it('reports failed fetch honestly in JSON and plain CLI output', async () => {
    const { work, read } = fixture();
    git(work, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { output.push(s); });
    expect(await cmdDoctorBuild(['--fetch', '--json'], read)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ refFreshness: 'fetch-failed', behind: { count: 0 } });
    expect(await cmdDoctorBuild(['--fetch'], read)).toBe(0);
    expect(output[0]).toContain('fetching origin failed');
    expect(output[0]).toContain('may be stale');
  });

  it('default CLI invocation never calls fetch, including when origin is unavailable', async () => {
    const { work } = fixture();
    git(work, 'remote', 'set-url', 'origin', join(root, 'unavailable.git'));
    const calls: string[][] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdDoctorBuild([], opts => readBuildLive({ codeDir: work, readBuiltSha: () => null, ...opts,
      git: (cwd, args) => { calls.push(args); return git(cwd, ...args); },
    }));
    expect(calls.some(args => args[0] === 'fetch')).toBe(false);
  });

  it('bounds each fetch attempt and preserves the registered help change', () => {
    const { work } = fixture();
    const attempts: { args: string[]; timeout: number | undefined }[] = [];
    const report = readBuildLive({ codeDir: work, fetch: true, readBuiltSha: () => null,
      git: (cwd, args, timeout) => {
        if (args[0] === 'fetch') { attempts.push({ args, timeout }); return null; }
        return git(cwd, ...args);
      },
    });
    expect(attempts).toEqual(['master', 'main'].map(branch => ({ timeout: 30_000, args: [
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ] })));
    expect(report.refFreshness).toBe('fetch-failed');
    expect(HELP_ENTRIES.find(e => e.cmd.startsWith('doctor build '))?.cmd).toContain('--fetch');
  });
});
