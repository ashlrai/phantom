import { describe, expect, it } from 'vitest';
import { planReleaseDispatch } from '../src/core/release/orchestrator.js';
import { runReleaseDispatchDryRun } from '../scripts/release-dispatch-dry-run.js';

const now = Date.parse('2026-01-01T00:00:00.000Z');
const sha = 'a'.repeat(40);
function snapshot() {
  return { schemaVersion: 1, observedAt: new Date(now).toISOString(), repositories: [{
    repository: 'ashlrai/phantom', defaultBranch: 'master', sourceSha: sha, defaultSha: sha, treeSha: sha, dirty: false, version: '1.2.3',
    packages: [{path: 'package.json', name: '@ashlr/phantom', version: '1.2.3', private: false}],
    docs: {readme: true, changelog: true, synchronized: true},
    workflows: ['ci.yml', 'dependency-audit.yml', 'attest-ci-build.yml', 'publish-canonical-npm.yml'].map(name => ({path: `.github/workflows/${name}`, sourceSha: sha})),
    qualification: {sourceSha: sha, coverage: 'full', ci: 'success', audit: 'success', originalArtifact: 'present'},
    publicFacts: null, ownership: {stage: 'merge', publication: 'commissioned', blockers: [] as string[]},
  }] };
}
describe('release dispatch dry run', () => {
  it('preserves reviewed dependencies without granting execution', () => {
    const result = planReleaseDispatch(snapshot(), now, {}, 'ashlrai/phantom');
    expect(result).toMatchObject({dryRun: true, executable: false, releaseAuthorized: false, next: 'source'});
    expect(result.stages.find(s => s.id === 'npm')).toMatchObject({dependsOn: ['attest'], workflow: '.github/workflows/publish-canonical-npm.yml'});
  });
  it('holds stale, dirty and owner-blocked observations without echoing blocker text', () => {
    const input = snapshot(); input.repositories[0]!.dirty = true; input.repositories[0]!.ownership.blockers.push('private owner detail');
    const result = planReleaseDispatch(input, now + 300001, {}, 'ashlrai/phantom');
    expect(result.next).toBeNull();
    expect(result.holds).toEqual(expect.arrayContaining(['dirty-source', 'owner-hold', 'source-observation-stale-or-future']));
    expect(JSON.stringify(result)).not.toContain('private owner detail');
  });
  it('does not infer a publisher for an unreviewed repository', () => {
    const input = snapshot(); input.repositories[0]!.repository = 'ashlrai/example';
    const result = planReleaseDispatch(input, now, {}, 'ashlrai/example');
    expect(result.reviewedContract).toBe(false);
    expect(result.next).toBeNull();
    expect(result.holds).toContain('unreviewed-repository-release-contract');
  });
  it('requires explicit dry-run and rejects malformed snapshots', () => {
    expect(() => runReleaseDispatchDryRun(['--input', 'x', '--repo', 'ashlrai/phantom'], now)).toThrow();
    expect(() => planReleaseDispatch({}, now, {}, 'ashlrai/phantom')).toThrow();
  });
});
