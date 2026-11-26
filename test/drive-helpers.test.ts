import { describe, expect, it } from 'vitest';
import {
  APPROVED_FLEET_REPOS,
  CODEX_FILE_PACK,
  DEFAULT_FLEET_AUTHOR,
  DEFAULT_STATE_ENTRY_CAP,
  NODE_RUNNER_PROTOCOL,
  isFiniteNumber,
  isPlainRecord,
  isSafeNodeJobId,
  prTouchesSecurityPin,
  pruneOldestEntries,
  securityPinnedPath,
  shortRepoName,
} from '../src/core/drive/drive-helpers.js';
import { MERGEQ_REPOS } from '../src/core/drive/merge-queue-loop.js';
import { NODE_RUNNER_PROTOCOL as RUNNER_PROTOCOL } from '../src/core/drive/nodes/runner.js';
import { QUEUEGEN_REPOS, securityPinnedPath as queuegenSecurityPinnedPath } from '../src/core/drive/queuegen.js';
import { FLEET_AUTHOR, REFIX_REPOS, securityPinnedPath as refixSecurityPinnedPath } from '../src/core/drive/refix-loop.js';

describe('drive shared helpers', () => {
  it('shares one canonical approved repo list, fleet author, and runner protocol across drive modules', () => {
    expect(QUEUEGEN_REPOS).toBe(APPROVED_FLEET_REPOS);
    expect(REFIX_REPOS).toBe(APPROVED_FLEET_REPOS);
    expect(MERGEQ_REPOS).toBe(APPROVED_FLEET_REPOS);
    expect(FLEET_AUTHOR).toBe(DEFAULT_FLEET_AUTHOR);
    expect(RUNNER_PROTOCOL).toBe(NODE_RUNNER_PROTOCOL);
    expect(CODEX_FILE_PACK).toBe('codex-file');
    expect(DEFAULT_STATE_ENTRY_CAP).toBe(8_192);
    expect(queuegenSecurityPinnedPath).toBe(securityPinnedPath);
    expect(refixSecurityPinnedPath).toBe(securityPinnedPath);
  });

  it('guards plain records and finite numbers strictly', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('obj')).toBe(false);

    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-42.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });

  it('validates single-component safe node job identifiers', () => {
    expect(isSafeNodeJobId('job-123_ok.v1')).toBe(true);
    expect(isSafeNodeJobId('a'.repeat(120))).toBe(true);
    expect(isSafeNodeJobId('a'.repeat(121))).toBe(false);
    expect(isSafeNodeJobId('')).toBe(false);
    expect(isSafeNodeJobId('../escape')).toBe(false);
    expect(isSafeNodeJobId('a/b')).toBe(false);
    expect(isSafeNodeJobId('.hidden')).toBe(false);
  });

  it('extracts short repo names and detects security-pinned paths conservatively', () => {
    expect(shortRepoName('ashlrai/phantom')).toBe('phantom');
    expect(shortRepoName('phantom')).toBe('phantom');

    expect(securityPinnedPath('.github/workflows/ci.yml')).toBe(true);
    expect(securityPinnedPath('scripts/publish.sh')).toBe(true);
    expect(securityPinnedPath('contrib/mac/dispatchd.py')).toBe(true);
    expect(securityPinnedPath('bin/git_safe.sh')).toBe(true);
    expect(securityPinnedPath('src/core/util/scrub.ts')).toBe(true);
    expect(securityPinnedPath('src/core/worktree-reap.ts')).toBe(true);
    expect(securityPinnedPath('src/core/drive/drive-helpers.ts')).toBe(false);

    expect(prTouchesSecurityPin({ filesTruncated: false, files: ['src/a.ts'] })).toBe(false);
    expect(prTouchesSecurityPin({ filesTruncated: true, files: ['src/a.ts'] })).toBe(true);
    expect(prTouchesSecurityPin({ filesTruncated: false, files: ['src/a.ts', '.github/CODEOWNERS'] })).toBe(true);
  });

  it('prunes the oldest state entries once a map exceeds its cap', () => {
    const state: Record<string, { at: number }> = {
      a: { at: 300 },
      b: { at: 100 },
      c: { at: 400 },
      d: { at: 200 },
    };
    pruneOldestEntries(state, (entry) => entry.at, 4);
    expect(Object.keys(state).sort()).toEqual(['a', 'b', 'c', 'd']);

    pruneOldestEntries(state, (entry) => entry.at, 2);
    expect(Object.keys(state).sort()).toEqual(['a', 'c']);
  });
});
