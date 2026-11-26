import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';
import { selectNextGuardianInfraRetry } from '../src/core/fleet/guardian-retry-next.js';
import { prepareGuardianRetryState } from '../src/core/fleet/guardian-retry-state.js';
import {
  guardianVerificationKey,
  hasNoControlChars,
  isValidGuardianBranch,
  isValidGuardianRepoPath,
  readGuardianManifest,
  readGuardianState,
  sanitizeGuardianText,
  writePrivateAtomic,
  writePrivateExclusive,
} from '../src/core/fleet/guardian-schema.js';
import { compactGuardianState } from '../src/core/fleet/guardian-state-compact.js';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';

const infraFail: DetachedPostMergeRunnerResult = {
  schemaVersion: 1, authority: 'observation-only', policyEligible: false,
  mergePermitted: false, rollbackPermitted: false, deployPermitted: false,
  terminal: 'fail', reason: 'verification-infrastructure', verifierManifestDigest: null,
  requiredCommandCount: 1, commandsRun: 1, failureCategory: 'infra', cleanup: 'removed', recordDisposition: 'recorded',
};

describe('guardian shared schema and helpers', () => {
  it('validates control characters, text sanitization, repo paths and branches consistently', () => {
    expect(hasNoControlChars('ok/path-1')).toBe(true);
    expect(hasNoControlChars('bad\x00path')).toBe(false);
    expect(hasNoControlChars('bad\x1fpath')).toBe(false);
    expect(hasNoControlChars('bad\x7fpath')).toBe(false);
    expect(sanitizeGuardianText('')).toBe('-');
    expect(sanitizeGuardianText('a\nb\x7fc')).toBe('a-b-c');
    expect(sanitizeGuardianText('x'.repeat(300))).toHaveLength(256);

    const longRepo = `/${'a'.repeat(300)}`;
    expect(isValidGuardianRepoPath(longRepo)).toBe(true);
    expect(isValidGuardianRepoPath(`/${'a'.repeat(4096)}`)).toBe(false);
    expect(isValidGuardianRepoPath('relative/path')).toBe(false);
    expect(isValidGuardianRepoPath('/bad\npath')).toBe(false);

    expect(isValidGuardianBranch('main')).toBe(true);
    expect(isValidGuardianBranch('-bad')).toBe(false);
    expect(isValidGuardianBranch('bad branch')).toBe(false);
    expect(isValidGuardianBranch('bad\tbranch')).toBe(false);
    expect(isValidGuardianBranch('a'.repeat(257))).toBe(false);
  });

  it('accepts valid >256-char repo paths identically across verify, retry-next, retry-state and compact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-schema-long-'));
    try {
      const longRepo = `/${Array.from({ length: 16 }, (_, i) => `segment-${i}-${'a'.repeat(12)}`).join('/')}`;
      expect(longRepo.length).toBeGreaterThan(256);
      const entry: DetachedPostMergeRunnerInput = {
        repo: longRepo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master',
        baseHead: 'a'.repeat(40), candidateHead: 'b'.repeat(40), mergeCommit: 'c'.repeat(40),
      };
      const manifest = join(dir, 'manifest.json');
      const state = join(dir, 'state.json');
      const retryOut = join(dir, 'retry.json');
      const compactOut = join(dir, 'compact.json');
      await writeFile(manifest, JSON.stringify([entry]));

      expect(await readGuardianState(state, { allowMissing: true })).toEqual({ version: 1, entries: [] });
      expect(await runGuardianVerifyLoop({ manifest, state, maxPasses: 1, intervalMs: 1, run: async () => infraFail }))
        .toMatchObject({ fail: 1, pass: 0, unknown: 0 });
      expect(await selectNextGuardianInfraRetry({ manifest, sourceState: state, outputState: retryOut }))
        .toEqual({ repo: longRepo, sha: entry.mergeCommit });
      expect(await selectNextGuardianInfraRetry({
        manifest, sourceState: state, outputState: retryOut, exclude: [{ repo: longRepo, sha: entry.mergeCommit }],
      })).toBeNull();
      expect(await prepareGuardianRetryState({
        manifest, sourceState: state, outputState: retryOut, repo: longRepo, sha: entry.mergeCommit,
      })).toMatchObject({ removed: 1, retained: 0 });
      expect(await compactGuardianState({ manifest, sourceState: state, outputState: compactOut }))
        .toEqual({ before: 1, retained: 1, removed: 0 });
      const parsedManifest = await readGuardianManifest(manifest);
      expect(guardianVerificationKey(parsedManifest[0]!)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes mode-0600 files exclusively and atomically without leaving temp artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-schema-io-'));
    try {
      const excl = join(dir, 'exclusive.json');
      await writePrivateExclusive(excl, '{"v":1}');
      expect((await stat(excl)).mode & 0o777).toBe(0o600);
      await expect(writePrivateExclusive(excl, '{"v":2}')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(excl, 'utf8')).toBe('{"v":1}');

      const atom = join(dir, 'atomic.json');
      await writePrivateAtomic(atom, '{"v":1}');
      await writePrivateAtomic(atom, '{"v":2}');
      expect((await stat(atom)).mode & 0o777).toBe(0o600);
      expect(await readFile(atom, 'utf8')).toBe('{"v":2}');
      expect((await readdir(dir)).sort()).toEqual(['atomic.json', 'exclusive.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
