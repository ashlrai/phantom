/** Pure release dependency planning. Reported local observations grant no effect authority. */
import { canonicalJson } from '../authority/canonical-json.js';
import { RELEASE_CI_JOBS } from '../release-public-facts.js';

type EvidenceState = 'success' | 'pending' | 'failed' | 'unknown';
type ArtifactKind = 'npm' | 'npm-wrapper' | 'signed-desktop' | 'rust-binaries' | 'go-agent' | 'plugin-vsix' | 'website' | 'verification' | 'unknown';
interface Artifact { kind: ArtifactKind; packagePath: string | null; packageName: string | null }
interface Contract {
  repository: string; registryId: string | null; defaultBranch: string;
  artifacts: readonly Artifact[]; metadata: readonly string[]; ci: string | null;
  release: readonly { id: string; workflow: string | null; dependsOn: readonly string[]; purpose: string }[];
  limitations: readonly string[]; proposeOnly?: boolean;
}
const artifact = (kind: ArtifactKind, packagePath: string | null = null, packageName: string | null = null): Artifact => ({ kind, packagePath, packageName });
const step = (id: string, workflow: string | null, dependsOn: string[], purpose: string) => ({ id, workflow, dependsOn, purpose });
// Reviewed source pathways, not a list of commissioned publishers or signed grants.
const CONTRACTS: readonly Contract[] = [
  { repository: 'ashlrai/phantom', registryId: 'ashlr-hub', defaultBranch: 'master',
    artifacts: [artifact('npm', 'package.json', '@ashlr/phantom'), artifact('signed-desktop')],
    metadata: ['scripts/sync-candidate-version.mjs', 'scripts/check-documentation.mjs'], ci: '.github/workflows/ci.yml',
    release: [step('audit', '.github/workflows/dependency-audit.yml', ['ci'], 'Exact-source independent Audit'),
      step('attest', '.github/workflows/attest-ci-build.yml', ['protected-source', 'audit'], 'Attest the original full CI artifact and attempt'),
      step('npm', '.github/workflows/publish-canonical-npm.yml', ['attest'], 'Commissioned canonical OIDC publisher, registry bytes, provenance and one latest promotion'),
      step('native', null, ['npm'], 'Pinned maintainer finalizer, seven signed assets, matching tag and separate installer qualification'),
      step('public-facts', null, ['native'], 'Fresh release-public-facts verification; serialized facts are not admission'),
      step('site', null, ['public-facts'], 'Existing website-release-metadata task lane and separately owned qualified site publication')],
    limitations: ['Full fifteen-job original CI required; documentation/site PR feedback never qualifies release.', 'Native and site acceptance are separate from npm.'] },
  { repository: 'ashlrai/phantom-secrets', registryId: 'phantom-secrets', defaultBranch: 'main',
    artifacts: [artifact('rust-binaries'), artifact('npm-wrapper', 'npm/package.json', 'phantom-secrets'), artifact('npm-wrapper', 'npm-mcp/package.json', 'phantom-secrets-mcp'), artifact('website')],
    metadata: ['scripts/release/check-version-parity.mjs'], ci: '.github/workflows/ci.yml',
    release: [step('binaries', '.github/workflows/release.yml', ['protected-source'], 'Existing tagged build, attestation and approved release artifact chain'),
      step('wrapper-acceptance', '.github/workflows/npm-candidate-acceptance.yml', ['binaries'], 'Existing npm wrapper acceptance; does not publish'),
      step('wrapper-publisher', null, ['wrapper-acceptance'], 'No reviewed npm publication workflow: commission an exact wrapper publisher before publishing'),
      step('site', null, ['binaries'], 'Separate existing site owner and deployment acceptance')], limitations: ['npm wrapper acceptance is not npm publication commissioning.'] },
  { repository: 'ashlrai/ashlr-plugin', registryId: 'ashlr-plugin', defaultBranch: 'main', artifacts: [artifact('plugin-vsix'), artifact('website')],
    metadata: ['scripts/check-version-sync.ts', 'scripts/bump-version.ts', 'package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md'], ci: '.github/workflows/ci.yml',
    release: [step('plugin', '.github/workflows/release.yml', ['protected-source'], 'Existing tagged VSIX and site archive release'),
      step('site', '.github/workflows/deploy-site.yml', ['plugin'], 'Existing Vercel site owner and deployment verification'),
      step('server', '.github/workflows/deploy-server.yml', ['protected-source'], 'Separate existing Railway server owner and deployment verification')],
    limitations: ['Plugin/VSIX and website products do not imply a commissioned npm product.'] },
  { repository: 'ashlrai/ashlrcode', registryId: 'ashlrcode', defaultBranch: 'main', artifacts: [artifact('npm', 'package.json', 'ashlrcode')],
    metadata: ['package.json', 'README.md', 'CHANGELOG.md'], ci: null,
    release: [step('npm', '.github/workflows/publish.yml', ['protected-source'], 'Existing release-published Bun test/build and npm provenance workflow')],
    limitations: ['Existing token publisher does not prove OIDC commissioning.', 'Exact source/tag/version checks and frozen dependency installation need source qualification.'] },
  { repository: 'ashlrai/binshield', registryId: 'binshield', defaultBranch: 'main', artifacts: [artifact('npm', 'packages/cli/package.json', '@binshield/cli')],
    metadata: ['packages/cli/package.json', 'README.md', 'CHANGELOG.md'], ci: null,
    release: [step('release', '.github/workflows/release.yml', ['protected-source'], 'Existing manual GitHub release workflow'),
      step('npm-publisher', null, ['release'], 'No reviewed npm publisher for the actual CLI package')], limitations: ['Root private workspace and addon fixtures are not npm release targets.'] },
  { repository: 'ashlrai/ashlr-pulse', registryId: 'ashlr-pulse', defaultBranch: 'main', artifacts: [artifact('go-agent')], metadata: ['README.md', 'CHANGELOG.md'], ci: null,
    release: [step('agent', '.github/workflows/release-agent.yml', ['protected-source'], 'Existing tagged Go agent artifacts')], limitations: ['Go agent release does not imply publishing the separate server package to npm.'] },
  { repository: 'ashlrai/locus', registryId: 'locus', defaultBranch: 'main', artifacts: [artifact('rust-binaries'), artifact('npm-wrapper', 'npm/package.json', 'locus-cli'), artifact('npm-wrapper', 'npm-mcp/package.json', '@ashlrai/locus-mcp')],
    metadata: ['Cargo.toml', 'npm/package.json', 'npm-mcp/package.json', 'README.md'], ci: '.github/workflows/ci.yml',
    release: [step('rust', '.github/workflows/release.yml', ['protected-source'], 'Existing tagged Rust platform artifacts'),
      step('wrapper-publisher', null, ['rust'], 'Wrapper parity/pack verification and publisher commissioning are unresolved')], limitations: ['Rust release is not proof that npm wrappers were published.'] },
  { repository: 'ashlrai/measurably', registryId: null, defaultBranch: 'main', artifacts: [artifact('website')], metadata: ['README.md', 'CHANGELOG.md'], ci: '.github/workflows/ci.yml',
    release: [step('production', '.github/workflows/production-release.yml', ['protected-source'], 'Existing exact main CI / approved SHA / Production environment owner contract')],
    limitations: ['Private root and CLI are not npm targets.', 'Manual staging/native validation do not prove production promotion; owner, billing, provider and database holds remain explicit.'] },
  { repository: 'ashlrai/fleet-canary', registryId: null, defaultBranch: 'main', artifacts: [artifact('verification')], metadata: ['README.md'], ci: '.github/workflows/ci.yml', release: [], limitations: ['Verification repository: no npm/tag/deployment output is presumed.'] },
  ...['ashlr-cortex', 'ashlr-auth', 'ashlr-config', 'ashlr-cost', 'ashlr-core-efficiency'].map((name): Contract => ({
    repository: `ashlrai/${name}`, registryId: name === 'ashlr-cortex' ? null : name,
    defaultBranch: ['ashlr-auth', 'ashlr-config', 'ashlr-cost'].includes(name) ? 'master' : 'main',
    artifacts: [name === 'ashlr-core-efficiency' ? artifact('npm', 'package.json', '@ashlr/core-efficiency') : artifact('unknown')],
    metadata: ['README.md', 'package.json'], ci: name === 'ashlr-core-efficiency' ? '.github/workflows/ci.yml' : null,
    release: [step('contract-review', null, ['protected-source'], 'No reviewed release publisher: establish current source, product artifact and owner contract')],
    limitations: ['Missing release automation is not an instruction to publish a generic npm package.'], proposeOnly: name !== 'ashlr-cortex',
  })),
];

export interface ReleaseRepositoryObservation {
  repository: string; defaultBranch: string; sourceSha: string; defaultSha: string; treeSha: string; dirty: boolean; version: string | null;
  packages: { path: string; name: string; version: string; private: boolean }[];
  docs: { readme: boolean; changelog: boolean; synchronized: boolean };
  workflows: { path: string; sourceSha: string }[];
  qualification: { sourceSha: string | null; coverage: 'full' | 'documentation-pr' | 'frontend-pr' | 'site-pr' | 'unknown' | 'absent'; ci: EvidenceState; audit: EvidenceState; originalArtifact: 'present' | 'missing' | 'unknown' };
  publicFacts: { sourceSha: string; version: string; observedAt: string } | null;
  ownership: { stage: 'merge' | 'propose' | 'unknown'; publication: 'commissioned' | 'uncommissioned' | 'unknown'; blockers: string[] };
}
export interface ReleasePlanSnapshot { schemaVersion: 1; observedAt: string; repositories: ReleaseRepositoryObservation[] }
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_AGE_MS = 5 * 60_000;
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d && d.enumerable; });
}
function array(value: unknown, max: number, check: (x: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d) || !check(d.value)) return false; }
  return true;
}
// eslint-disable-next-line no-control-regex
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(x);
const path = (x: unknown): x is string => text(x) && !x.startsWith('/') && !x.includes('\\') && !x.split('/').some(p => p === '..' || p === '.' || p === '');
const date = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const hash = (x: unknown): x is string => typeof x === 'string' && SHA.test(x);
const version = (x: unknown): x is string => typeof x === 'string' && VERSION.test(x) && x.length <= 40;
const oneOf = (x: unknown, values: string[]): x is string => typeof x === 'string' && values.includes(x);
const state = (x: unknown) => oneOf(x, ['success', 'pending', 'failed', 'unknown']);
function observation(x: unknown): x is ReleaseRepositoryObservation {
  if (!record(x, ['repository', 'defaultBranch', 'sourceSha', 'defaultSha', 'treeSha', 'dirty', 'version', 'packages', 'docs', 'workflows', 'qualification', 'publicFacts', 'ownership'])) return false;
  return text(x.repository) && /^ashlrai\/[a-z0-9][a-z0-9-]*$/.test(x.repository) && text(x.defaultBranch)
    && hash(x.sourceSha) && hash(x.defaultSha) && hash(x.treeSha) && typeof x.dirty === 'boolean' && (x.version === null || version(x.version))
    && array(x.packages, 32, p => record(p, ['path', 'name', 'version', 'private']) && path(p.path) && text(p.name) && version(p.version) && typeof p.private === 'boolean')
    && record(x.docs, ['readme', 'changelog', 'synchronized']) && Object.values(x.docs).every(v => typeof v === 'boolean')
    && array(x.workflows, 64, w => record(w, ['path', 'sourceSha']) && path(w.path) && /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(w.path) && hash(w.sourceSha))
    && record(x.qualification, ['sourceSha', 'coverage', 'ci', 'audit', 'originalArtifact']) && (x.qualification.sourceSha === null || hash(x.qualification.sourceSha))
    && oneOf(x.qualification.coverage, ['full', 'documentation-pr', 'frontend-pr', 'site-pr', 'unknown', 'absent']) && state(x.qualification.ci) && state(x.qualification.audit)
    && oneOf(x.qualification.originalArtifact, ['present', 'missing', 'unknown'])
    && (x.publicFacts === null || record(x.publicFacts, ['sourceSha', 'version', 'observedAt']) && hash(x.publicFacts.sourceSha) && version(x.publicFacts.version) && date(x.publicFacts.observedAt))
    && record(x.ownership, ['stage', 'publication', 'blockers']) && oneOf(x.ownership.stage, ['merge', 'propose', 'unknown'])
    && oneOf(x.ownership.publication, ['commissioned', 'uncommissioned', 'unknown']) && array(x.ownership.blockers, 32, text);
}
const canonicalRepo = (repo: string): string => repo === 'ashlrai/ashlr-hub' ? 'ashlrai/phantom' : repo;
export interface ReleaseDependencyTask {
  id: string; dependsOn: string[]; workflow: string | null; purpose: string;
  status: 'held' | 'pending-independent-verification'; holds: string[];
}
/** nowMs is explicit. No implicit clock, readers, filesystem, network, queue or publisher. */
export function buildEcosystemReleasePlan(input: unknown, nowMs: number, registry: unknown) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8.64e15 || !record(input, ['schemaVersion', 'observedAt', 'repositories']) || input.schemaVersion !== 1
    || !date(input.observedAt) || !array(input.repositories, 64, observation)) throw new Error('Invalid bounded release plan snapshot');
  const snapshot = JSON.parse(canonicalJson(input)) as ReleasePlanSnapshot;
  if (!record(snapshot, ['schemaVersion', 'observedAt', 'repositories']) || snapshot.schemaVersion !== 1 || !date(snapshot.observedAt)
    || !array(snapshot.repositories, 64, observation)) throw new Error('Snapshot changed during copying');
  const observed = new Map(snapshot.repositories.map(o => [canonicalRepo(o.repository), o]));
  if (observed.size !== snapshot.repositories.length) throw new Error('Duplicate repository observation');
  for (const o of observed.values()) {
    if (new Set(o.packages.map(p => p.path)).size !== o.packages.length || new Set(o.workflows.map(w => w.path)).size !== o.workflows.length) throw new Error('Duplicate package or workflow observation');
  }
  // Reuse dated curated roles only. The registry is not current enrollment or release authority.
  const roles = new Map<string, string>();
  const registryIds = new Map<string, string>();
  const rows = registry && typeof registry === 'object' ? Object.getOwnPropertyDescriptor(registry, 'repositories') : undefined;
  if (rows && 'value' in rows && array(rows.value, 128, x => !!x && typeof x === 'object')) {
    for (const row of rows.value) {
      const id = Object.getOwnPropertyDescriptor(row, 'id'); const role = Object.getOwnPropertyDescriptor(row, 'role');
      if (id && 'value' in id && role && 'value' in role && text(id.value) && /^[a-z0-9][a-z0-9-]*$/.test(id.value) && text(role.value)) {
        roles.set(id.value, role.value);
        registryIds.set(canonicalRepo(`ashlrai/${id.value}`), id.value);
      }
    }
  }
  const fresh = (at: string): boolean => Date.parse(at) <= nowMs && nowMs - Date.parse(at) <= MAX_AGE_MS;
  const repositories = [...new Set([...CONTRACTS.map(c => c.repository), ...observed.keys(), ...registryIds.keys()])].sort().map(repository => {
    const contract = CONTRACTS.find(c => c.repository === repository); const o = observed.get(repository);
    const holds: string[] = [];
    if (!o) holds.push('source-observation-missing');
    else {
      if (!fresh(snapshot.observedAt)) holds.push('source-observation-stale-or-future');
      if (o.dirty) holds.push('dirty-source');
      if (o.sourceSha !== o.defaultSha) holds.push('protected-source-mismatch');
      if (o.version === null && contract?.artifacts[0]?.kind !== 'verification') holds.push('release-version-not-reported');
      if (contract && o.defaultBranch !== contract.defaultBranch) holds.push('default-branch-contract-mismatch');
      if (!o.docs.readme || !o.docs.synchronized) holds.push('documentation-not-synchronized');
      if (o.qualification.sourceSha !== o.sourceSha) holds.push('qualification-source-mismatch');
      if (o.qualification.coverage !== 'full') holds.push('full-coverage-not-reported');
      if (o.qualification.ci !== 'success') holds.push('successful-ci-not-reported');
      if (o.ownership.stage !== 'merge' || contract?.proposeOnly) holds.push('owner-proposal-or-unknown-stage');
      holds.push(...o.ownership.blockers);
      if (o.publicFacts && (!fresh(o.publicFacts.observedAt) || o.publicFacts.sourceSha !== o.sourceSha || o.publicFacts.version !== o.version)) holds.push('public-facts-stale-or-source-version-mismatch');
    }
    if (!contract) holds.push('unreviewed-repository-release-contract');
    const artifacts = (contract?.artifacts ?? [artifact('unknown')]).map(a => {
      const pkg = o?.packages.find(p => p.path === a.packagePath); const issues: string[] = [];
      if (a.packagePath && (!pkg || pkg.name !== a.packageName || pkg.version !== o?.version)) issues.push('package-identity-or-version-mismatch');
      if (pkg?.private) issues.push('private-package-not-publishable');
      return { ...a, version: pkg?.version ?? o?.version ?? null, holds: issues };
    });
    const prefix = `${repository}:`; const tasks: ReleaseDependencyTask[] = [];
    const add = (id: string, deps: string[], workflow: string | null, purpose: string, specific: string[] = []) => {
      const issues = [...holds, ...specific];
      for (const dep of deps) if (tasks.find(t => t.id === prefix + dep)?.status === 'held') issues.push(`dependency-held:${dep}`);
      if (workflow && !o?.workflows.some(w => w.path === workflow && w.sourceSha === o.sourceSha)) issues.push('workflow-missing-or-source-mismatch');
      tasks.push({ id: prefix + id, dependsOn: deps.map(x => prefix + x), workflow, purpose,
        status: issues.length ? 'held' : 'pending-independent-verification', holds: [...new Set(issues)].sort() });
    };
    add('source', [], null, 'Independent source review and preserve dirty/unique owner work');
    add('metadata', ['source'], null, 'Synchronize source version, public docs and changelog without relabeling unpublished work',
      o?.docs.changelog || contract?.artifacts[0]?.kind === 'verification' ? [] : ['changelog-not-reported']);
    add('ci', ['metadata'], contract?.ci ?? null, 'Fresh exact-source complete original CI; no PR-only receipt substitution', contract?.ci ? [] : ['qualification-workflow-unreviewed']);
    add('protected-source', ['ci'], null, 'Root-owned protected merge, identical tree and fresh source readback');
    for (const s of contract?.release ?? []) {
      const issues = s.id === 'audit' || o?.ownership.publication === 'commissioned' ? [] : ['publisher-commissioning-not-reported'];
      if (!s.workflow && ['wrapper-publisher', 'npm-publisher', 'contract-review'].includes(s.id)) issues.push('release-publisher-unsupported');
      if (s.id === 'audit' && o?.qualification.audit !== 'success') issues.push('independent-audit-not-reported');
      if (s.id === 'attest' && o?.qualification.originalArtifact !== 'present') issues.push('original-ci-artifact-not-reported');
      if (s.id.includes('npm') || s.id.includes('wrapper')) issues.push(...artifacts.flatMap(a => a.holds));
      add(s.id, [...s.dependsOn], s.workflow, s.purpose, issues);
    }
    const registryId = contract?.registryId ?? registryIds.get(repository);
    return { repository, reviewedContract: contract !== undefined,
      repositoryBasis: contract ? 'reviewed-contract' : o ? 'reported-local-snapshot' : 'dated-registry-id-not-remote-proof',
      observedRepository: o?.repository ?? null, defaultBranch: contract?.defaultBranch ?? o?.defaultBranch ?? null,
      reportedDefaultBranch: o?.defaultBranch ?? null, defaultSha: o?.defaultSha ?? null,
      sourceSha: o?.sourceSha ?? null, treeSha: o?.treeSha ?? null, dirty: o?.dirty ?? null, version: o?.version ?? null,
      docs: o?.docs ?? null, qualification: o?.qualification ?? null, ownership: o?.ownership ?? null,
      reportedWorkflows: o?.workflows ?? [], publicFacts: o?.publicFacts ?? null,
      registryRole: registryId ? roles.get(registryId) ?? null : null,
      registryBasis: 'dated-curated-role-only', artifacts, metadataInputs: [...(contract?.metadata ?? [])],
      requiredCiJobs: repository === 'ashlrai/phantom' ? [...RELEASE_CI_JOBS] : [],
      holds: [...new Set(holds)].sort(), limitations: [...(contract?.limitations ?? ['No reviewed artifact or publisher contract.'])], tasks };
  });
  return { schema: 'phantom-ecosystem-release-plan/v1', authority: false, releaseAdmission: false, effectsExecuted: false,
    evidenceBasis: 'reported-local-observations-not-attestation', observedAt: snapshot.observedAt,
    plannedAt: new Date(nowMs).toISOString(), observationMaxAgeMs: MAX_AGE_MS, repositories };
}
