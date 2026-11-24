import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdDoctorBuild } from '../src/cli/doctor-build.js';
import { readBuildLive } from '../src/core/fleet/build-live.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'build-fetch-7954-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function fixture(branch = 'master') {
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const other = join(dir, 'other');
  mkdirSync(origin); git(origin, 'init', '-q', '--bare', '-b', branch);
  mkdirSync(work); git(work, 'init', '-q', '-b', branch); git(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'tracked'), 'original\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'initial'); git(work, 'push', '-q', 'origin', branch);
  const sha = git(work, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(other, `new-${i}`), `new ${i}\n`);
    git(other, 'add', '.'); git(other, 'commit', '-q', '-m', `new-${i}`);
  }
  git(other, 'push', '-q', 'origin', branch);
  return { work, sha };
}
const read = (work: string, fetch = false) => readBuildLive({ codeDir: work, now: () => 0, readBuiltSha: () => null, fetch });
const snapshot = (work: string) => ({
  head: git(work, 'rev-parse', 'HEAD'),
  index: readFileSync(join(work, '.git', 'index')),
  tracked: readFileSync(join(work, 'tracked')),
  untracked: readFileSync(join(work, 'untracked')),
});

it('distinguishes stale local and fetched refs without changing checkout bytes', () => {
  const { work, sha } = fixture();
  writeFileSync(join(work, 'tracked'), 'staged\n'); git(work, 'add', 'tracked');
  writeFileSync(join(work, 'tracked'), 'dirty\n'); writeFileSync(join(work, 'untracked'), 'untracked\n');
  const before = snapshot(work);
  const local = read(work);
  expect(local.refFreshness).toBe('local');
  expect(local.behind).toMatchObject({ state: 'known', count: 0, ref: 'origin/master' });
  expect(git(work, 'rev-parse', 'origin/master')).toBe(sha);
  expect(snapshot(work)).toEqual(before);
  const fetched = read(work, true);
  expect(fetched.refFreshness).toBe('fetched');
  expect(fetched.behind).toMatchObject({ state: 'known', count: 2, ref: 'origin/master' });
  expect(snapshot(work)).toEqual(before);
});

it('uses freshly fetched main even when an obsolete origin/master exists', () => {
  const { work, sha } = fixture('main');
  git(work, 'update-ref', 'refs/remotes/origin/master', sha);
  const result = read(work, true);
  expect(result.refFreshness).toBe('fetched');
  expect(result.behind).toMatchObject({ state: 'known', count: 2, ref: 'origin/main' });
  expect(git(work, 'rev-parse', 'origin/master')).toBe(sha);
  expect(git(work, 'rev-parse', 'HEAD')).toBe(sha);
});

it('reports failed fetch and uncertainty while retaining local evidence', () => {
  const { work } = fixture();
  expect(read(work, true).behind).toMatchObject({ state: 'known', count: 2 });
  git(work, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  const result = read(work, true);
  expect(result.refFreshness).toBe('fetch-failed');
  expect(result.behind).toMatchObject({ state: 'known', count: 2, ref: 'origin/master' });
  expect(result.verdict).toContain('fetching origin failed');
  expect(result.verdict).toContain('may be stale');
});

it('CLI JSON passes the opt-in through to the real reader', async () => {
  const { work } = fixture();
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
  const reader = (opts: { fetch: boolean }) => read(work, opts.fetch);
  expect(await cmdDoctorBuild(['--json'], reader)).toBe(0);
  const local = JSON.parse(output.pop()!);
  expect(local.refFreshness).toBe('local');
  expect(local.behind).toMatchObject({ state: 'known', count: 0, ref: 'origin/master' });
  expect(await cmdDoctorBuild(['--fetch', '--json'], reader)).toBe(0);
  const fetched = JSON.parse(output.pop()!);
  expect(fetched.refFreshness).toBe('fetched');
  expect(fetched.behind).toMatchObject({ state: 'known', count: 2, ref: 'origin/master' });
  expect(fetched.behind).toEqual(read(work, true).behind);
});
