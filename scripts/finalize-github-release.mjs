#!/usr/bin/env node
// Protected-master verifier only. Candidate archives and release assets are data;
// the write runner receives a bounded receipt, never candidate code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireProducerEnvironment, requireRepositoryMetadata, requireRepositoryReference} from '../.github/scripts/github-repository-binding.mjs';
import {assertEffectiveManualProtection} from './hosted-build-artifact.mjs';
import {verifyHandoff, verifyCanonicalProvenance} from './canonical-npm-publisher.mjs';
import {readBoundedJson} from './verify-npm-release-provenance.mjs';
import {verifyUpdateAudit} from './finalize-desktop-update.mjs';
import {DESKTOP_RELEASE_APPLE_SIGNER} from './desktop-release-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'ashlrai/phantom', BASE = `repos/${REPO}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => {assert.match(value ?? '', /^[1-9][0-9]*$/); const n = Number(value); assert.ok(Number.isSafeInteger(n)); return n;};
const gh = args => execFileSync('gh', ['api', '--hostname', 'github.com', ...args], {timeout: 120_000, maxBuffer: 32 * 1024 * 1024});
const read = endpoint => JSON.parse(gh([endpoint]));
const output = (env, values) => fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));

export function finalizationInput(env) {
  assert.equal(requireProducerEnvironment(env).repository, REPO);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/master');
  assert.equal(env.CONFIRM_STABLE_FINALIZATION, 'true');
  for (const value of [env.GITHUB_SHA, env.CANDIDATE_SHA]) assert.match(value ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.VERSION ?? '', /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.ok(env.VERSION.length <= 32 && env.VERSION.split('.').every(n => Number.isSafeInteger(Number(n))));
  assert.match(env.CANDIDATE_INTEGRITY ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(Buffer.from(env.CANDIDATE_INTEGRITY.slice(7), 'base64').toString('base64'), env.CANDIDATE_INTEGRITY.slice(7));
  return {version: env.VERSION, tag: `v${env.VERSION}`, candidateSha: env.CANDIDATE_SHA, integrity: env.CANDIDATE_INTEGRITY,
    publishRun: integer(env.PUBLISH_RUN_ID), publishAttempt: integer(env.PUBLISH_RUN_ATTEMPT),
    workflowSha: env.GITHUB_SHA, workflowRun: integer(env.GITHUB_RUN_ID), workflowAttempt: integer(env.GITHUB_RUN_ATTEMPT)};
}

export function bindCanonicalRun(input, run, jobs) {
  requireRepositoryReference(REPO, run.repository);
  assert.equal(run.id, input.publishRun); assert.equal(run.run_attempt, input.publishAttempt);
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(run.path, '.github/workflows/publish-canonical-npm.yml');
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_branch, 'master');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.ok(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length === 4, 'incomplete canonical jobs');
  for (const name of ['admit', 'publish', 'consumer', 'promote']) {
    const matches = jobs.jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1); const job = matches[0];
    assert.equal(job.run_id, input.publishRun); assert.equal(job.head_sha, run.head_sha);
    assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  }
  return run;
}

export function canonicalEvidence(input, api = read) {
  const run = bindCanonicalRun(input, api(`${BASE}/actions/runs/${input.publishRun}/attempts/${input.publishAttempt}`),
    api(`${BASE}/actions/runs/${input.publishRun}/attempts/${input.publishAttempt}/jobs?per_page=100`));
  const listing = api(`${BASE}/actions/runs/${input.publishRun}/artifacts?per_page=100`);
  assert.ok(Array.isArray(listing.artifacts) && listing.total_count === listing.artifacts.length, 'incomplete artifact listing');
  const matches = listing.artifacts.filter(a => a.name === `phantom-npm-admitted-${input.publishRun}-${input.publishAttempt}`);
  assert.equal(matches.length, 1, 'admission artifact absent or ambiguous');
  const artifact = matches[0];
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.equal(artifact.expired, false); assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024);
  assert.equal(artifact.workflow_run?.id, input.publishRun); assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  return {run, artifact};
}

export function tagCommit(input, api = read) {
  const ref = api(`${BASE}/git/ref/tags/${input.tag}`); assert.equal(ref.ref, `refs/tags/${input.tag}`);
  let target = ref.object; const seen = new Set();
  for (let depth = 0; target?.type === 'tag'; depth++) {
    assert.ok(depth < 4 && /^[a-f0-9]{40}$/.test(target.sha ?? '') && !seen.has(target.sha), 'invalid tag chain');
    seen.add(target.sha); const tag = api(`${BASE}/git/tags/${target.sha}`); assert.equal(tag.sha, target.sha); target = tag.object;
  }
  assert.equal(target?.type, 'commit'); assert.equal(target.sha, input.candidateSha, 'tag differs from admitted candidate');
  const commit = api(`${BASE}/git/commits/${target.sha}`); assert.equal(commit.sha, input.candidateSha);
  assert.match(commit.tree?.sha ?? '', /^[a-f0-9]{40}$/); return commit;
}

export function releaseSnapshot(input, release, assets, draft = true) {
  assert.ok(Number.isSafeInteger(release?.id) && release.id > 0);
  assert.equal(release.tag_name, input.tag); assert.equal(release.target_commitish, input.candidateSha);
  assert.equal(release.draft, draft, 'release is already published — refusing to touch a live feed');
  assert.equal(release.prerelease, false); assert.equal(release.immutable, false);
  assert.ok(typeof release.name === 'string' && release.name.trim().length > 0 && release.name.length <= 256);
  assert.ok(typeof release.body === 'string' && release.body.trim().length > 0 && Buffer.byteLength(release.body) <= 64 * 1024, 'release notes required');
  const names = [`ashlr-phantom-${input.version}.tgz`, `ashlr-phantom-${input.version}.tgz.sig`, `Phantom_${input.version}_aarch64.app.tar.gz`, `Phantom_${input.version}_aarch64.app.tar.gz.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
  assert.ok(Array.isArray(assets)); assert.deepEqual(assets.map(a => a.name).sort(), names.sort(), 'complete signed seven-asset set required');
  assert.equal(new Set(assets.map(a => a.id)).size, 7);
  for (const asset of assets) {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 512 * 1024 * 1024);
    assert.equal(asset.state, 'uploaded'); assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(asset.browser_download_url, `https://github.com/${REPO}/releases/download/${input.tag}/${asset.name}`);
  }
  const rows = assets.map(({id, name, label, content_type, size, state, digest, browser_download_url}) => ({id, name, label, content_type, size, state, digest, browser_download_url})).sort((a, b) => a.id - b.id);
  return {id: release.id, tag: input.tag, target: release.target_commitish, name: release.name,
    bodySha256: hash(release.body), assetsSha256: hash(JSON.stringify(rows))};
}

export function draftObservation(input, api = read) {
  const matches = [];
  for (let page = 1; ; page++) {
    assert.ok(page <= 100, 'release pagination limit');
    const rows = api(`${BASE}/releases?per_page=100&page=${page}`); assert.ok(Array.isArray(rows));
    matches.push(...rows.filter(r => r.tag_name === input.tag));
    if (rows.length < 100) break;
  }
  assert.equal(matches.length, 1, 'exactly one existing release required; never create a second release');
  const release = api(`${BASE}/releases/${matches[0].id}`);
  const assets = api(`${BASE}/releases/${release.id}/assets?per_page=100`);
  return {release, assets, snapshot: releaseSnapshot(input, release, assets)};
}

/** Exact publisher/consumer envelope and bytes; downloads by authenticated asset
 * ID work for drafts, whose public /download URLs deliberately do not serve. */
export async function verifySignedAssets(input, record, observation, primitives, download) {
  const files = new Map();
  for (const asset of observation.assets) {
    const maximum = asset.name === 'latest.json' ? 128 * 1024 : asset.name === 'manifest.json' ? 64 * 1024 : asset.name.endsWith('.sig') ? 8192 : asset.size;
    assert.ok(asset.size <= maximum);
    const bytes = await download(asset, maximum);
    assert.ok(Buffer.isBuffer(bytes) && bytes.length === asset.size && hash(bytes) === asset.digest.slice(7), 'asset bytes differ');
    files.set(asset.name, bytes);
  }
  const utf8 = name => {const bytes = files.get(name), value = bytes.toString('utf8'); assert.ok(Buffer.from(value).equals(bytes)); return value;};
  const manifestText = utf8('manifest.json'), signature = utf8('manifest.json.sig');
  const m = primitives.verifyCompatibleUpdateManifest({manifestText, signature}, primitives.trust).manifest;
  assert.equal(m.schemaVersion, 2); assert.equal(m.version, input.version); assert.equal(m.repository.nameWithOwner, REPO);
  assert.equal(m.cli.packageName, '@ashlr/phantom'); assert.equal(m.source.revision, input.candidateSha);
  assert.equal(m.app.signer, DESKTOP_RELEASE_APPLE_SIGNER);
  assert.equal(m.cli.sha256, record.sha256); assert.equal(m.qualification.packageSha256, record.sha256);
  assert.deepEqual(m.qualification.attestor, record.attestor);
  assert.deepEqual({runId: m.qualification.producer.runId, runAttempt: m.qualification.producer.runAttempt}, record.producer);
  for (const a of [m.app, m.cli]) {
    const bytes = files.get(a.filename); assert.ok(bytes && bytes.length === a.bytes && hash(bytes) === a.sha256);
    assert.equal(utf8(`${a.filename}.sig`), a.signature);
    primitives.verifyMinisign(bytes, a.signature, primitives.trust.publicKey);
  }
  const expected = {version: m.version, platforms: {'darwin-aarch64': {url: m.app.url, signature: m.app.signature}}, phantom: {manifestText, signature}};
  assert.equal(utf8('latest.json'), primitives.canonicalJson(expected), 'feed differs from signed envelope');
  return m;
}

function protectedSource(input, api = read) {
  requireRepositoryMetadata(REPO, api(BASE));
  const rules = api(`${BASE}/rules/branches/master?per_page=100`);
  assert.ok(Array.isArray(rules) && rules.length < 100, 'incomplete branch rules');
  assert.equal(assertEffectiveManualProtection(REPO, api(`${BASE}/branches/master`), rules), input.workflowSha);
  assert.ok(['ahead', 'identical'].includes(api(`${BASE}/compare/${input.candidateSha}...${input.workflowSha}`).status));
}

export async function verifyFinalization(env = process.env) {
  const input = finalizationInput(env); protectedSource(input);
  const evidence = canonicalEvidence(input);
  assert.equal(evidence.artifact.id, integer(env.ADMISSION_ARTIFACT_ID));
  const commit = tagCommit(input), observation = draftObservation(input);
  const directory = join(env.RUNNER_TEMP, 'finalizer-admission');
  const row = readBoundedJson(join(directory, 'admission.json'));
  const record = verifyHandoff(directory, hash(fs.readFileSync(join(directory, 'admission.json'))), row.sha256);
  assert.equal(record.version, input.version); assert.equal(record.candidateRevision, input.candidateSha); assert.equal(record.integrity, input.integrity);
  assert.equal(record.attestor.revision, evidence.run.head_sha);
  // The downloaded admission is authenticated by the exact successful run and
  // immutable artifact digest. Rehash both files before trusting its identity.
  const work = fs.mkdtempSync(join(env.RUNNER_TEMP, 'finalizer-registry-'));
  fs.writeFileSync(join(work, 'package.json'), '{"private":true}');
  const npmEnv = {...process.env, NPM_CONFIG_USERCONFIG: join(work, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(work, 'global-npmrc'), NPM_CONFIG_IGNORE_SCRIPTS: 'true'};
  fs.writeFileSync(npmEnv.NPM_CONFIG_USERCONFIG, ''); fs.writeFileSync(npmEnv.NPM_CONFIG_GLOBALCONFIG, '');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org', `@ashlr/phantom@${input.version}`], {cwd: work, env: npmEnv, timeout: 180_000, stdio: 'pipe'});
  const audit = JSON.parse(execFileSync('npm', ['audit', 'signatures', '--json', '--include-attestations', '--registry=https://registry.npmjs.org'], {cwd: work, env: npmEnv, timeout: 180_000, maxBuffer: 32 * 1024 * 1024}));
  const provenance = verifyCanonicalProvenance(record, audit, evidence.run.head_sha, String(input.publishRun), String(input.publishAttempt), read);
  const metadata = JSON.parse(execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30', '--max-filesize', '33554432', 'https://registry.npmjs.org/@ashlr%2Fphantom'], {maxBuffer: 32 * 1024 * 1024}));
  assert.equal(metadata.name, '@ashlr/phantom'); assert.equal(metadata['dist-tags']?.latest, input.version);
  assert.equal(metadata.versions?.[input.version]?.dist?.integrity, input.integrity);
  const [manifest, trust, canonical] = await Promise.all([import('../src/core/desktop/update-manifest.ts'), import('../src/core/desktop/update-trust.ts'), import('../src/core/authority/canonical-json.ts')]);
  const m = await verifySignedAssets(input, record, observation, {...manifest, ...canonical, trust: trust.getDesktopUpdateTrustForProfile('canonical-v2')}, (asset, maximum) =>
    execFileSync('gh', ['api', '--hostname', 'github.com', '-H', 'Accept: application/octet-stream', `${BASE}/releases/assets/${asset.id}`], {timeout: 120_000, maxBuffer: maximum + 1}));
  assert.equal(m.source.tree, commit.tree.sha);
  verifyUpdateAudit({root: ROOT, repository: REPO, revision: input.candidateSha, ...m.qualification.audit, read});
  // A concurrent publisher must cause a hold, never a second PATCH to public.
  protectedSource(input); assert.deepEqual(tagCommit(input), commit);
  assert.deepEqual(canonicalEvidence(input), evidence);
  assert.deepEqual(draftObservation(input).snapshot, observation.snapshot);
  const receipt = {schemaVersion: 2, admission: 'phantom-stable-finalization', input, release: observation.snapshot,
    evidence: {artifactId: evidence.artifact.id, artifactDigest: evidence.artifact.digest, publisherSha: evidence.run.head_sha, provenance},
    verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), npmMutationAuthority: false, installAuthority: false, activationAuthority: false, githubReleaseMutationExecuted: false};
  const path = join(env.RUNNER_TEMP, 'github-stable-finalization-preflight.json'), bytes = Buffer.from(JSON.stringify(receipt));
  assert.ok(bytes.length <= 16384); fs.writeFileSync(path, bytes, {flag: 'wx', mode: 0o600});
  output(env, {receipt: path, receipt_sha256: hash(bytes)}); return receipt;
}

async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[3], '--json');
  if (process.argv[2] === 'prepare') {
    const input = finalizationInput(process.env); protectedSource(input);
    const {artifact} = canonicalEvidence(input); output(process.env, {artifact_id: artifact.id});
    console.log(JSON.stringify({state: 'prepared', artifactId: artifact.id}));
  } else {
    assert.equal(process.argv[2], 'verify'); console.log(JSON.stringify(await verifyFinalization()));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await main();} catch {console.error(JSON.stringify({state: 'held', reason: 'Stable finalization evidence failed; no release mutation authorized.'})); process.exitCode = 1;}
}
