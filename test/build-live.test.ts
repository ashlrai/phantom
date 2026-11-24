import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctorBuild } from '../src/cli/doctor-build.js';
import { buildLiveLines, readBuildLive } from '../src/core/fleet/build-live.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'build-live-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const commit = (name: string): string => { writeFileSync(join(dir, name), name); git('add', '.'); git('commit', '-q', '-m', name); return git('rev-parse', 'HEAD'); };
/** A repo whose origin/master ref sits `ahead` commits after the checked-out commit. */
function repo(ahead: number): { sha: string } {
  git('init', '-q', '-b', 'work');
  const sha = commit('first');
  for (let i = 0; i < ahead; i++) commit(`later-${i}`);
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  git('reset', '-q', '--hard', sha);
  return { sha };
}
const read = (extra: Parameters<typeof readBuildLive>[0] = {}) => readBuildLive({ codeDir: dir, now: () => 0, readBuiltSha: () => null, ...extra });

describe('phm doctor build', () => {
  it('up to date', () => {
    git('init', '-q', '-b', 'master');
    const sha = commit('first');
    git('update-ref', 'refs/remotes/origin/master', sha);
    const r = read();
    expect(r.schema).toBe('doctor.build.v1');
    expect(r.commit).toEqual({ state: 'known', sha, source: 'git' });
    expect(r.behind).toEqual({ state: 'known', count: 0, ref: 'origin/master', since: null });
    expect(r.verdict).toBe(`live build is up to date with master (${sha.slice(0, 7)} on master)`);
  });

  it('N behind', () => {
    repo(3);
    const r = read();
    expect(r.branch).toEqual({ state: 'known', name: 'work' });
    expect(r.behind).toMatchObject({ state: 'known', count: 3 });
    // `since` is when the oldest missing commit merged (a real ISO time), so the card can say "since Nov 12".
    expect(r.behind.state === 'known' && Number.isFinite(Date.parse(r.behind.since ?? ''))).toBe(true);
    expect(r.verdict).toBe('live build is 3 commits behind master on work; merged fleet features may not be running');
    expect(buildLiveLines(r)[1]).toContain('HEAD of');
  });

  it('one commit behind uses the singular', () => {
    repo(1);
    expect(read().verdict).toContain('1 commit behind master');
  });

  it('detached head', () => {
    const { sha } = repo(2);
    git('checkout', '-q', '--detach', sha);
    const r = read();
    expect(r.branch).toEqual({ state: 'known', name: 'detached' });
    expect(r.verdict).toBe('live build is 2 commits behind master on a detached head; merged fleet features may not be running');
  });

  it('a commit embedded at build time wins over HEAD', () => {
    const { sha } = repo(2);
    commit('extra-after-build');
    const r = read({ readBuiltSha: () => sha });
    expect(r.commit).toEqual({ state: 'known', sha, source: 'build' });
    expect(r.behind).toMatchObject({ state: 'known', count: 2 });
  });

  it('not a git directory stays unknown with the reason', () => {
    mkdirSync(join(dir, 'plain'));
    const r = readBuildLive({ codeDir: join(dir, 'plain'), now: () => 0, readBuiltSha: () => null });
    expect(r.commit.state).toBe('unknown');
    expect(r.branch).toEqual({ state: 'unknown', why: 'not a git checkout' });
    expect(r.verdict).toContain('live build is unknown');
    expect(r.verdict).toContain('not a git checkout');
  });

  it('a subdirectory of someone else\'s repo is not a checkout', () => {
    repo(1);
    mkdirSync(join(dir, 'inner'));
    const r = readBuildLive({ codeDir: join(dir, 'inner'), now: () => 0, readBuiltSha: () => null });
    expect(r.commit.state).toBe('unknown');
  });

  it('no local master ref: behind is unknown, not zero', () => {
    git('init', '-q', '-b', 'work');
    commit('first');
    const r = read();
    expect(r.behind).toEqual({ state: 'unknown', why: 'no local origin/master ref (nothing fetched yet)' });
    expect(r.verdict).toContain('how far behind master is unknown');
  });

  it('a built commit missing from the checkout is unknown, not zero', () => {
    repo(1);
    const r = read({ readBuiltSha: () => 'a'.repeat(40) });
    expect(r.behind.state).toBe('unknown');
  });

  it('never runs a git command that changes the checkout', () => {
    repo(1);
    const seen: string[] = [];
    read({ git: (cwd, args) => { seen.push(args[0]!); return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } });
    expect(seen.filter(c => !['rev-parse', 'symbolic-ref', 'rev-list', 'log'].includes(c))).toEqual([]);
  });

  describe('--fetch', () => {
    /** A work repo whose origin (a bare repo) has `ahead` commits the local origin/master ref has never seen. */
    function staleClone(ahead: number): { sha: string } {
      const origin = join(dir, 'origin.git');
      const work = join(dir, 'work');
      const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
      mkdirSync(origin); g(origin, 'init', '-q', '--bare', '-b', 'master');
      mkdirSync(work); g(work, 'init', '-q', '-b', 'master'); g(work, 'remote', 'add', 'origin', origin);
      writeFileSync(join(work, 'a'), 'a'); g(work, 'add', '.'); g(work, 'commit', '-q', '-m', 'a');
      g(work, 'push', '-q', 'origin', 'master');
      const sha = g(work, 'rev-parse', 'HEAD');
      // Master moves on origin; the work repo never fetches.
      const other = join(dir, 'other'); execFileSync('git', ['clone', '-q', origin, other]);
      for (let i = 0; i < ahead; i++) { writeFileSync(join(other, `n${i}`), 'n'); g(other, 'add', '.'); g(other, 'commit', '-q', '-m', `n${i}`); }
      g(other, 'push', '-q', 'origin', 'master');
      return { sha };
    }
    const at = (codeDir: string, extra: Parameters<typeof readBuildLive>[0] = {}) => readBuildLive({ codeDir, now: () => 0, readBuiltSha: () => null, ...extra });

    it('without it, a host that never fetches reads current while master moved', () => {
      staleClone(2);
      const r = at(join(dir, 'work'));
      expect(r.behind).toMatchObject({ state: 'known', count: 0 });
      expect(r.refFreshness).toBe('local');
    });

    it('refreshes the master ref and counts what the stale ref hid, leaving the checkout alone', () => {
      const { sha } = staleClone(2);
      const r = at(join(dir, 'work'), { fetch: true });
      expect(r.refFreshness).toBe('fetched');
      expect(r.behind).toMatchObject({ state: 'known', count: 2, ref: 'origin/master' });
      expect(r.verdict).toBe(`live build is 2 commits behind master on master; merged fleet features may not be running`);
      expect(execFileSync('git', ['-C', join(dir, 'work'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(sha);
    });

    it('a failed fetch keeps the local ref and says so', () => {
      repo(1);
      git('remote', 'add', 'origin', join(dir, 'nowhere.git'));
      const r = read({ fetch: true });
      expect(r.refFreshness).toBe('fetch-failed');
      expect(r.behind).toMatchObject({ state: 'known', count: 1 });
      expect(r.verdict).toContain('1 commit behind master');
      expect(r.verdict).toContain('fetching origin failed');
    });

    it('does not fetch outside a git checkout', () => {
      mkdirSync(join(dir, 'plain'));
      const seen: string[] = [];
      at(join(dir, 'plain'), { fetch: true, git: (_c, a) => { seen.push(a[0]!); return null; } });
      expect(seen).not.toContain('fetch');
    });

    it('the CLI passes --fetch through and still rejects unknown flags', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const seen: boolean[] = [];
      const stub = (o: { fetch: boolean }) => { seen.push(o.fetch); return read(); };
      await cmdDoctorBuild([], stub); await cmdDoctorBuild(['--fetch', '--json'], stub);
      expect(seen).toEqual([false, true]);
      expect(await cmdDoctorBuild(['--fetch', '--bogus'], stub)).toBe(2);
    });
  });

  it('prints plain words and JSON, rejects other flags', async () => {
    const report = read();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDoctorBuild([], () => report)).toBe(0);
    expect(out[0]).toBe(report.verdict);
    out.length = 0;
    expect(await cmdDoctorBuild(['--json'], () => report)).toBe(0);
    expect(JSON.parse(out[0]!).schema).toBe('doctor.build.v1');
    expect(await cmdDoctorBuild(['--bogus'], () => report)).toBe(2);
  });
});
