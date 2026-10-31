import { describe, expect, it } from 'vitest';
import type { OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import { isOpsReleases, orderRepos, releaseLabel, runTone, safeRepoHref } from './fleet-releases-model.js';

const repo: OpsRepoReleaseV1 = {
  repo: 'ashlrai/phantom', path: '/repo', version: '1.0', latestTag: 'v1.0', releaseWorkflow: 'release.yml',
  gh: { latestRelease: { tag: 'v1.0', name: 'First', publishedAt: null, draft: false, prerelease: false },
    latestRun: { workflow: 'Release', status: 'completed', conclusion: 'success', at: null } }, notes: [],
};

describe('release model', () => {
  it('validates the complete structure and accepts extra fields and offline GitHub', () => {
    const fixture = { v: 1, generatedAt: '2026-01-01', sourceState: 'healthy', repos: [repo, { ...repo, gh: null }], extra: true };
    expect(isOpsReleases(fixture)).toBe(true);
    expect(isOpsReleases({ ...fixture, repos: undefined })).toBe(false);
    expect(isOpsReleases({ ...fixture, repos: [{ ...repo, gh: { latestRelease: {}, latestRun: null } }] })).toBe(false);
  });

  it('orders Phantom first without mutating the input', () => {
    const repos = [{ ...repo, repo: 'z/other' }, { ...repo, repo: 'ashlrai/phantom' }, { ...repo, repo: 'a/other' }, { ...repo, repo: 'phantom' }];
    expect(orderRepos(repos).map(item => item.repo)).toEqual(['ashlrai/phantom', 'phantom', 'a/other', 'z/other']);
    expect(repos[0].repo).toBe('z/other');
  });

  it.each([
    ['completed', 'success', 'ok'], ['in_progress', null, 'neutral'], ['queued', null, 'neutral'],
    ['completed', 'failure', 'danger'], ['completed', 'cancelled', 'danger'], ['completed', 'timed_out', 'danger'],
    ['completed', 'skipped', 'warn'], ['waiting', null, 'warn'],
  ] as const)('maps %s/%s to %s', (status, conclusion, tone) => {
    expect(runTone({ workflow: 'Release', status, conclusion, at: null })).toBe(tone);
  });

  it('labels releases and prioritizes the draft badge', () => {
    const release = { tag: 'v1', name: 'First', publishedAt: null, draft: true, prerelease: true };
    expect(releaseLabel(release)).toEqual({ label: 'v1 · First', badge: 'draft' });
    expect(releaseLabel({ ...release, name: 'v1', draft: false })).toEqual({ label: 'v1', badge: 'prerelease' });
    expect(releaseLabel({ ...release, name: null, draft: false, prerelease: false })).toEqual({ label: 'v1', badge: null });
  });

  it('only links safe owner/repo names', () => {
    expect(safeRepoHref('ashlrai/phantom')).toBe('https://github.com/ashlrai/phantom/releases');
    for (const value of ['bad repo', '../phantom', 'owner/..', 'owner/../other', 'owner/repo?x']) expect(safeRepoHref(value)).toBeNull();
  });
});
