/** M523: future Phantom drafts, with hermetic real-signature fixtures. No network or release mutations. */
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {nodeFixtureHeader} from './helpers/node-fixture.js';
import {parse} from 'yaml';
import {canonicalJson} from '../src/core/authority/canonical-json.js';
import {verifyCompatibleUpdateManifest, verifyMinisign, type CanonicalUpdateManifest} from '../src/core/desktop/update-manifest.js';
import {getDesktopUpdateTrustForProfile} from '../src/core/desktop/update-trust.js';
import {DESKTOP_RELEASE_APPLE_SIGNER} from '../scripts/desktop-release-policy.mjs';
import {finalizationInput, bindCanonicalRun, canonicalEvidence, tagCommit, releaseSnapshot, draftObservation, verifySignedAssets} from '../scripts/finalize-github-release.mjs';

const load = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n?/gu, '\n');
const workflowText = load('.github/workflows/finalize-github-release.yml');
const verifierText = load('scripts/finalize-github-release.mjs');
const workflow = parse(workflowText);
const effect = workflow.jobs.finalize.steps.find((step: {run?: string}) => step.run)?.run as string;
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = Buffer.from('disposable CLI fixture');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const env = {GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '2',
  CONFIRM_STABLE_FINALIZATION: 'true', VERSION: '3.30.9', CANDIDATE_SHA: 'b'.repeat(40), CANDIDATE_INTEGRITY: integrity, PUBLISH_RUN_ID: '12', PUBLISH_RUN_ATTEMPT: '3'};
const input = finalizationInput(env);
const repo = {id: 1263526319, node_id: 'R_kgDOS0_hrw', full_name: 'ashlrai/phantom', owner: {id: 258113726, login: 'ashlrai'}};
const run = {repository: repo, id: input.publishRun, run_attempt: input.publishAttempt, head_sha: 'c'.repeat(40), path: '.github/workflows/publish-canonical-npm.yml',
  event: 'workflow_dispatch', head_branch: 'master', status: 'completed', conclusion: 'success'};
const jobs = {total_count: 4, jobs: ['admit', 'publish', 'consumer', 'promote'].map(name => ({name, run_id: input.publishRun, head_sha: run.head_sha, status: 'completed', conclusion: 'success'}))};
const artifact = {id: 13, name: 'phantom-npm-admitted-12-3', expired: false, digest: `sha256:${'d'.repeat(64)}`, size_in_bytes: 1000, workflow_run: {id: input.publishRun, head_sha: run.head_sha}};
const release = {id: 14, tag_name: input.tag, target_commitish: input.candidateSha, draft: true, prerelease: false, immutable: false, name: 'Phantom 3.30.9', body: 'Verified release notes.\n'};
const names = [`ashlr-phantom-${input.version}.tgz`, `ashlr-phantom-${input.version}.tgz.sig`, `Phantom_${input.version}_aarch64.app.tar.gz`, `Phantom_${input.version}_aarch64.app.tar.gz.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
const assets = names.map((name, i) => ({id: 100 + i, name, label: null, content_type: 'application/octet-stream', size: 100, state: 'uploaded', digest: `sha256:${'e'.repeat(64)}`,
  browser_download_url: `https://github.com/ashlrai/phantom/releases/download/${input.tag}/${name}`}));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function evidenceRead(listing = {total_count: 1, artifacts: [artifact]}) {
  return (endpoint: string) => {
    if (endpoint.endsWith('/attempts/3')) return run;
    if (endpoint.endsWith('/jobs?per_page=100')) return jobs;
    if (endpoint.endsWith('/artifacts?per_page=100')) return listing;
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}

// The key is created in process solely for these tests. No production private key is read.
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const keyId = Buffer.from('0123456789abcdef', 'hex');
const keyPacket = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({type: 'spki', format: 'der'}).subarray(-32)]);
const publicText = Buffer.from(`untrusted comment: disposable M523 test key\n${keyPacket.toString('base64')}\n`).toString('base64');
function signature(data: Uint8Array) {
  const signed = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'M523 test fixture';
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey);
  return Buffer.from(`untrusted comment: test only\n${Buffer.concat([Buffer.from('ED'), keyId, signed]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
}
function signedFixture() {
  const trust = {...getDesktopUpdateTrustForProfile('canonical-v2'), publicKey: publicText};
  const app = Buffer.from('disposable signed app archive fixture');
  const url = (name: string) => `https://github.com/ashlrai/phantom/releases/download/${input.tag}/${name}`;
  const row = (name: string, data: Buffer) => ({filename: name, bytes: data.length, sha256: hash(data), signature: signature(data), url: url(name)});
  const m: CanonicalUpdateManifest = {schemaVersion: 2, kind: 'phantom-paired-release', channel: 'stable', platform: 'darwin-aarch64', version: input.version,
    repository: {nameWithOwner: 'ashlrai/phantom', repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw', ownerId: 258113726, ownerLogin: 'ashlrai', defaultBranch: 'master'},
    source: {revision: input.candidateSha, tree: 'd'.repeat(40)}, authoritySurfaceDigest: '1'.repeat(64),
    app: {...row(names[2]!, app), bundleIdentifier: 'ai.ashlr.desktop', executable: 'ashlr-desktop', inventorySha256: '2'.repeat(64), signer: DESKTOP_RELEASE_APPLE_SIGNER},
    cli: {...row(names[0]!, bytes), packageName: '@ashlr/phantom', binName: 'ashlr'},
    qualification: {manifestSha256: '3'.repeat(64), archiveSha256: '4'.repeat(64), packageSha256: hash(bytes), qualificationSha256: '5'.repeat(64),
      producer: {runId: 20, runAttempt: 2, eventSha: 'e'.repeat(40)}, attestor: {revision: run.head_sha, runId: 21, runAttempt: 1}, audit: {revision: input.candidateSha, runId: 22, runAttempt: 1}}};
  const record = {sha256: hash(bytes), attestor: clone(m.qualification.attestor), producer: {runId: 20, runAttempt: 2}};
  const files = new Map<string, Buffer>();
  function seal() {
    files.set(m.cli.filename, bytes); files.set(`${m.cli.filename}.sig`, Buffer.from(m.cli.signature));
    files.set(m.app.filename, app); files.set(`${m.app.filename}.sig`, Buffer.from(m.app.signature));
    const manifestText = canonicalJson(m), sig = signature(Buffer.from(manifestText));
    files.set('manifest.json', Buffer.from(manifestText)); files.set('manifest.json.sig', Buffer.from(sig));
    files.set('latest.json', Buffer.from(canonicalJson({version: m.version, platforms: {'darwin-aarch64': {url: m.app.url, signature: m.app.signature}}, phantom: {manifestText, signature: sig}})));
  }
  seal();
  function observation() {
    const rows = [...files].map(([name, data], i) => ({id: 100 + i, name, label: null, content_type: 'application/octet-stream', size: data.length, state: 'uploaded', digest: `sha256:${hash(data)}`, browser_download_url: url(name)}));
    return {release, assets: rows, snapshot: releaseSnapshot(input, release, rows)};
  }
  const primitives = {verifyCompatibleUpdateManifest, verifyMinisign, canonicalJson, trust};
  const verify = () => verifySignedAssets(input, record, observation(), primitives, async (asset: {name: string}) => files.get(asset.name)!);
  return {m, record, files, seal, observation, primitives, verify};
}

describe('M523 — exact Phantom dispatch and canonical npm evidence', () => {
  it('separates candidate revision from protected publishing source and binds exact attempts', () => {
    expect(input.candidateSha).not.toBe(run.head_sha);
    expect(input).toMatchObject({version: '3.30.9', publishRun: 12, publishAttempt: 3, workflowRun: 11, workflowAttempt: 2});
    expect(bindCanonicalRun(input, run, jobs)).toBe(run);
  });
  it.each([
    {GITHUB_REPOSITORY: 'attacker/phantom'}, {GITHUB_REPOSITORY: 'ashlrai/ashlr-hub'}, {GITHUB_REPOSITORY_ID: '1'}, {GITHUB_REPOSITORY_OWNER_ID: '1'},
    {GITHUB_REF: 'refs/heads/worker'}, {GITHUB_EVENT_NAME: 'pull_request'}, {CONFIRM_STABLE_FINALIZATION: 'false'},
    {VERSION: '3.30.9;echo injected'}, {VERSION: '3.30.9-rc.1'}, {VERSION: '03.30.9'}, {VERSION: '9007199254740992.0.0'},
    {CANDIDATE_SHA: 'b'.repeat(39)}, {GITHUB_SHA: 'A'.repeat(40)}, {CANDIDATE_INTEGRITY: 'sha512-unknown'},
    {PUBLISH_RUN_ID: '0'}, {PUBLISH_RUN_ATTEMPT: '1\n2'}, {GITHUB_RUN_ID: '9007199254740992'}, {GITHUB_RUN_ATTEMPT: ''},
  ])('refuses malformed or untrusted dispatch %j', patch => {
    expect(() => finalizationInput({...env, ...patch})).toThrow();
  });
  it.each([
    {id: 99}, {run_attempt: 4}, {head_sha: 'unknown'}, {path: '.github/workflows/release.yml'}, {event: 'push'}, {head_branch: 'worker'},
    {status: 'in_progress'}, {conclusion: 'failure'}, {repository: {...repo, id: 1}}, {repository: {...repo, owner: {...repo.owner, id: 1}}},
  ])('refuses wrong or unsuccessful canonical run %j', patch => {
    expect(() => bindCanonicalRun(input, {...run, ...patch}, jobs)).toThrow();
  });
  it('requires every canonical job exactly once and all pages of job evidence', () => {
    for (const name of ['admit', 'publish', 'consumer', 'promote']) {
      const changed = clone(jobs); changed.jobs.find(j => j.name === name)!.conclusion = 'skipped';
      expect(() => bindCanonicalRun(input, run, changed)).toThrow();
    }
    for (const changed of [
      {...jobs, total_count: 5}, {...jobs, jobs: jobs.jobs.slice(0, 3)},
      {...jobs, jobs: [jobs.jobs[0], jobs.jobs[0], ...jobs.jobs.slice(2)]},
      {...jobs, jobs: jobs.jobs.map(j => ({...j, run_id: 99}))}, {...jobs, jobs: jobs.jobs.map(j => ({...j, head_sha: input.candidateSha}))},
    ]) expect(() => bindCanonicalRun(input, run, changed)).toThrow();
  });
  it('selects only the immutable admission for the selected successful attempt', () => {
    expect(canonicalEvidence(input, evidenceRead())).toEqual({run, artifact});
    const otherAttempt = {...artifact, id: 14, name: 'phantom-npm-admitted-12-2'};
    expect(canonicalEvidence(input, evidenceRead({total_count: 2, artifacts: [otherAttempt, artifact]})).artifact.id).toBe(13);
  });
  it.each([
    {id: 0}, {name: 'phantom-npm-admitted-12-2'}, {expired: true}, {digest: 'unknown'}, {size_in_bytes: 0}, {size_in_bytes: 128 * 1024 * 1024 + 1},
    {workflow_run: {id: 99, head_sha: run.head_sha}}, {workflow_run: {id: 12, head_sha: input.candidateSha}},
  ])('refuses mismatched admission metadata %j', patch => {
    expect(() => canonicalEvidence(input, evidenceRead({total_count: 1, artifacts: [{...artifact, ...patch}]}))).toThrow();
  });
  it('refuses missing, ambiguous or incompletely paginated admission artifacts', () => {
    for (const listing of [{total_count: 0, artifacts: []}, {total_count: 2, artifacts: [artifact, artifact]}, {total_count: 2, artifacts: [artifact]}]) {
      expect(() => canonicalEvidence(input, evidenceRead(listing))).toThrow();
    }
  });
});

describe('M523 — exact existing draft and immutable tag', () => {
  it('accepts lightweight and bounded annotated tags resolving to the candidate', () => {
    const commit = {sha: input.candidateSha, tree: {sha: 'f'.repeat(40)}};
    for (const annotated of [false, true]) {
      const api = (endpoint: string) => {
        if (endpoint.includes('/git/ref/')) return {ref: `refs/tags/${input.tag}`, object: {type: annotated ? 'tag' : 'commit', sha: annotated ? 'e'.repeat(40) : input.candidateSha}};
        if (endpoint.includes('/git/tags/')) return {sha: 'e'.repeat(40), object: {type: 'commit', sha: input.candidateSha}};
        return commit;
      };
      expect(tagCommit(input, api)).toEqual(commit);
    }
  });
  it('refuses moved tags, noncommit targets, cycles and malformed commit trees', () => {
    for (const target of [{type: 'commit', sha: 'f'.repeat(40)}, {type: 'tree', sha: input.candidateSha}, {type: 'tag', sha: 'e'.repeat(40)}]) {
      expect(() => tagCommit(input, (endpoint: string) => endpoint.includes('/git/ref/') ? {ref: `refs/tags/${input.tag}`, object: target} : {sha: target.sha, object: target})).toThrow();
    }
    expect(() => tagCommit(input, (endpoint: string) => endpoint.includes('/git/ref/') ? {ref: `refs/tags/${input.tag}`, object: {type: 'commit', sha: input.candidateSha}} : {sha: input.candidateSha, tree: {sha: 'unknown'}})).toThrow();
  });
  it('binds notes, asset IDs and exact metadata independently of listing order', () => {
    const snapshot = releaseSnapshot(input, release, assets);
    expect(releaseSnapshot(input, release, [...assets].reverse())).toEqual(snapshot);
    expect(releaseSnapshot(input, {...release, body: 'Changed'}, assets).bodySha256).not.toBe(snapshot.bodySha256);
    expect(releaseSnapshot(input, release, assets.map((a, i) => i === 0 ? {...a, id: 999} : a)).assetsSha256).not.toBe(snapshot.assetsSha256);
  });
  it.each([{draft: false}, {prerelease: true}, {immutable: true}, {tag_name: 'v3.30.8'}, {target_commitish: 'master'}, {body: ''}, {body: ' \n'}, {name: ''}, {id: 0}])('refuses ineligible release %j', patch => {
    expect(() => releaseSnapshot(input, {...release, ...patch}, assets)).toThrow();
  });
  it('refuses zero, partial, duplicate and unexpected asset sets including empty public 3.30.8', () => {
    for (const changed of [[], assets.slice(1), [...assets, assets[0]], [...assets.slice(1), assets[1]], assets.map((a, i) => i === 0 ? {...a, name: 'unexpected'} : a)]) {
      expect(() => releaseSnapshot(input, release, changed)).toThrow();
    }
    const old = finalizationInput({...env, VERSION: '3.30.8'});
    expect(() => releaseSnapshot(old, {...release, tag_name: 'v3.30.8', draft: false}, [])).toThrow('already published');
  });
  it.each([{id: 0}, {id: assets[1]!.id}, {size: 0}, {size: 512 * 1024 * 1024 + 1}, {state: 'new'}, {digest: 'unknown'}, {browser_download_url: 'https://example.com/asset'}])('refuses invalid asset %j', patch => {
    expect(() => releaseSnapshot(input, release, assets.map((a, i) => i === 0 ? {...a, ...patch} : a))).toThrow();
  });
  it('locates a draft through paginated release listing instead of the public by-tag endpoint', () => {
    const calls: string[] = [];
    const api = (endpoint: string) => {
      calls.push(endpoint);
      if (endpoint.endsWith('page=1')) return Array.from({length: 100}, (_, i) => ({id: i + 1, tag_name: `v0.0.${i}`}));
      if (endpoint.endsWith('page=2')) return [release];
      if (endpoint.endsWith('/14')) return release;
      if (endpoint.endsWith('/assets?per_page=100')) return assets;
      throw new Error(`unexpected ${endpoint}`);
    };
    expect(draftObservation(input, api).release.id).toBe(14);
    expect(calls).toContain('repos/ashlrai/phantom/releases?per_page=100&page=2');
    expect(calls.some(path => path.includes('/releases/tags/'))).toBe(false);
  });
  it('refuses no release or duplicate releases rather than creating a new record', () => {
    for (const rows of [[], [release, {...release, id: 99}], [release, {...release, id: 99, draft: false}]]) {
      expect(() => draftObservation(input, () => rows)).toThrow('exactly one');
    }
  });
});

describe('M523 — real signed complete asset bytes', () => {
  it('verifies canonical-v2 manifest, app and CLI signatures and exact discovery envelope', async () => {
    const f = signedFixture(); expect(await f.verify()).toEqual(f.m);
    expect(f.observation().assets).toHaveLength(7);
  });
  it('refuses a corrupted downloaded asset even when release metadata was unchanged', async () => {
    const f = signedFixture(), observation = f.observation();
    await expect(verifySignedAssets(input, f.record, observation, f.primitives, async (asset: {name: string}) => asset.name === 'manifest.json' ? Buffer.from('corrupt') : f.files.get(asset.name)!)).rejects.toThrow('asset bytes differ');
  });
  it('refuses a substituted manifest signed with an uncommissioned key', async () => {
    const f = signedFixture();
    await expect(verifySignedAssets(input, f.record, f.observation(), {...f.primitives, trust: getDesktopUpdateTrustForProfile('canonical-v2')}, async (asset: {name: string}) => f.files.get(asset.name)!)).rejects.toThrow();
  });
  it.each(['app', 'cli'] as const)('refuses a wrong cryptographic %s archive signature after digest metadata is updated', async name => {
    const f = signedFixture(); f.m[name].signature = signature(Buffer.from('different bytes')); f.seal();
    await expect(f.verify()).rejects.toThrow('payload signature');
  });
  it('refuses sidecars that disagree with the signed manifest even if their own digest matches', async () => {
    const f = signedFixture(); f.files.set(`${f.m.app.filename}.sig`, Buffer.from(signature(Buffer.from('other'))));
    await expect(f.verify()).rejects.toThrow();
  });
  it('refuses a discovery feed that redirects the updater or changes authenticated bytes', async () => {
    const f = signedFixture(); const feed = JSON.parse(f.files.get('latest.json')!.toString()); feed.platforms['darwin-aarch64'].url = 'https://example.com/substituted';
    f.files.set('latest.json', Buffer.from(canonicalJson(feed))); await expect(f.verify()).rejects.toThrow('feed differs');
  });
  it.each([
    ['candidate', (m: CanonicalUpdateManifest) => {m.source.revision = 'f'.repeat(40); m.qualification.audit.revision = m.source.revision;}],
    ['version', (m: CanonicalUpdateManifest) => {m.version = '3.30.10';}],
    ['Apple signer', (m: CanonicalUpdateManifest) => {m.app.signer = 'A'.repeat(40);}],
    ['attestor', (m: CanonicalUpdateManifest) => {m.qualification.attestor.runId++;}],
    ['producer attempt', (m: CanonicalUpdateManifest) => {m.qualification.producer.runAttempt++;}],
  ] as const)('refuses a validly signed mismatched %s', async (_name, change) => {
    const f = signedFixture(); change(f.m); f.seal(); await expect(f.verify()).rejects.toThrow();
  });
  it('requires the original npm package hash and immutable qualification identity', async () => {
    const f = signedFixture(); f.record.sha256 = '0'.repeat(64); await expect(f.verify()).rejects.toThrow();
  });
  it('refuses oversized metadata before downloading it', async () => {
    const f = signedFixture(), observation = f.observation(); observation.assets.find(a => a.name === 'latest.json')!.size = 128 * 1024 + 1;
    let latestContact = false;
    await expect(verifySignedAssets(input, f.record, observation, f.primitives, async (asset: {name: string}) => {if (asset.name === 'latest.json') latestContact = true; return f.files.get(asset.name)!;})).rejects.toThrow();
    expect(latestContact).toBe(false);
  });
});

describe('M523 — workflow authority and protected effect', () => {
  it('exposes only version-parameterized manual Phantom dispatch with explicit confirmation', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['version', 'publish_run_id', 'publish_run_attempt', 'candidate_sha', 'candidate_integrity', 'confirm_stable_finalization']);
    expect(workflow.on.workflow_dispatch.inputs.confirm_stable_finalization).toMatchObject({type: 'boolean', required: true, default: false});
    expect(workflowText).not.toMatch(/@ashlr\/hub|3\.3\.2/);
    expect(workflow.concurrency).toEqual({group: 'phantom-github-stable-finalization', 'cancel-in-progress': false});
  });
  it('retains least privilege, environment separation and SHA-pinned actions', () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.verify.permissions).toEqual({actions: 'read', contents: 'read'});
    expect(workflow.jobs.verify.environment).toBeUndefined();
    expect(workflow.jobs.finalize.permissions).toEqual({actions: 'read', contents: 'write'});
    expect(workflow.jobs.finalize.environment).toBe('github-stable-release-finalization');
    expect(workflow.jobs.finalize.needs).toBe('verify');
    for (const job of Object.values(workflow.jobs) as {steps: {uses?: string}[]}[]) {
      for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    const privileged = workflow.jobs.finalize.steps as {uses?: string; run?: string}[];
    expect(privileged.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(privileged.map(step => step.run ?? '').join('\n')).not.toMatch(/\bnpm\s|\bnode\s|--import\s+tsx/);
    expect(workflowText).not.toMatch(/id-token\s*:|NODE_AUTH_TOKEN|NPM_TOKEN|\$\{\{\s*secrets\.|pull_request_target|workflow_run\s*:/);
  });
  it('binds cross-run admission and current-run preflight with digest enforcement', () => {
    const download = workflow.jobs.verify.steps.find((step: {uses?: string}) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.with).toMatchObject({'artifact-ids': '${{ steps.prepare.outputs.artifact_id }}', 'run-id': '${{ inputs.publish_run_id }}', 'digest-mismatch': 'error'});
    const receiptDownload = workflow.jobs.finalize.steps[0];
    expect(receiptDownload.with.name).toBe('github-stable-finalization-preflight-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(receiptDownload.with['digest-mismatch']).toBe('error');
    for (const fragment of ['"$EXPECTED_RECEIPT_SHA256"', '.input.workflowSha == $sha', '.input.workflowRun == ($run|tonumber)', '.input.workflowAttempt == ($attempt|tonumber)', '.input.publishAttempt == ($publishAttempt|tonumber)', '.evidence.artifactDigest', '.expired == false']) expect(effect).toContain(fragment);
    expect(verifierText).toContain('assert.equal(evidence.artifact.id, integer(env.ADMISSION_ARTIFACT_ID))');
  });
  it('contains one publication PATCH and no alternative mutation surfaces', () => {
    expect(effect.match(/\bgh api --method PATCH\b/g)).toHaveLength(1);
    expect(effect).toContain('gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/$release_id"');
    expect(effect).toContain("jq -cn '{draft:false, make_latest:\"true\"}'");
    expect(`${workflowText}\n${verifierText}`).not.toMatch(/\bnpm\s+(?:publish|dist-tag|unpublish|deprecate)\b|\bgh\s+release\s+(?:create|edit|upload|delete)\b|\bgh api --method (?:POST|PUT|DELETE)\b/);
    expect(effect.indexOf('verify_release true')).toBeLessThan(effect.indexOf('gh api --method PATCH'));
    expect(effect.indexOf('verify_release false')).toBeGreaterThan(effect.indexOf('gh api --method PATCH'));
    expect(effect).toContain('releases/latest/download/latest.json');
    expect(effect).toContain('installed-app update and launch remain unverified');
  });
  it('preserves protected environment, exact live source and fresh before/after snapshots', () => {
    for (const fragment of [
      '.can_admins_bypass == false', '.deployment_branch_policy.protected_branches == true', '.deployment_branch_policy.custom_branch_policies == false',
      '$rules[0].prevent_self_review == false', '$rules[0].reviewers[0].type == "User"', '$rules[0].reviewers[0].reviewer.login == "masonwyatt23"',
      '.protected == true and .commit.sha == $sha', '.path == ".github/workflows/publish-canonical-npm.yml"',
      '.bodySha256', '.assetsSha256', 'verify_tag', 'verify_release true', 'verify_release false', '.draft == true', 'length == 7',
    ]) expect(effect).toContain(fragment);
    const syntax = spawnSync('bash', ['-n'], {input: effect, encoding: 'utf8'});
    expect(syntax.stderr).toBe(''); expect(syntax.status).toBe(0);
  });
  it('keeps the sanctioned desktop publisher live-feed refusal intact', () => {
    expect(load('scripts/publish-desktop-release.mjs')).toContain("assert.equal(object(release)?.draft, true, 'release is already published — refusing to touch a live feed')");
    for (const text of [load('docs/contracts/CONTRACT-M523.md'), load('docs/RELEASING.md')]) {
      expect(text).toContain('v3.30.8'); expect(text).toContain('350636007'); expect(text).toContain('SECURITY REVIEW');
      expect(text).toContain('RQ-RELEASE-DESKTOP-UNQUARANTINE-1');
    }
  });
});

describe('M523 — retained historical evidence', () => {
  const changelog = load('CHANGELOG.md');
  const historical = load('docs/RELEASING-HISTORICAL.md');
  it('retains completed 3.3.2 distribution evidence without runtime authority', () => {
    const section = changelog.split('## [3.3.2]')[1]!.split('\n## [')[0]!;
    expect(changelog).toContain('## [3.3.2] — 2026-09-05 UTC — Safe successor after the failed immutable 3.3.1 release attempt');
    for (const fragment of ['`2971c9f767c934e12fd056bf8c6dca5164ffe7d2`', '`33932333902`', '`33933861238`', 'npm `latest` and `candidate` both resolve to 3.3.2', 'does not install or activate a runtime', 'or authorize spend']) expect(section).toContain(fragment);
    expect(section).not.toContain('`latest` remains 3.0.1');
  });
  it('preserves immutable completed finalization receipts and no automatic historical rollback', () => {
    for (const fragment of [
      '### Completed GitHub stable-release finalization after npm promotion', '`1a7d44efe7a8383513fea4dbfa6746fdeb9fa93d`',
      'Workflow run `33937472105`,\nattempt 1, then completed successfully', 'ID\n`21286317607`', 'Release ID `383083121` is now stable',
      'artifact is ID `9960674976`', '`sha256:63c910fe2ab554493e2378e44edd9b9657531f7ff03497b8ec96a23b90d57285`',
      '`089add5ae05d3f439c258fdfe263279857a0fa60f3b51600f322d807d0550a17`',
      'It grants no npm,\ninstallation, runtime, service, provider, credential, or spend authority', 'controlled\nhistorical recovery guidance',
      'Do not rerun the\ncompleted finalization', 'it is never automatic and\ndoes not roll back npm',
    ]) expect(historical).toContain(fragment);
  });
});

/** Execute the actual privileged shell with file-backed fake transports. The
 * stubs reject unknown endpoints and writes; no GitHub or registry is contacted. */
function runEffect(mode = 'happy') {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-finalize-effect-'));
  try {
    const f = signedFixture(), observation = f.observation();
    const verifiedAt = mode === 'expired' ? new Date(Date.now() - 2 * 3600_000) : new Date();
    const receipt = {schemaVersion: 2, admission: 'phantom-stable-finalization', input, release: observation.snapshot,
      evidence: {artifactId: artifact.id, artifactDigest: artifact.digest, publisherSha: run.head_sha, provenance: {runId: '10', runAttempt: '1'}},
      verifiedAt: verifiedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'), npmMutationAuthority: false, installAuthority: false, activationAuthority: false, githubReleaseMutationExecuted: false};
    const preflight = join(dir, 'finalization-preflight'), bin = join(dir, 'bin'), runtime = join(dir, 'runtime');
    mkdirSync(preflight); mkdirSync(bin); mkdirSync(runtime);
    const receiptBytes = JSON.stringify(receipt); writeFileSync(join(preflight, 'github-stable-finalization-preflight.json'), receiptBytes);
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({release, assets: observation.assets, run, jobs, artifact, latest: f.files.get('latest.json')!.toString('base64'), input}));
    const stub = `${nodeFixtureHeader()}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, mode = process.env.FIXTURE_MODE;
const f = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const statePath = path.join(root, 'writes.json');
const writes = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : [];
const tool = path.basename(process.argv[1]), args = process.argv.slice(2);
const out = value => process.stdout.write(JSON.stringify(value));
const unknown = () => {process.stderr.write('Unexpected fixture transport call'); process.exit(97);};
if (tool === 'stat') {process.stdout.write(String(fs.lstatSync(args[args.length-1]).nlink)); process.exit(0);}
if (tool === 'curl') {
  const url = args.find(a => a.startsWith('https://'));
  if (url === 'https://registry.npmjs.org/@ashlr%2Fphantom') out({name:'@ashlr/phantom', 'dist-tags': {latest: mode === 'latest-moved' ? '3.30.10' : f.input.version}, versions: {[f.input.version]: {dist: {integrity:f.input.integrity}}}});
  else if (url === 'https://github.com/ashlrai/phantom/releases/latest/download/latest.json') {if (mode === 'post-feed-unavailable') process.exit(22); process.stdout.write(mode === 'post-feed-changed' ? Buffer.from('different feed') : Buffer.from(f.latest,'base64'));}
  else unknown();
  process.exit(0);
}
const endpoint = args.find(a => a.startsWith('repos/ashlrai/phantom/'));
if (!endpoint) unknown();
const suffix = endpoint.slice('repos/ashlrai/phantom/'.length);
if (args.includes('--method')) {
  const method = args[args.indexOf('--method')+1];
  if (method !== 'PATCH' || suffix !== 'releases/14' || writes.length !== 0) unknown();
  const fields = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1], 'utf8'));
  fs.writeFileSync(path.join(root, 'intent-at-patch.json'), JSON.stringify(fs.existsSync(path.join(process.env.RUNNER_TEMP, 'finalization-evidence', 'attempt.json'))));
  writes.push({method, endpoint, fields}); fs.writeFileSync(statePath, JSON.stringify(writes));
  if (mode === 'ambiguous-patch') {process.stderr.write('Simulated lost response');process.exit(1);}
  out({...f.release,draft:false});process.exit(0);
}
if (suffix === 'environments/github-stable-release-finalization') out({name:'github-stable-release-finalization',can_admins_bypass:mode === 'environment-bypass',deployment_branch_policy:{protected_branches:true,custom_branch_policies:false},protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:'masonwyatt23'}}]}]});
else if (suffix === 'branches/master') out({protected:true, commit:{sha:f.input.workflowSha}});
else if (suffix.startsWith('compare/')) out({status:'ahead'});
else if (suffix === 'actions/runs/12/attempts/3') out(f.run);
else if (suffix === 'actions/runs/12/attempts/3/jobs?per_page=100') out(mode === 'failed-job' ? {...f.jobs,jobs:f.jobs.jobs.map(j => j.name === 'promote' ? {...j,conclusion:'failure'} : j)} : f.jobs);
else if (suffix === 'actions/artifacts/13') out(f.artifact);
else if (suffix === 'git/ref/tags/v3.30.9') out({ref:'refs/tags/v3.30.9',object:{type:'commit',sha:mode === 'tag-moved' || (mode === 'post-tag-moved' && writes.length) ? 'f'.repeat(40) : f.input.candidateSha}});
else if (suffix === 'releases?per_page=100') out(mode === 'duplicate-release' ? [f.release,{...f.release,id:99}] : [{...f.release,draft:mode !== 'already-public'}]);
else if (suffix === 'releases/14') out({...f.release,draft:writes.length === 0,body:mode === 'notes-race' || (mode === 'post-notes-race' && writes.length) ? 'Changed after verification' : f.release.body, target_commitish:mode === 'target-race' ? 'f'.repeat(40) : f.release.target_commitish, prerelease:mode === 'prerelease-race', name:mode === 'name-race' ? 'Changed name' : f.release.name});
else if (suffix === 'releases/14/assets?per_page=100') out(mode === 'asset-race' ? f.assets.map((a,i) => i === 0 ? {...a,digest:'sha256:'+'0'.repeat(64)} : a) : f.assets);
else if (suffix === 'releases/latest') out({...f.release,id:mode === 'post-latest-race' ? 999 : f.release.id,draft:false});
else unknown();
`;
    for (const tool of ['gh', 'curl', 'stat']) writeFileSync(join(bin, tool), stub, {mode: 0o755});
    const result = spawnSync('bash', ['-c', effect], {cwd: dir, encoding: 'utf8', timeout: 20_000,
      env: {...process.env, ...env, HOME: dir, GH_TOKEN: 'test-only', PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: dir, FIXTURE_MODE: mode,
        RUNNER_TEMP: runtime, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        GITHUB_EVENT_NAME: mode === 'unexpected-event' ? 'pull_request' : env.GITHUB_EVENT_NAME,
        GITHUB_REF: mode === 'wrong-ref' ? 'refs/heads/untrusted' : env.GITHUB_REF,
        GITHUB_REPOSITORY: mode === 'wrong-repository' ? 'other/phantom' : env.GITHUB_REPOSITORY,
        CONFIRM_STABLE_FINALIZATION: mode === 'unconfirmed' ? 'false' : env.CONFIRM_STABLE_FINALIZATION,
        EXPECTED_RECEIPT_SHA256: mode === 'wrong-receipt-hash' ? '0'.repeat(64) : hash(receiptBytes)}});
    const writes = existsSync(join(dir, 'writes.json')) ? JSON.parse(readFileSync(join(dir, 'writes.json'), 'utf8')) : [];
    const postReceipt = existsSync(join(runtime, 'github-stable-finalization.json')) ? JSON.parse(readFileSync(join(runtime, 'github-stable-finalization.json'), 'utf8')) : null;
    const evidence = join(runtime, 'finalization-evidence');
    const attempt = existsSync(join(evidence, 'attempt.json')) ? JSON.parse(readFileSync(join(evidence, 'attempt.json'), 'utf8')) : null;
    const outcome = existsSync(join(evidence, 'outcome.json')) ? JSON.parse(readFileSync(join(evidence, 'outcome.json'), 'utf8')) : null;
    const intentAtPatch = existsSync(join(dir, 'intent-at-patch.json')) ? JSON.parse(readFileSync(join(dir, 'intent-at-patch.json'), 'utf8')) : false;
    const responseBytes = existsSync(join(runtime, 'patch-result.json')) ? readFileSync(join(runtime, 'patch-result.json')) : Buffer.alloc(0);
    const finalFeed = existsSync(join(runtime, 'latest.json')) ? readFileSync(join(runtime, 'latest.json')) : Buffer.alloc(0);
    return {result, writes, postReceipt, attempt, outcome, intentAtPatch, responseBytes,
      actualFeedDigest: `sha256:${hash(finalFeed)}`, expectedFeedDigest: observation.assets.find(asset => asset.name === 'latest.json')!.digest};
  } finally {rmSync(dir, {recursive: true, force: true});}
}

describe('M523 — executable protected shell with fake transports', () => {
  it('validates generated ISO timestamp, JS/jq snapshot parity, one exact PATCH and post-effect feed', () => {
    const {result, writes, postReceipt} = runEffect();
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(writes).toEqual([{method: 'PATCH', endpoint: 'repos/ashlrai/phantom/releases/14', fields: {draft: false, make_latest: 'true'}}]);
    expect(postReceipt).toMatchObject({githubReleaseMutationExecuted: true, npmMutationAuthority: false, installAuthority: false, mutation: {count: 1}});
  }, 30_000);
  it.each(['expired', 'environment-bypass', 'failed-job', 'latest-moved', 'tag-moved', 'duplicate-release', 'already-public', 'notes-race', 'asset-race', 'target-race', 'prerelease-race', 'name-race'])('holds %s before any write', mode => {
    const {result, writes, postReceipt} = runEffect(mode);
    expect(result.status).not.toBe(0); expect(writes).toEqual([]); expect(postReceipt).toBeNull();
  }, 30_000);
  it('never replays a PATCH after an ambiguous write response', () => {
    const {result, writes, postReceipt} = runEffect('ambiguous-patch');
    expect(result.status).not.toBe(0); expect(writes).toHaveLength(1); expect(postReceipt).toBeNull();
  }, 30_000);
});


describe('M523 — retained bounded publication-attempt evidence', () => {
  it('uploads only exact evidence files even on failure, while requiring the success receipt on success', () => {
    const steps = workflow.jobs.finalize.steps as {name?: string; if?: string; run?: string; uses?: string; with?: {path?: string}}[];
    const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.if).toBe('always()');
    expect(upload.with?.path?.trim().split('\n')).toEqual([
      '${{ runner.temp }}/finalization-evidence/attempt.json',
      '${{ runner.temp }}/finalization-evidence/outcome.json',
      '${{ runner.temp }}/github-stable-finalization.json',
    ]);
    const successCheck = steps.find(step => step.name === 'Require successful finalization receipt')!;
    expect(successCheck.if).toBe('success()');
    expect(successCheck.run).toContain('test -s "$RUNNER_TEMP/github-stable-finalization.json"');
    expect(steps.indexOf(successCheck)).toBeLessThan(steps.indexOf(upload));
  });
  it.each(['happy', 'ambiguous-patch', 'post-tag-moved', 'post-notes-race', 'post-latest-race', 'post-feed-unavailable', 'post-feed-changed'])('retains %s evidence without replay or false success', mode => {
    const {result, writes, postReceipt, attempt, outcome, intentAtPatch, responseBytes, actualFeedDigest, expectedFeedDigest} = runEffect(mode);
    if (mode === 'post-feed-changed') expect(actualFeedDigest).not.toBe(expectedFeedDigest);
    expect(intentAtPatch).toBe(true); expect(writes).toHaveLength(1);
    expect(attempt).toMatchObject({schemaVersion: 1, effect: 'github-release-draft-finalization-attempt',
      input, release: {id: 14}, githubReleaseMutationExecuted: null,
      mutation: {method: 'PATCH', fields: {draft: false, make_latest: 'true'}}});
    expect(attempt.preflightSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome).toMatchObject({schemaVersion: 1, effect: 'github-release-draft-finalization-outcome', exitCode: result.status,
      patchResponse: {bytes: responseBytes.length, sha256: hash(responseBytes)}});
    expect(JSON.stringify(outcome).length).toBeLessThan(4096);
    expect(JSON.stringify(attempt).length).toBeLessThan(16384);
    expect(JSON.stringify({attempt, outcome})).not.toContain('Verified release notes.');
    if (mode === 'happy') {
      expect(result.status).toBe(0); expect(postReceipt).not.toBeNull();
      expect(outcome).toMatchObject({phase: 'completed', state: 'postverified', githubReleaseMutationExecuted: true});
    } else {
      expect(result.status).not.toBe(0); expect(postReceipt).toBeNull();
      expect(outcome).toMatchObject({phase: mode === 'ambiguous-patch' ? 'patch' : 'postcheck',
        state: mode === 'ambiguous-patch' ? 'unknown' : 'postcheck_failed', githubReleaseMutationExecuted: null});
    }
  }, 30_000);
  it.each(['expired', 'environment-bypass', 'failed-job', 'latest-moved', 'tag-moved', 'notes-race',
    'unexpected-event', 'wrong-ref', 'wrong-repository', 'unconfirmed', 'wrong-receipt-hash'])('does not manufacture an attempt after prewrite refusal %s', mode => {
    const {result, writes, attempt, outcome, intentAtPatch} = runEffect(mode);
    expect(result.status).not.toBe(0); expect(writes).toEqual([]);
    expect(attempt).toBeNull(); expect(outcome).toBeNull(); expect(intentAtPatch).toBe(false);
  }, 30_000);
});
