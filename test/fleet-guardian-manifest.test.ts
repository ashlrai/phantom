import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  guardianManifestEntries,
  readFirstParentCommits,
  writeGuardianManifest,
  type FirstParentCommit,
} from '../src/core/fleet/guardian-manifest.js';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianManifest } from '../src/cli/fleet-guardian-manifest.js';
import type { DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
const commit = (sha: string, parents: string[], subject = 'routine work'): FirstParentCommit => ({ sha, parents, subject });
const opts = { repo: '/fake/repo', branch: 'master' };

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
  return execFileSync('git', [
    '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-C', dir, ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// master history: root commit (skipped), one direct single-parent commit, one
// --no-ff merge whose subject ends "(#7)". First-parent log order is newest
// first: merge, direct, root.
function makeRepo(): string {
  const dir = tempdir('guardian-manifest-repo-');
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
  git(dir, 'merge', '--no-ff', '--no-verify', '-m', 'merge feature (#7)', 'feature');
  return dir;
}

describe('guardianManifestEntries', () => {
  it('maps single-parent and two-parent commits and skips roots and octopus merges, oldest first', () => {
    const entries = guardianManifestEntries([
      commit(D, [C, A], 'merge branch (#2814)'), // newest: two-parent merge
      commit(C, [A]),                            // squash/direct: single parent
      commit(E, [A, B, C], 'octopus'),           // 3 parents: skipped
      commit(A, [], 'root'),                     // root: skipped
    ], opts);
    expect(entries).toEqual([
      { repo: '/fake/repo', cohortId: 'guardian-master', proposalId: `commit-${C.slice(0, 12)}`, baseBranch: 'master', baseHead: A, candidateHead: C, mergeCommit: C },
      { repo: '/fake/repo', cohortId: 'guardian-master', proposalId: 'pr-2814', baseBranch: 'master', baseHead: C, candidateHead: A, mergeCommit: D },
    ]);
  });
  it('derives pr-N only from a trailing (#N) and dedupes mergeCommit', () => {
    const entries = guardianManifestEntries([
      commit(D, [C], 'later duplicate'),
      commit(C, [A], 'fix (#12) explains more'), // (#12) not trailing
      commit(D, [B], 'first (#9)'),              // same sha wins dedupe
    ], opts);
    expect(entries.map(e => e.mergeCommit)).toEqual([D, C]);
    expect(entries.map(e => e.proposalId)).toEqual(['pr-9', `commit-${C.slice(0, 12)}`]);
  });
  it('sanitizes cohortId to the loop safeText rule and carries baseBranch verbatim', () => {
    const entries = guardianManifestEntries([commit(C, [A])], { repo: '/fake/repo', branch: 'feat\x01ure/x' });
    expect(entries[0]!.cohortId).toBe('guardian-feat-ure/x');
    expect(entries[0]!.baseBranch).toBe('feat\x01ure/x');
  });
});

describe('guardian manifest feed on a real repo', () => {
  it('reads first-parent commits, writes a manifest the guardian loop accepts, and is idempotent', async () => {
    const repo = makeRepo();
    const commits = await readFirstParentCommits(repo, 'master', 20);
    expect(commits).toHaveLength(3); // merge, direct, root — feature commit is second parent only
    expect(commits[0]!.subject).toBe('merge feature (#7)');

    const entries = guardianManifestEntries(commits, { repo, branch: 'master' });
    expect(entries).toHaveLength(2);
    const [direct, merge] = entries;
    expect(direct!.proposalId).toBe(`commit-${direct!.mergeCommit.slice(0, 12)}`);
    expect(direct!.candidateHead).toBe(direct!.mergeCommit);
    expect(merge!.proposalId).toBe('pr-7');
    expect(merge!.baseHead).toBe(direct!.mergeCommit);
    expect(merge!.candidateHead).toBe(git(repo, 'rev-parse', 'feature'));

    const dir = tempdir('guardian-manifest-out-');
    const manifest = join(dir, 'manifest.json');
    const state = join(dir, 'state.json');
    await writeGuardianManifest(manifest, entries);
    expect(statSync(manifest).mode & 0o777).toBe(0o600);

    const run = vi.fn(async () => passResult());
    const summary = await runGuardianVerifyLoop({ manifest, state, maxPasses: 1, intervalMs: 1, run });
    expect(summary).toMatchObject({ passes: 1, pass: 2, fail: 0, unknown: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(new Set(run.mock.calls.map(call => (call[0] as { mergeCommit: string }).mergeCommit))).toEqual(new Set(entries.map(e => e.mergeCommit)));

    // Re-listing the same commits is idempotent: state keys entries, nothing reruns.
    const again = await runGuardianVerifyLoop({ manifest, state, maxPasses: 1, intervalMs: 1, run });
    expect(again).toMatchObject({ pass: 2, fail: 0, unknown: 0 });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('refuses to write zero entries and rejects a missing repo or bad bounds', async () => {
    const dir = tempdir('guardian-manifest-empty-');
    await expect(writeGuardianManifest(join(dir, 'm.json'), [])).rejects.toThrow();
    expect(() => statSync(join(dir, 'm.json'))).toThrow();
    await expect(readFirstParentCommits(join(dir, 'missing'), 'master', 20)).rejects.toThrow();
    await expect(readFirstParentCommits('relative/repo', 'master', 20)).rejects.toThrow();
    await expect(readFirstParentCommits(dir, 'master', 0)).rejects.toThrow();
    await expect(readFirstParentCommits(dir, 'master', 101)).rejects.toThrow();
  });
});

describe('cmdFleetGuardianManifest', () => {
  it('rejects bad flags and values with exit 2', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = tempdir('guardian-manifest-cli-');
    const out = join(dir, 'm.json');
    for (const args of [
      ['--bogus'],
      ['--repo'],                                               // missing value
      ['--repo', '--json'],                                     // flag-shaped value
      ['--repo', 'relative/dir', '--out', out],                 // --repo not absolute
      ['--out', out],                                           // missing --repo
      ['--repo', dir],                                          // missing --out
      ['--repo', dir, '--out', out, '--limit', '0'],
      ['--repo', dir, '--out', out, '--limit', '101'],
      ['--repo', dir, '--out', out, '--limit', 'x'],
      ['--repo', dir, '--out', out, '--branch', '-bad'],
      ['--repo', dir, '--out', out, '--branch', 'has space'],
      ['--repo', dir, '--out', out, '--json', '--json'],        // duplicate flag
    ]) {
      expect(await cmdFleetGuardianManifest(args)).toBe(2);
    }
    expect(() => statSync(out)).toThrow(); // nothing materialized
    err.mockRestore();
  });
  it('exits 1 on git failure or zero eligible commits and 0 on a valid run', async () => {
    const dir = tempdir('guardian-manifest-cli-');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(dir, 'manifest.json');
    expect(await cmdFleetGuardianManifest(['--repo', join(dir, 'missing'), '--out', out])).toBe(1);

    const empty = join(dir, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q', '--template=', '--initial-branch=master');
    expect(await cmdFleetGuardianManifest(['--repo', empty, '--out', out])).toBe(1); // no commits at all

    const repo = makeRepo();
    expect(await cmdFleetGuardianManifest(['--repo', repo, '--out', out, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({ written: 2, out });
    expect(report.entries).toHaveLength(2);
    const manifest = JSON.parse(readFileSync(out, 'utf8')) as { proposalId: string }[];
    expect(manifest.map(e => e.proposalId)).toEqual([expect.stringMatching(/^commit-[a-f0-9]{12}$/), 'pr-7']);
    expect(String(log.mock.calls.at(-1)![0])).not.toContain('feature work'); // no subjects printed

    expect(await cmdFleetGuardianManifest(['--repo', repo, '--out', join(dir, 'm2.json')])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toBe(`guardian-manifest: wrote 2 entries to ${join(dir, 'm2.json')}`);

    // The written manifest feeds guardian-verify with no hand editing.
    const state = join(dir, 'state.json');
    const run = vi.fn(async () => passResult());
    const summary = await runGuardianVerifyLoop({ manifest: out, state, maxPasses: 1, intervalMs: 1, run });
    expect(summary).toMatchObject({ pass: 2, fail: 0, unknown: 0 });
    err.mockRestore();
    log.mockRestore();
  });
});
