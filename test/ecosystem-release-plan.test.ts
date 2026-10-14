import { describe, expect, it } from 'vitest';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEcosystemReleasePlan, type ReleasePlanSnapshot, type ReleaseRepositoryObservation } from '../src/core/ecosystem/release-plan.js';
import { readBoundedSnapshotBytes, runEcosystemReleasePlan } from '../scripts/ecosystem-release-plan.js';

const NOW = Date.parse('2026-10-14T08:00:00.000Z');
const SHA = 'a'.repeat(40); const OTHER = 'b'.repeat(40);
const registry = JSON.parse(readFileSync(join(process.cwd(), 'docs/ecosystem-index.json'), 'utf8')) as unknown;
function observation(repository = 'ashlrai/phantom'): ReleaseRepositoryObservation {
  return { repository, defaultBranch: repository === 'ashlrai/phantom' ? 'master' : 'main', sourceSha: SHA, defaultSha: SHA, treeSha: OTHER,
    dirty: false, version: '3.29.16', packages: [{ path: 'package.json', name: '@ashlr/phantom', version: '3.29.16', private: false }],
    docs: { readme: true, changelog: true, synchronized: true },
    workflows: ['ci.yml', 'dependency-audit.yml', 'attest-ci-build.yml', 'publish-canonical-npm.yml', 'release.yml', 'release-agent.yml', 'production-release.yml']
      .map(name => ({ path: `.github/workflows/${name}`, sourceSha: SHA })),
    qualification: { sourceSha: SHA, coverage: 'full', ci: 'success', audit: 'success', originalArtifact: 'present' },
    publicFacts: null, ownership: { stage: 'merge', publication: 'commissioned', blockers: [] } };
}
function snapshot(o = observation()): ReleasePlanSnapshot { return { schemaVersion: 1, observedAt: new Date(NOW).toISOString(), repositories: [o] }; }
function selected(o = observation(), now = NOW) {
  return buildEcosystemReleasePlan(snapshot(o), now, registry).repositories.find(r => r.repository === o.repository)!;
}
describe('source-owned ecosystem release dependency planning', () => {
  it('retains the actual complete Phantom publisher chain without treating reported inputs as authority', () => {
    const result = buildEcosystemReleasePlan(snapshot(), NOW, registry); const plan = result.repositories.find(r => r.repository === 'ashlrai/phantom')!;
    expect(result).toMatchObject({ authority: false, releaseAdmission: false, effectsExecuted: false, evidenceBasis: 'reported-local-observations-not-attestation' });
    expect(plan.requiredCiJobs).toHaveLength(15);
    const get = (id: string) => plan.tasks.find(t => t.id === `ashlrai/phantom:${id}`)!;
    expect(get('attest').dependsOn).toEqual(['ashlrai/phantom:protected-source', 'ashlrai/phantom:audit']);
    expect(get('npm')).toMatchObject({ workflow: '.github/workflows/publish-canonical-npm.yml', dependsOn: ['ashlrai/phantom:attest'], status: 'pending-independent-verification' });
    expect(get('native').dependsOn).toEqual(['ashlrai/phantom:npm']); expect(get('site').dependsOn).toEqual(['ashlrai/phantom:public-facts']);
    expect(plan.tasks.every(t => t.status !== ('authorized' as string))).toBe(true);
  });
  it.each(['documentation-pr', 'frontend-pr', 'site-pr', 'unknown', 'absent'] as const)('does not use %s coverage as original full CI', coverage => {
    const o = observation(); o.qualification.coverage = coverage;
    expect(selected(o).holds).toContain('full-coverage-not-reported');
    expect(selected(o).tasks.find(t => t.id.endsWith(':npm'))?.status).toBe('held');
  });
  it('separately holds independent Audit and missing original artifacts even after claimed CI success', () => {
    const o = observation(); o.qualification.audit = 'unknown'; o.qualification.originalArtifact = 'missing'; const plan = selected(o);
    expect(plan.tasks.find(t => t.id.endsWith(':audit'))?.holds).toContain('independent-audit-not-reported');
    expect(plan.tasks.find(t => t.id.endsWith(':attest'))?.holds).toContain('original-ci-artifact-not-reported');
    expect(plan.tasks.find(t => t.id.endsWith(':npm'))?.dependsOn).toEqual(['ashlrai/phantom:attest']);
  });
  it('holds stale observations, changing source, dirty work and mismatched workflow bindings', () => {
    const o = observation(); o.sourceSha = OTHER; o.dirty = true;
    const plan = selected(o, NOW + 300_001);
    expect(plan.holds).toEqual(expect.arrayContaining(['source-observation-stale-or-future', 'dirty-source', 'protected-source-mismatch', 'qualification-source-mismatch']));
    expect(plan.tasks.find(t => t.id.endsWith(':npm'))?.holds).toContain('workflow-missing-or-source-mismatch');
  });
  it.each(['stale', 'future', 'source', 'version'])('never promotes %s public facts to a current release plan', kind => {
    const o = observation(); o.publicFacts = { sourceSha: kind === 'source' ? OTHER : SHA, version: kind === 'version' ? '3.29.15' : '3.29.16',
      observedAt: new Date(NOW + (kind === 'future' ? 1 : kind === 'stale' ? -300_001 : 0)).toISOString() };
    expect(selected(o).holds).toContain('public-facts-stale-or-source-version-mismatch');
  });
  it('refuses a private Phantom npm target without applying that flag to an unrelated private workspace root', () => {
    const o = observation(); o.packages[0]!.private = true;
    expect(selected(o).tasks.find(t => t.id.endsWith(':npm'))?.holds).toContain('private-package-not-publishable');
    const bin = observation('ashlrai/binshield'); bin.version = '0.2.0'; bin.packages = [
      { path: 'package.json', name: 'binshield', version: '0.1.0', private: true },
      { path: 'packages/cli/package.json', name: '@binshield/cli', version: '0.2.0', private: false }];
    const plan = selected(bin); expect(plan.artifacts[0]).toMatchObject({ packagePath: 'packages/cli/package.json', packageName: '@binshield/cli', holds: [] });
    expect(plan.tasks.find(t => t.id.endsWith(':npm-publisher'))?.holds).toContain('release-publisher-unsupported');
  });
  it('does not invent npm publication for Go, plugins, private websites or verification repositories', () => {
    for (const name of ['ashlr-pulse', 'ashlr-plugin', 'measurably', 'fleet-canary']) {
      const o = observation(`ashlrai/${name}`); o.packages[0]!.private = true; const plan = selected(o);
      expect(plan.artifacts.some(a => a.kind === 'npm' || a.kind === 'npm-wrapper')).toBe(false);
      expect(plan.tasks.some(t => t.id.includes(':npm'))).toBe(false);
    }
    expect(selected(observation('ashlrai/fleet-canary')).tasks.map(t => t.id.split(':')[1])).toEqual(['source', 'metadata', 'ci', 'protected-source']);
  });
  it('preserves wrapper commissioning holds and avoids presenting acceptance as a publisher', () => {
    const o = observation('ashlrai/phantom-secrets'); o.version = '0.7.9'; o.packages = [
      { path: 'npm/package.json', name: 'phantom-secrets', version: '0.7.9', private: false },
      { path: 'npm-mcp/package.json', name: 'phantom-secrets-mcp', version: '0.7.9', private: false }];
    const plan = selected(o); const publisher = plan.tasks.find(t => t.id.endsWith(':wrapper-publisher'))!;
    expect(publisher).toMatchObject({ workflow: null, status: 'held' }); expect(publisher.holds).toContain('release-publisher-unsupported');
    expect(plan.tasks.find(t => t.id.endsWith(':wrapper-acceptance'))?.workflow).toBe('.github/workflows/npm-candidate-acceptance.yml');
  });
  it('retains propose-only and unknown repository/product/lane holds despite claimed commissioning', () => {
    const known = observation('ashlrai/ashlr-core-efficiency');
    expect(selected(known).holds).toContain('owner-proposal-or-unknown-stage');
    expect(selected(known).tasks.find(t => t.id.endsWith(':contract-review'))?.holds).toContain('release-publisher-unsupported');
    const unknown = selected(observation('ashlrai/future-tool'));
    expect(unknown.holds).toContain('unreviewed-repository-release-contract'); expect(unknown.artifacts[0]?.kind).toBe('unknown');
    expect(unknown.tasks.some(t => t.workflow !== null)).toBe(false);
    expect(unknown.tasks.find(t => t.id.endsWith(':ci'))?.holds).toContain('qualification-workflow-unreviewed');
  });
  it('is deterministic and detached, preserves dependency closure and represents every missing profile honestly', () => {
    const s = snapshot(); const before = structuredClone(s); const one = buildEcosystemReleasePlan(s, NOW, registry);
    expect(buildEcosystemReleasePlan(s, NOW, registry)).toEqual(one); expect(s).toEqual(before);
    s.repositories[0]!.sourceSha = OTHER; expect(one.repositories.find(r => r.repository === 'ashlrai/phantom')?.sourceSha).toBe(SHA);
    expect(one.repositories.filter(r => r.reviewedContract)).toHaveLength(14);
    for (const r of one.repositories) {
      const ids = new Set(r.tasks.map(t => t.id)); for (const t of r.tasks) expect(t.dependsOn.every(id => ids.has(id))).toBe(true);
      if (r.repository !== 'ashlrai/phantom') expect(r.holds).toContain('source-observation-missing');
    }
  });
  it('keeps registry-only Lexicon/Stack and explicit unprofiled inputs visible without inventing release contracts', () => {
    const result = buildEcosystemReleasePlan({ ...snapshot(), repositories: [observation('ashlrai/future-tool')] }, NOW, registry);
    for (const repo of ['ashlrai/lexicon', 'ashlrai/stack']) {
      const plan = result.repositories.find(r => r.repository === repo)!;
      expect(plan).toMatchObject({ reviewedContract: false, repositoryBasis: 'dated-registry-id-not-remote-proof', sourceSha: null, observedRepository: null });
      expect(plan.holds).toEqual(expect.arrayContaining(['source-observation-missing', 'unreviewed-repository-release-contract']));
      expect(plan.artifacts[0]?.kind).toBe('unknown'); expect(plan.tasks.every(t => t.status === 'held' && t.workflow === null)).toBe(true);
    }
    const supplied = result.repositories.find(r => r.repository === 'ashlrai/future-tool')!;
    expect(supplied.repositoryBasis).toBe('reported-local-snapshot'); expect(supplied.sourceSha).toBe(SHA);
    expect(supplied.holds).toContain('unreviewed-repository-release-contract');
  });
  it('rejects forged schemas, sparse/getter records, duplicate aliases, traversal and unknown evidence states', () => {
    const corrupt: unknown[] = [{ ...snapshot(), approved: true }, { ...snapshot(), repositories: new Array(1) }];
    const aliases = snapshot(); aliases.repositories.push({ ...observation(), repository: 'ashlrai/ashlr-hub' }); corrupt.push(aliases);
    const nested = snapshot(); Object.defineProperty(nested.repositories[0]!.qualification, 'ci', { get: () => { throw new Error('getter invoked'); }, enumerable: true }); corrupt.push(nested);
    const traversal = snapshot(); traversal.repositories[0]!.packages[0]!.path = '../package.json'; corrupt.push(traversal);
    const invalid = snapshot(); (invalid.repositories[0]!.qualification as unknown as { ci: string }).ci = 'authorized'; corrupt.push(invalid);
    for (const s of corrupt) expect(() => buildEcosystemReleasePlan(s, NOW, registry)).toThrow();
    let called = false; const claimedRegistry = { get repositories() { called = true; return []; } };
    expect(buildEcosystemReleasePlan(snapshot(), NOW, claimedRegistry).releaseAdmission).toBe(false); expect(called).toBe(false);
  });
  it('runs the actual local source CLI without changing its input and refuses linked files/unknown verbs', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-release-plan-')));
    try {
      const file = join(dir, 'snapshot.json'); const content = JSON.stringify(snapshot()); writeFileSync(file, content);
      expect(runEcosystemReleasePlan(['--input', file], NOW).releaseAdmission).toBe(false); expect(readFileSync(file, 'utf8')).toBe(content);
      const linked = join(dir, 'linked.json'); symlinkSync(file, linked); expect(() => runEcosystemReleasePlan(['--input', linked], NOW)).toThrow();
      expect(() => runEcosystemReleasePlan(['--publish', file], NOW)).toThrow(); expect(() => runEcosystemReleasePlan(['--input', 'https://example.invalid'], NOW)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses same-inode growth and shrinkage after inspection without an unbounded FD read', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-release-plan-growth-')));
    const file = join(dir, 'snapshot.json'); writeFileSync(file, '{}');
    const fd = openSync(file, 'r');
    try {
      const observed = fstatSync(fd);
      expect(readBoundedSnapshotBytes(fd, observed.size).toString()).toBe('{}');
      appendFileSync(file, Buffer.alloc(5 * 1024 * 1024));
      expect(fstatSync(fd).ino).toBe(observed.ino);
      expect(() => readBoundedSnapshotBytes(fd, observed.size)).toThrow('Changed local snapshot');
      truncateSync(file, 1);
      expect(() => readBoundedSnapshotBytes(fd, observed.size)).toThrow('Changed local snapshot');
      expect(() => readBoundedSnapshotBytes(fd, 4 * 1024 * 1024 + 1)).toThrow('Unsafe local snapshot');
    } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  });
});
