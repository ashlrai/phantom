/* global Buffer */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { captureArtifact, fastJobPolicy, qualifyArtifact, verifyArtifact, adoptArtifact } from '../../scripts/hosted-build-artifact.mjs';
import { fixture, metadata, digest } from './helpers/hosted-artifact-fixture.mjs';

function fastFixture(t) {
  const repository = 'ashlrai/phantom';
  const f = fixture(t, true, repository, '@ashlr/phantom', {
    '.github/workflows/ci.yml': 'name: Desktop release smoke\nsteps:\n  - name: Verify green master push CI\n  - name: Smoke desktop release artifact\n  - name: Upload qualified build handoff\n',
  });
  captureArtifact(f.options);
  const manifestPath = join(f.out, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.producer.eventSha = f.sha;
  fs.chmodSync(manifestPath, 0o600); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const binary = Buffer.from('synthetic native executable bytes; never executed');
  fs.writeFileSync(join(f.out, 'desktop-smoke-bin'), binary);
  const tree = f.git('rev-parse', 'HEAD^{tree}'); const attestorSha = 'c'.repeat(40);
  const smoke = { schemaVersion: 1, source: { revision: f.sha, tree }, pushCi: { runId: 90, runAttempt: 2 },
    desktop: { filename: 'desktop-smoke-bin', sha256: digest(binary), bytes: binary.length, version: '3.24.3', revision: f.sha },
    smoke: { exitCode: 0, feedParsed: true, manifestParsed: true, versionVerified: true } };
  const writeSmoke = () => fs.writeFileSync(join(f.out, 'fast-release.json'), JSON.stringify(smoke)); writeSmoke();
  const artifactMap = { profile: 'fast-release-v1', producer: { id: 200, name: 'ashlr-build-100-1', digest: `sha256:${'d'.repeat(64)}` }, lanes: [] };
  const runs = {
    90: { id: 90, run_attempt: 2, repository: metadata(repository), head_sha: f.sha, head_branch: 'master', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' },
    100: { id: 100, run_attempt: 1, repository: metadata(repository), head_sha: f.sha, head_branch: 'master', event: 'workflow_dispatch', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' },
    300: { id: 300, run_attempt: 1, repository: metadata(repository), head_sha: attestorSha, head_branch: 'master', event: 'workflow_dispatch', path: '.github/workflows/attest-ci-build.yml', status: 'completed', conclusion: 'success' },
  };
  const job = (run, name, steps, labels = ['ubuntu-latest']) => ({ id: name.length, run_id: run, head_sha: f.sha, name, labels, status: 'completed', conclusion: 'success', steps: steps.map(name => ({ name, status: 'completed', conclusion: 'success' })) });
  const pushJobs = [job(90, 'Secret-shape scan', ['Scan candidate diff (fail closed)']), job(90, 'Quick typecheck', ['Core no-emit type check', 'Check authority drift (hermetic)']), job(90, 'Classify PR site lane', ['Bind candidate source']), job(90, 'Merge Gate', ['Require selected CI lane'])];
  const fastJobs = fastJobPolicy(f.root).map(row => job(100, row.name, row.steps, row.labels));
  const read = endpoint => {
    if (endpoint === `repos/${repository}`) return metadata(repository);
    if (endpoint.includes('/git/commits/')) return { sha: endpoint.split('/').at(-1), tree: { sha: tree } };
    if (endpoint.endsWith('/branches/master')) return { commit: { sha: attestorSha } };
    if (endpoint.includes('/artifacts/')) return { ...artifactMap.producer, expired: false, workflow_run: { id: 100, head_sha: f.sha } };
    const run = Number(/\/runs\/(\d+)\//.exec(endpoint)?.[1]); assert.ok(runs[run], `unexpected endpoint ${endpoint}`);
    if (endpoint.includes('/jobs?')) { const jobs = run === 90 ? pushJobs : fastJobs; return { total_count: jobs.length, jobs }; }
    return runs[run];
  };
  const qualify = () => qualifyArtifact({ root: f.root, revision: f.sha, bundle: f.out, artifactMap, runId: 100, runAttempt: 1, read });
  const attestRun = (_bin, args) => JSON.stringify([{ verificationResult: { statement: {
    _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ digest: { sha256: digest(fs.readFileSync(args[2])) } }],
    predicate: { runDetails: { metadata: { invocationId: `https://github.com/${repository}/actions/runs/300/attempts/1` } } },
  } } }]);
  const verify = () => verifyArtifact({ root: f.root, revision: f.sha, bundle: f.out, githubRead: read, attestRun,
    policy: { runId: 100, runAttempt: 1, attestorSha, attestorRun: 300, attestorAttempt: 1 } });
  return { ...f, smoke, writeSmoke, runs, pushJobs, fastJobs, qualify, verify, artifactMap };
}

test('fast profile reuses exact green master push and native smoke with original signed subjects', t => {
  const f = fastFixture(t); const q = f.qualify();
  assert.equal(q.profile, 'fast-release-v1'); assert.deepEqual(q.lanes, []);
  assert.deepEqual(q.closure.map(row => row.path), ['fast-release.json', 'desktop-smoke-bin']);
  const receipt = f.verify(); assert.equal(receipt.official.runId, 100);
  fs.rmSync(join(f.root, 'dist'), { recursive: true }); adoptArtifact(receipt);
  assert.equal(fs.readFileSync(join(f.root, 'dist/api/core.js'), 'utf8'), 'built:api/core.js');
});

test('scheduled producer and attestor preserve exact-source fast qualification', t => {
  const f = fastFixture(t); f.runs[100].event = 'schedule'; f.runs[300].event = 'schedule';
  f.qualify(); assert.equal(f.verify().official.runId, 100);
});

for (const mutation of ['push failure', 'manual CI', 'wrong push sha', 'wrong push attempt', 'fork CI', 'skipped step', 'duplicate job', 'self-hosted CI', 'wrong producer workflow', 'wrong producer event', 'wrong producer branch', 'self-hosted smoke', 'missing smoke step', 'binary changed', 'version mismatch', 'receipt false', 'unknown profile', 'full lanes']) {
  test(`fast qualification refuses ${mutation}`, t => {
    const f = fastFixture(t);
    if (mutation === 'push failure') f.runs[90].conclusion = 'failure';
    if (mutation === 'manual CI') f.runs[90].event = 'workflow_dispatch';
    if (mutation === 'wrong push sha') f.runs[90].head_sha = 'd'.repeat(40);
    if (mutation === 'wrong push attempt') f.runs[90].run_attempt = 1;
    if (mutation === 'fork CI') f.runs[90].repository.id++;
    if (mutation === 'skipped step') f.pushJobs[1].steps[1].conclusion = 'skipped';
    if (mutation === 'duplicate job') f.pushJobs.push({ ...f.pushJobs[0] });
    if (mutation === 'self-hosted CI') f.pushJobs[0].labels.push('self-hosted');
    if (mutation === 'wrong producer workflow') f.runs[100].path = '.github/workflows/other.yml';
    if (mutation === 'wrong producer event') f.runs[100].event = 'push';
    if (mutation === 'wrong producer branch') f.runs[100].head_branch = 'feature';
    if (mutation === 'self-hosted smoke') f.fastJobs[0].labels.push('self-hosted');
    if (mutation === 'missing smoke step') f.fastJobs[0].steps.pop();
    if (mutation === 'binary changed') fs.appendFileSync(join(f.out, 'desktop-smoke-bin'), 'changed');
    if (mutation === 'version mismatch') f.smoke.desktop.version = '3.24.4';
    if (mutation === 'receipt false') f.smoke.smoke.feedParsed = false;
    if (mutation === 'unknown profile') f.artifactMap.profile = 'anything';
    if (mutation === 'full lanes') f.artifactMap.lanes.push({ role: 'mac-general-1' });
    f.writeSmoke(); assert.throws(f.qualify);
  });
}

test('fresh adoption rechecks the smoke bytes and push CI instead of trusting signed JSON alone', t => {
  const f = fastFixture(t); f.qualify(); f.runs[90].conclusion = 'failure'; assert.throws(f.verify);
  f.runs[90].conclusion = 'success'; const receipt = f.verify();
  fs.appendFileSync(join(f.out, 'desktop-smoke-bin'), 'changed after admission');
  fs.rmSync(join(f.root, 'dist'), { recursive: true }); assert.throws(() => adoptArtifact(receipt));
  assert.equal(fs.existsSync(join(f.root, 'dist')), false);
});

test('scheduled attestation outside master is rejected despite otherwise matching bytes', t => {
  const f = fastFixture(t); f.qualify();
  f.runs[300].event = 'schedule'; f.runs[300].head_branch = 'feature';
  assert.throws(f.verify);
});
