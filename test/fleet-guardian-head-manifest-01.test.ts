import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildGuardianHeadEntry, GuardianHeadError, runGuardianHeadVerification } from '../src/core/fleet/guardian-head-manifest.js';
import { runGuardianVerifyLoop, type GuardianOptions, type GuardianSummary } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const viaLoop = (run: NonNullable<GuardianOptions['run']>): ((options: GuardianOptions) => Promise<GuardianSummary>) => options => runGuardianVerifyLoop({ ...options, run });

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function makeRepo(withOriginHead = true): { repo: string; head: string; parent: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-repo-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'guardian-test@example.invalid']);
  git(repo, ['config', 'user.name', 'guardian-test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'file.txt'), 'one\n');
  git(repo, ['add', 'file.txt']); git(repo, ['commit', '-qm', 'first']);
  const parent = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'file.txt'), 'two\n');
  git(repo, ['commit', '-qam', 'second']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', head]);
  if (withOriginHead) git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return { repo, head, parent };
}

async function stateEntries(state: string): Promise<{ terminal: string; sha: string }[]> {
  return (JSON.parse(await readFile(state, 'utf8')) as { entries: { terminal: string; sha: string }[] }).entries;
}

describe('guardian head manifest', () => {
  it('builds a guardian-<sha12> entry from the origin default branch with head and first parent', async () => {
    const { repo, head, parent } = makeRepo();
    const entry = await buildGuardianHeadEntry(repo);
    expect(entry).toEqual({
      repo, cohortId: `guardian-${head.slice(0, 12)}`, proposalId: `guardian-${head.slice(0, 12)}`,
      baseBranch: 'main', baseHead: parent, candidateHead: head, mergeCommit: head,
    });
    // Same head re-derives the identical identity: the loop dedupes on its key.
    expect(await buildGuardianHeadEntry(repo)).toEqual(entry);
  });

  it('accepts an explicit --branch under refs/remotes/origin', async () => {
    const { repo, head, parent } = makeRepo(false);
    git(repo, ['update-ref', 'refs/remotes/origin/release/x', head]);
    const entry = await buildGuardianHeadEntry(repo, 'release/x');
    expect(entry.baseBranch).toBe('release/x');
    expect(entry.mergeCommit).toBe(head);
    expect(entry.baseHead).toBe(parent);
  });

  it('refuses relative paths, non-repos, missing refs, bad branch names and parentless heads', async () => {
    const { repo } = makeRepo();
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-plain-')));
    await expect(buildGuardianHeadEntry('relative/path')).rejects.toThrow(GuardianHeadError);
    await expect(buildGuardianHeadEntry('relative/path')).rejects.toThrow('absolute');
    await expect(buildGuardianHeadEntry(join(tmpdir(), 'guardian-head-absent-xyz'))).rejects.toThrow('not a git repository root');
    await expect(buildGuardianHeadEntry(plainDir)).rejects.toThrow('not a git repository root');
    await expect(buildGuardianHeadEntry(repo, 'bad..name')).rejects.toThrow('invalid --branch');
    await expect(buildGuardianHeadEntry(repo, 'missing-branch')).rejects.toThrow('does not resolve');
    const noDefault = makeRepo(false);
    await expect(buildGuardianHeadEntry(noDefault.repo)).rejects.toThrow('pass --branch');
    const rootOnly = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-root-')));
    git(rootOnly, ['init', '-q', '-b', 'main']);
    git(rootOnly, ['config', 'user.email', 'guardian-test@example.invalid']); git(rootOnly, ['config', 'user.name', 'guardian-test']);
    writeFileSync(join(rootOnly, 'file.txt'), 'only\n'); git(rootOnly, ['add', 'file.txt']); git(rootOnly, ['commit', '-qm', 'root']);
    git(rootOnly, ['update-ref', 'refs/remotes/origin/main', git(rootOnly, ['rev-parse', 'HEAD'])]);
    await expect(buildGuardianHeadEntry(rootOnly, 'main')).rejects.toThrow('no first parent');
  });

  it('writes a one-entry manifest atomically, feeds it to the loop and removes it after success', async () => {
    const { repo, head, parent } = makeRepo();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    const state = join(dir, 'state.json');
    let manifestSeen = '';
    const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => {
      expect(item.repo).toBe(repo);
      expect(item.baseHead).toBe(parent);
      expect(item.candidateHead).toBe(head);
      expect(item.mergeCommit).toBe(head);
      expect(item.cohortId).toBe(`guardian-${head.slice(0, 12)}`);
      return result('pass');
    });
    const loop: typeof runGuardianVerifyLoop = async (options) => {
      manifestSeen = options.manifest;
      const parsed: unknown = JSON.parse(await readFile(options.manifest, 'utf8'));
      expect(parsed).toEqual([expect.objectContaining({ cohortId: `guardian-${head.slice(0, 12)}`, mergeCommit: head })]);
      return runGuardianVerifyLoop(options);
    };
    const summary = await runGuardianHeadVerification({ repo, state, maxPasses: 1, intervalMs: 1, loop, run });
    expect(summary).toMatchObject({ passes: 1, pass: 1, fail: 0, unknown: 0, cancelled: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(manifestSeen).not.toBe('');
    expect(existsSync(manifestSeen)).toBe(false);
    expect(await stateEntries(state)).toEqual([expect.objectContaining({ terminal: 'pass', sha: head })]);
  });

  it('removes the manifest when the loop throws', async () => {
    const { repo } = makeRepo();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    let manifestSeen = '';
    const loop: typeof runGuardianVerifyLoop = async (options) => {
      manifestSeen = options.manifest;
      expect(existsSync(options.manifest)).toBe(true);
      throw new Error('loop exploded');
    };
    await expect(runGuardianHeadVerification({ repo, state: join(dir, 'state.json'), maxPasses: 1, intervalMs: 1, loop })).rejects.toThrow('loop exploded');
    expect(manifestSeen).not.toBe('');
    expect(existsSync(manifestSeen)).toBe(false);
  });
});

describe('fleet guardian-verify --head-of', () => {
  it('reaches the loop through a generated manifest, returns pass status and unlinks it', async () => {
    const { repo, head } = makeRepo();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    const state = join(dir, 'state.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let manifestSeen = '';
    try {
      const loop = async (options: GuardianOptions): Promise<GuardianSummary> => {
        manifestSeen = options.manifest;
        expect(options.manifest.startsWith(tmpdir())).toBe(true);
        return runGuardianVerifyLoop({ ...options, run: async () => result('pass') });
      };
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--state', state, '--json'], loop)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ pass: 1, fail: 0, unknown: 0 });
      expect(manifestSeen).not.toBe('');
      expect(existsSync(manifestSeen)).toBe(false);
      expect(await stateEntries(state)).toEqual([expect.objectContaining({ terminal: 'pass', sha: head })]);
    } finally { log.mockRestore(); }
  });

  it('maps a loop fail verdict to exit 1 and still removes the manifest', async () => {
    const { repo } = makeRepo();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let manifestSeen = '';
    try {
      const loop = async (options: GuardianOptions): Promise<GuardianSummary> => {
        manifestSeen = options.manifest;
        return runGuardianVerifyLoop({ ...options, run: async () => result('fail') });
      };
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--branch', 'main', '--state', join(dir, 'state.json')], loop)).toBe(1);
      expect(existsSync(manifestSeen)).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('refuses flag-shape errors with exit 2 before any work', async () => {
    const { repo } = makeRepo();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    const state = join(dir, 'state.json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loop = vi.fn(viaLoop(async () => result('pass')));
    try {
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--manifest', join(dir, 'm.json'), '--state', state], loop)).toBe(2);
      expect(await cmdFleetGuardianVerify(['--branch', 'main', '--state', state], loop)).toBe(2);
      expect(await cmdFleetGuardianVerify(['--manifest', join(dir, 'm.json'), '--branch', 'main', '--state', state], loop)).toBe(2);
      expect(await cmdFleetGuardianVerify(['--head-of'], loop)).toBe(2);
      expect(await cmdFleetGuardianVerify(['--head-of', '--json'], loop)).toBe(2);
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--head-of', repo, '--state', state], loop)).toBe(2);
      expect(loop).not.toHaveBeenCalled();
      const text = stderr.mock.calls.map(call => String(call[0])).join('');
      expect(text).toContain('mutually exclusive');
      expect(text).toContain('--branch requires --head-of');
    } finally { stderr.mockRestore(); }
  });

  it('refuses relative paths, bad branches and non-repos with exit 3 and never reaches the loop', async () => {
    const { repo } = makeRepo(false);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-state-')));
    const state = join(dir, 'state.json');
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-head-plain-')));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loop = vi.fn(viaLoop(async () => result('pass')));
    try {
      expect(await cmdFleetGuardianVerify(['--head-of', 'relative/path', '--state', state], loop)).toBe(3);
      expect(await cmdFleetGuardianVerify(['--head-of', plainDir, '--state', state], loop)).toBe(3);
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--branch', 'bad..name', '--state', state], loop)).toBe(3);
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--branch', 'missing', '--state', state], loop)).toBe(3);
      expect(await cmdFleetGuardianVerify(['--head-of', repo, '--state', state], loop)).toBe(3);
      expect(loop).not.toHaveBeenCalled();
      const text = stderr.mock.calls.map(call => String(call[0])).join('');
      expect(text).toContain('absolute');
      expect(text).toContain('not a git repository root');
      expect(text).toContain('invalid --branch');
      expect(text).toContain('does not resolve');
      expect(text).toContain('pass --branch');
    } finally { stderr.mockRestore(); }
  });

  it('prints usage on --help and does no work', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const loop = vi.fn(viaLoop(async () => result('pass')));
    try {
      expect(await cmdFleetGuardianVerify(['--help'], loop)).toBe(0);
      expect(await cmdFleetGuardianVerify(['-h'], loop)).toBe(0);
      expect(String(log.mock.calls[0]![0])).toContain('guardian-verify');
      expect(String(log.mock.calls[0]![0])).toContain('--head-of');
      expect(loop).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
