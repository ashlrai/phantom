import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianManifestSet } from '../src/cli/fleet-guardian-manifest-set.js';
import type { GuardianManifestEntry } from '../src/core/fleet/guardian-manifest.js';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import type { DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const passResult = (): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal: 'pass', reason: 'verified', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: null, cleanup: 'removed', recordDisposition: 'recorded' });

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const tempdir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// master history: root commit (skipped), one direct single-parent commit, one
// --no-ff two-parent merge whose subject ends "(#<pr>)" — each repo yields a
// squash-style binding then a merge binding, oldest first.
function makeRepo(prefix: string, pr: number): string {
  const dir = tempdir(prefix);
  git(dir, 'init', '-q', '--template=', '--initial-branch=master');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'root commit');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'feature.txt'), 'two\n');
  git(dir, 'add', 'feature.txt');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'feature work');
  git(dir, 'checkout', '-q', 'master');
  writeFileSync(join(dir, 'main.txt'), 'three\n');
  git(dir, 'add', 'main.txt');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'direct master change');
  git(dir, 'merge', '--no-ff', '--no-verify', '-m', `merge feature (#${pr})`, 'feature');
  return dir;
}

const reposFile = (dir: string, spec: unknown): string => {
  const path = join(dir, 'repos.json');
  writeFileSync(path, typeof spec === 'string' ? spec : JSON.stringify(spec));
  return path;
};
const mute = () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
};

describe('cmdFleetGuardianManifestSet', () => {
  it('folds two repos into one bounded manifest the guardian reader accepts', async () => {
    const phantom = makeRepo('guardian-set-phantom-', 7);
    const support = makeRepo('guardian-set-support-', 42);
    const dir = tempdir('guardian-set-out-');
    const out = join(dir, 'manifest.json');
    const file = reposFile(dir, [{ repo: phantom }, { repo: support, branch: 'master' }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetGuardianManifestSet(['--repos-file', file, '--out', out, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0])) as { written: number; out: string; repos: { repo: string; branch: string; entries: number }[] };
    expect(report).toMatchObject({ written: 4, out, repos: [
      { repo: phantom, branch: 'master', entries: 2 },
      { repo: support, branch: 'master', entries: 2 },
    ] });
    const manifest = JSON.parse(readFileSync(out, 'utf8')) as GuardianManifestEntry[];
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // Stable input order (phantom then support); each pair stays oldest-first.
    expect(manifest.map(e => e.repo)).toEqual([phantom, phantom, support, support]);
    for (const [repo, pr] of [[phantom, 'pr-7'], [support, 'pr-42']] as const) {
      const [direct, merge] = manifest.filter(e => e.repo === repo);
      expect(direct!.candidateHead).toBe(direct!.mergeCommit); // squash binding
      expect(direct!.baseHead).toBe(git(repo, 'rev-parse', `${direct!.mergeCommit}^`));
      expect(direct!.proposalId).toBe(`commit-${direct!.mergeCommit.slice(0, 12)}`);
      expect(merge!.proposalId).toBe(pr); // two-parent merge binding
      expect(merge!.baseHead).toBe(direct!.mergeCommit);
      expect(merge!.candidateHead).toBe(git(repo, 'rev-parse', 'feature'));
    }
    expect(String(log.mock.calls.at(-1)![0])).not.toContain('feature work'); // no subjects printed
    const run = vi.fn(async () => passResult());
    const summary = await runGuardianVerifyLoop({ manifest: out, state: join(dir, 'state.json'), maxPasses: 1, intervalMs: 1, run });
    expect(summary).toMatchObject({ pass: 4, fail: 0, unknown: 0 });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('fails the whole run and preserves existing output when any repo is unreadable or has no eligible entries', async () => {
    const phantom = makeRepo('guardian-set-phantom-', 7);
    const dir = tempdir('guardian-set-out-');
    const out = join(dir, 'manifest.json');
    mute();
    expect(await cmdFleetGuardianManifestSet(['--repos-file', reposFile(dir, [{ repo: phantom }]), '--out', out])).toBe(0);
    const before = readFileSync(out, 'utf8');
    const notGit = join(dir, 'not-a-repo');
    mkdirSync(notGit);
    expect(await cmdFleetGuardianManifestSet(['--repos-file', reposFile(dir, [{ repo: phantom }, { repo: notGit }]), '--out', out])).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(before);
    const rootOnly = tempdir('guardian-set-rootonly-');
    git(rootOnly, 'init', '-q', '--template=', '--initial-branch=master');
    writeFileSync(join(rootOnly, 'f'), 'x\n');
    git(rootOnly, 'add', 'f');
    git(rootOnly, 'commit', '-q', '--no-verify', '-m', 'root'); // root only: no eligible entries
    expect(await cmdFleetGuardianManifestSet(['--repos-file', reposFile(dir, [{ repo: phantom }, { repo: rootOnly }]), '--out', out])).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('rejects malformed specs, duplicates and over-budget configs before any git read or write', async () => {
    const phantom = makeRepo('guardian-set-phantom-', 7);
    const dir = tempdir('guardian-set-out-');
    const out = join(dir, 'manifest.json');
    mute();
    const read = vi.fn();
    for (const spec of [
      [{ repo: phantom }, { repo: phantom }],                       // identical duplicate
      [{ repo: phantom }, { repo: `${phantom}/.` }],                // duplicate once resolved
      [{ repo: phantom }, { repo: phantom, branch: 'master' }],     // explicit-default duplicate
      Array.from({ length: 21 }, () => ({ repo: phantom })),        // over the 20-spec cap
      [{ repo: 'relative/path' }],
      [{ repo: phantom, branch: 'has space' }],
      [{ repo: phantom, branch: '-bad' }],
      [{ repo: phantom, branch: '' }],
      [{ repo: phantom, extra: 1 }],
      ['not-an-object'], [{}], [{ branch: 'x' }], [], 'x', 42, null,
    ]) {
      expect(await cmdFleetGuardianManifestSet(['--repos-file', reposFile(dir, spec), '--out', out], { read })).toBe(2);
    }
    writeFileSync(join(dir, 'bad.json'), '{');
    for (const file of [join(dir, 'missing.json'), join(dir, 'bad.json'), dir]) {
      expect(await cmdFleetGuardianManifestSet(['--repos-file', file, '--out', out], { read })).toBe(2);
    }
    // Over configured budget: 20 distinct repos x limit 6 = 120 > 100.
    const many = reposFile(dir, Array.from({ length: 20 }, (_, i) => ({ repo: join(dir, `r${i}`) })));
    expect(await cmdFleetGuardianManifestSet(['--repos-file', many, '--out', out, '--limit-per-repo', '6'], { read })).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(() => statSync(out)).toThrow();
  });

  it('reads specs in input order through the injected reader seam, honoring default and explicit branches', async () => {
    const dir = tempdir('guardian-set-deps-');
    const out = join(dir, 'manifest.json');
    const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(ch => ch.repeat(40));
    const calls: string[] = [];
    const read = vi.fn(async (repo: string) => {
      calls.push(repo);
      return [{ sha: repo.endsWith('/one') ? B : D, parents: [repo.endsWith('/one') ? A : C], subject: 's' }];
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reposFile(dir, [{ repo: join(dir, 'one') }, { repo: join(dir, 'two'), branch: 'release' }]);
    expect(await cmdFleetGuardianManifestSet(['--repos-file', file, '--out', out], { read })).toBe(0);
    expect(calls).toEqual([join(dir, 'one'), join(dir, 'two')]);
    expect(String(log.mock.calls.at(-1)![0])).toBe(`guardian-manifest-set: wrote 2 entries from 2 repos to ${out}`);
    const manifest = JSON.parse(readFileSync(out, 'utf8')) as GuardianManifestEntry[];
    expect(manifest.map(e => [e.mergeCommit, e.baseBranch, e.cohortId])).toEqual([
      [B, 'master', 'guardian-master'], [D, 'release', 'guardian-release'],
    ]);
  });

  it('rejects invalid flags and values with exit 2', async () => {
    const dir = tempdir('guardian-set-cli-');
    const out = join(dir, 'm.json');
    const file = reposFile(dir, [{ repo: dir }]);
    mute();
    for (const args of [
      ['--bogus'],
      ['--repos-file'],                                               // missing value
      ['--repos-file', '--json'],                                     // flag-shaped value
      ['--repos-file', 'relative.json', '--out', out],                // not absolute
      ['--repos-file', file],                                         // missing --out
      ['--out', out],                                                 // missing --repos-file
      ['--repos-file', file, '--out', 'relative.json'],
      ['--repos-file', file, '--out', out, '--limit-per-repo', '0'],
      ['--repos-file', file, '--out', out, '--limit-per-repo', '101'],
      ['--repos-file', file, '--out', out, '--limit-per-repo', 'x'],
      ['--repos-file', file, '--out', out, '--repos-file', file],
      ['--repos-file', file, '--out', out, '--json', '--json'],
    ]) {
      expect(await cmdFleetGuardianManifestSet(args)).toBe(2);
    }
    expect(() => statSync(out)).toThrow();
  });
});
