/* global process, console, fetch, AbortSignal */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { requireProducerEnvironment, requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';
import { captureBuild, packBuild } from './ci-pack-smoke.mjs';
import { captureArtifact, inspectTar, sourceBinding, verifyPushCi } from '../../scripts/hosted-build-artifact.mjs';
import { retainFreshDist, verifyLocalInput } from './release-local-input.mjs';

const execFileAsync = promisify(execFile);
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 }));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15000 }).trim();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;
const workflows = { push: ['ci.yml', 'push'], build: ['ci.yml', null], attest: ['ci.yml', null] };

/** Only successful exact-source master runs are reusable; no nearest green SHA. */
export function selectRun({ kind, repository, revision, read = api, excludeRunId = process.env.GITHUB_RUN_ID }) {
  assert.ok(Object.hasOwn(workflows, kind));
  assert.match(revision, /^[a-f0-9]{40}$/);
  requireRepositoryMetadata(repository, read(`repos/${repository}`));
  const [workflow, event] = workflows[kind];
  const response = read(`repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${revision}&branch=master&per_page=100`);
  assert.ok(Array.isArray(response.workflow_runs) && Number.isSafeInteger(response.total_count)
    && response.total_count <= 100 && response.total_count === response.workflow_runs.length, 'incomplete workflow run inventory');
  const matches = response.workflow_runs.filter(run => run.head_sha === revision && run.head_branch === 'master'
    && run.path === `.github/workflows/${workflow}` && String(run.id) !== String(excludeRunId)
    && (event ? run.event === event : ['workflow_dispatch', 'schedule'].includes(run.event)));
  assert.equal(new Set(matches.map(run => run.id)).size, matches.length, 'duplicate workflow run identity');
  for (const run of matches) {
    requireRepositoryReference(repository, run.repository);
    assert.ok(positive(run.id) && positive(run.run_attempt));
  }
  matches.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
  for (const selected of matches) {
    const run = read(`repos/${repository}/actions/runs/${selected.id}/attempts/${selected.run_attempt}`);
    requireRepositoryReference(repository, run.repository);
    for (const key of ['id', 'run_attempt', 'head_sha', 'head_branch', 'path', 'event']) assert.equal(run[key], selected[key], 'selected run changed');
    if (kind === 'push') {
      if (run.status !== 'completed' || run.conclusion !== 'success') return null;
      verifyPushCi({ repository, revision, runId: run.id, runAttempt: run.run_attempt, read });
      return { run: run.id, attempt: run.run_attempt, sha: revision };
    }
    const jobs = []; let total;
    for (let page = 1; page <= 10; page++) {
      const result = read(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
      assert.ok(Array.isArray(result.jobs) && Number.isSafeInteger(result.total_count) && result.total_count > 0 && result.total_count <= 1000, 'invalid release job inventory');
      total ??= result.total_count; assert.equal(result.total_count, total, 'release jobs changed'); jobs.push(...result.jobs);
      if (jobs.length === total) break;
      assert.ok(page < 10 && result.jobs.length === 100 && jobs.length < total, 'incomplete release jobs');
    }
    // Older immutable producers used a separate preparation job. A combined
    // producer retains the canonical smoke role and all original input steps.
    const legacyBuild = kind === 'build' ? jobs.filter(job => job.name === 'Prepare unsigned desktop release') : [];
    const matchingJobs = legacyBuild.length ? legacyBuild : jobs.filter(job => job.name === 'Desktop release smoke');
    assert.ok(matchingJobs.length <= 1, 'release job ambiguous');
    // The same workflow retains the nightly exhaustive suite. Its missing or
    // explicitly skipped release job is not a newer release candidate.
    if (!matchingJobs.length) continue;
    const job = matchingJobs[0]; assert.equal(job.run_id, run.id); assert.equal(job.head_sha, revision);
    if (job.status === 'completed' && job.conclusion === 'skipped') continue;
    // A newer attempted release that fails must never fall back to older green.
    if (run.status !== 'completed' || run.conclusion !== 'success') return null;
    assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
    assert.ok(job.labels?.includes('macos-15') && !job.labels.includes('self-hosted'), 'unexpected release runner');
    const name = kind === 'build' ? `phantom-release-input-${run.id}-${run.run_attempt}` : `ashlr-build-${run.id}-${run.run_attempt}`;
    const inventory = read(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    assert.ok(Array.isArray(inventory.artifacts) && inventory.total_count === inventory.artifacts.length && inventory.total_count <= 100, 'incomplete artifact inventory');
    const artifacts = inventory.artifacts.filter(row => row.name === name);
    assert.ok(artifacts.length <= 1, 'ambiguous release artifact');
    if (!artifacts.length) {
      // An eligibility no-op has no output. A successful upload with missing
      // bytes is an incomplete inventory, not permission to reuse older bytes.
      const uploads = job.steps?.filter(row => row.name === (kind === 'build' ? 'Upload immutable release input' : 'Upload qualified build handoff'));
      assert.equal(uploads?.length, 1, 'release upload step missing or ambiguous');
      assert.equal(uploads[0].status, 'completed');
      assert.equal(uploads[0].conclusion, 'skipped', 'successful release upload missing artifact');
      continue;
    }
    const artifact = artifacts[0];
    assert.ok(positive(artifact.id)); assert.equal(artifact.expired, false);
    assert.equal(artifact.workflow_run?.id, run.id); assert.equal(artifact.workflow_run?.head_sha, revision);
    assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
    const step = name => { const rows = job.steps?.filter(row => row.name === name); assert.equal(rows?.length, 1, 'release step missing or ambiguous'); assert.equal(rows[0].status, 'completed'); return rows[0].conclusion; };
    const required = kind === 'build'
      ? ['Reuse successful push CI and existing prepared artifact', 'Upload immutable release input']
      : ['Verify green master push CI', 'Smoke desktop release artifact', 'Upload qualified build handoff'];
    for (const name of required) assert.equal(step(name), 'success', 'release step did not pass');
    if (kind === 'build') assert.deepEqual([
      step('Build unsigned desktop and original package once'), step('Download existing immutable build'),
    ].sort(), ['skipped', 'success'], 'release input must be built or reused exactly once');
    return { run: run.id, attempt: run.run_attempt, sha: revision, artifact: artifact.id };
  }
  return null;
}

export function checkLaunch(output, version, revision) {
  assert.deepEqual(JSON.parse(output), { schemaVersion: 1, version, revision, state: 'pass' }, 'native executable identity differs');
}

export function checkFeed(feed, parseManifest, trust) {
  assert.ok(feed && typeof feed === 'object');
  assert.match(feed.version ?? '', /^\d+\.\d+\.\d+$/);
  const platform = feed.platforms?.['darwin-aarch64'];
  assert.ok(platform && typeof platform.signature === 'string' && platform.signature.length > 0);
  const manifest = parseManifest(feed.phantom?.manifestText, trust);
  assert.equal(manifest.version, feed.version);
  assert.equal(manifest.app.url, platform.url);
  assert.equal(manifest.app.signature, platform.signature);
  return manifest;
}

async function feedBody(response, asset) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 128 * 1024, 'oversized updater feed'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (asset) assert.ok(bytes.length === asset.size && `sha256:${digest(bytes)}` === asset.digest, 'stocked feed bytes differ from asset');
  return JSON.parse(bytes.toString('utf8'));
}

const stableTag = /^v\d+\.\d+\.\d+$/;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z');
function releaseIdentity(release, repository) {
  assert.ok(release && !Array.isArray(release) && positive(release.id), 'invalid release identity');
  assert.ok(typeof release.tag_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.tag_name), 'invalid release tag');
  assert.equal(release.url, `https://api.github.com/repos/${repository}/releases/${release.id}`, 'release repository differs');
  assert.equal(release.html_url, `https://github.com/${repository}/releases/tag/${release.tag_name}`, 'release tag differs');
  assert.equal(release.assets_url, `${release.url}/assets`, 'release asset endpoint differs');
  assert.ok(typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean', 'unknown release state');
  assert.ok(timestamp(release.created_at) && (release.draft ? release.published_at === null : timestamp(release.published_at)), 'invalid release timestamps');
  assert.ok(Array.isArray(release.assets) && release.assets.length < 100, 'incomplete release asset inventory');
  const assets = release.assets.map(asset => {
    assert.ok(asset && positive(asset.id) && typeof asset.name === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(asset.name), 'invalid release asset identity');
    assert.equal(asset.state, 'uploaded', 'incomplete release asset state');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'invalid release asset size');
    assert.equal(asset.url, `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, 'release asset repository differs');
    assert.equal(asset.browser_download_url, `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`, 'release asset download differs');
    return { id: asset.id, name: asset.name, state: asset.state, size: asset.size, digest: asset.digest,
      url: asset.url, browser_download_url: asset.browser_download_url };
  }).sort((a, b) => a.id - b.id);
  assert.equal(new Set(assets.map(asset => asset.id)).size, assets.length, 'duplicate release asset identity');
  assert.equal(new Set(assets.map(asset => asset.name)).size, assets.length, 'ambiguous release asset name');
  return { id: release.id, tag: release.tag_name, draft: release.draft, prerelease: release.prerelease,
    createdAt: release.created_at, publishedAt: release.published_at, assets };
}

function completeRelease(release, repository, read) {
  const identity = releaseIdentity(release, repository);
  const assets = read(`repos/${repository}/releases/${identity.id}/assets?per_page=100&page=1`);
  // Fail closed at the page boundary: embedded arrays alone cannot prove absence.
  assert.deepEqual(releaseIdentity({ ...release, assets }, repository), identity, 'release asset inventory changed or incomplete');
  return identity;
}

/** Select only from a complete bounded inventory. The highest semver with a
 * latest.json wins. Duplicate identities are refused. Creation time and list
 * order do not choose an older feed. */
export function stockedFeedTag(releases, repository = 'ashlrai/phantom') {
  assert.ok(Array.isArray(releases) && releases.length <= 1000, 'invalid release inventory');
  for (const row of releases) assert.ok(row && positive(row.id)
    && typeof row.draft === 'boolean' && typeof row.prerelease === 'boolean', 'unknown release state');
  assert.equal(new Set(releases.map(row => row.id)).size, releases.length, 'duplicate release identity');
  // GitHub legitimately uses untagged HTML URLs for drafts. Only published
  // stable candidates can supply this fallback, so never admit those drafts.
  const rows = releases.filter(row => !row.draft && !row.prerelease).map(row => releaseIdentity(row, repository));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'duplicate release identity');
  assert.equal(new Set(rows.map(row => row.tag)).size, rows.length, 'duplicate release tag');
  const stocked = rows.filter(row => !row.draft && !row.prerelease && stableTag.test(row.tag)
    && row.assets.some(asset => asset.name === 'latest.json'));
  const semver = tag => tag.slice(1).split('.').map(Number);
  const higher = (left, right) => {
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
    return false;
  };
  // Highest semver, not creation time and not inventory order. A later-created
  // older release must not become the updater feed.
  stocked.sort((a, b) => higher(semver(a.tag), semver(b.tag)) ? -1 : higher(semver(b.tag), semver(a.tag)) ? 1 : 0);
  if (!stocked.length) return null;
  return stocked[0].tag;
}

/** A previous feed can exercise the parser contract, never prove live updater
 * health. Only a repeated 404 bracketed by unchanged, independently complete
 * zero-asset latest metadata admits this narrow recovery path. */
export async function readUpdaterFeed({ endpoint, repository, read = api, fetchImpl = fetch }) {
  assert.equal(repository, 'ashlrai/phantom', 'unreviewed updater repository');
  assert.equal(endpoint, 'https://github.com/ashlrai/phantom/releases/latest/download/latest.json');
  const request = url => fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  const missing = async (response, expectedUrl) => {
    await response.body?.cancel();
    assert.equal(response.status, 404, 'updater feed unavailable: expected missing-asset 404');
    if (expectedUrl) assert.equal(response.url, expectedUrl, 'missing feed redirect differs from latest release');
  };
  const live = await request(endpoint);
  if (live.status === 200) return { feed: await feedBody(live), served: 'latest', liveStatus: 200 };
  await missing(live);
  requireRepositoryMetadata(repository, read(`repos/${repository}`));
  const latest = () => {
    const row = completeRelease(read(`repos/${repository}/releases/latest`), repository, read);
    assert.ok(!row.draft && !row.prerelease && stableTag.test(row.tag), 'latest is not a published stable release');
    assert.equal(row.assets.length, 0, 'latest is not assetless; unavailable feed must not fall back');
    return row;
  };
  const before = latest();
  const missingUrl = `https://github.com/${repository}/releases/download/${before.tag}/latest.json`;
  assert.equal(live.url, missingUrl, 'missing feed redirect differs from latest release');
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const rows = read(`repos/${repository}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(rows) && rows.length <= 100, 'invalid release inventory');
    releases.push(...rows);
    if (rows.length < 100) break;
    assert.ok(page < 10, 'incomplete release inventory');
  }
  const tag = stockedFeedTag(releases, repository);
  const observedLatest = releases.find(row => row.id === before.id);
  assert.deepEqual(observedLatest && releaseIdentity(observedLatest, repository), before, 'latest release inventory changed or incomplete');
  assert.ok(tag !== null, 'no stocked updater feed release');
  const selected = releases.find(row => row.tag_name === tag);
  const stocked = completeRelease(read(`repos/${repository}/releases/${selected.id}`), repository, read);
  assert.deepEqual(stocked, releaseIdentity(selected, repository), 'stocked release changed');
  assert.ok(stocked.id !== before.id && Date.parse(stocked.createdAt) < Date.parse(before.createdAt), 'stocked release is not prior to assetless latest');
  const response = await request(`https://github.com/${repository}/releases/download/${tag}/latest.json`);
  assert.equal(response.status, 200, 'stocked updater feed unavailable');
  const asset = stocked.assets.find(asset => asset.name === 'latest.json');
  assert.ok(asset.size <= 128 * 1024 && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''), 'invalid stocked feed asset');
  const feed = await feedBody(response, asset);
  assert.equal(feed?.version, tag.slice(1), 'stocked feed version differs');
  // Recheck after reading fallback bytes. A recovered pointer, metadata failure,
  // newly uploaded asset or changed release refuses instead of claiming recovery.
  await missing(await request(endpoint), missingUrl);
  assert.deepEqual(latest(), before, 'latest release changed during fallback');
  assert.deepEqual(completeRelease(read(`repos/${repository}/releases/${stocked.id}`), repository, read), stocked, 'stocked release changed during fallback');
  return { feed, served: tag, liveStatus: 404, latestRelease: { id: before.id, tag: before.tag } };
}

/** Restore only canonical producer dist bytes; artifact ZIPs discard POSIX modes. */
export function restorePreparedDist({ root, prepared, manifest }) {
  root = realpathSync(root); prepared = realpathSync(prepared);
  assert.ok(!existsSync(join(root, 'dist')), 'dist already exists');
  const path = join(prepared, 'dist.tar'); const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.size <= 640 * 1024 * 1024, 'unsafe prepared archive');
  const bytes = readFileSync(path); const after = lstatSync(path);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[field], before[field], 'prepared archive changed');
  assert.equal(bytes.length, manifest.archive.bytes);
  assert.equal(digest(bytes), manifest.archive.sha256, 'prepared archive digest differs');
  const entries = inspectTar(bytes, manifest.archive.entries);
  assert.ok(entries[0].path === 'dist' && entries[0].type === 'directory'
    && entries.every(entry => entry.path === 'dist' || entry.path.startsWith('dist/')), 'prepared archive escapes dist');
  const stage = mkdtempSync(join(root, '.release-smoke-stage-')); chmodSync(stage, 0o700);
  try {
    inspectTar(bytes, entries, (entry, data) => {
      const destination = join(stage, entry.path);
      if (entry.type === 'directory') mkdirSync(destination, { mode: 0o700 });
      else {
        const parent = lstatSync(dirname(destination));
        assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'unsafe prepared parent');
        writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
        chmodSync(destination, entry.mode);
      }
    });
    for (const entry of [...entries].reverse()) if (entry.type === 'directory') chmodSync(join(stage, entry.path), entry.mode);
    assert.ok(!existsSync(join(root, 'dist')), 'dist appeared during restoration');
    renameSync(join(stage, 'dist'), join(root, 'dist'));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

async function smoke() {
  const start = performance.now();
  const root = realpathSync(process.cwd()); const revision = git('rev-parse', 'HEAD');
  assert.equal(revision, process.env.GITHUB_SHA); assert.equal(process.platform, 'darwin');
  const { repository } = requireProducerEnvironment(process.env);
  const pushCi = { runId: Number(process.env.PUSH_CI_RUN), runAttempt: Number(process.env.PUSH_CI_ATTEMPT) };
  verifyPushCi({ repository, revision, ...pushCi, read: api });
  const prepared = realpathSync(process.env.PREPARED_DIRECTORY);
  verifyLocalInput(process.env, root);
  const prebuilt = JSON.parse(readFileSync(join(prepared, 'build-manifest.json')));
  assert.deepEqual(prebuilt.source, sourceBinding(root, revision), 'prepared artifact source differs');
  assert.ok(['true', 'false'].includes(process.env.FRESH_RELEASE_BUILD));
  if (process.env.FRESH_RELEASE_BUILD === 'true') {
    const backup = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'release-original-dist-')); chmodSync(backup, 0o700);
    retainFreshDist({ root, prepared, backup });
  }
  // Same-runner reuse checks the exact pinned upload's immutable API identity
  // and unchanged local input. Restoration and all native/feed checks stay real.
  verifyLocalInput(process.env, root);
  restorePreparedDist({ root, prepared, manifest: prebuilt });
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const binary = join(prepared, 'desktop-smoke-bin'); const stat = lstatSync(binary);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 512 * 1024 * 1024);
  const binaryBytes = readFileSync(binary); chmodSync(binary, 0o700);
  const endpoint = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'))).plugins.updater.endpoints[0];
  // The native launch and the network-bound updater feed read are independent:
  // run them concurrently. Both must pass; either refusal fails the smoke.
  const launch = async () => {
    const isolatedHome = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'release-smoke-home-'));
    try {
      const { stdout } = await execFileAsync(binary, ['--release-smoke'], { encoding: 'utf8', timeout: 5000,
        maxBuffer: 4096, env: { HOME: isolatedHome, PATH: '/usr/bin:/bin' } });
      checkLaunch(stdout, version, revision);
    } finally { rmSync(isolatedHome, { recursive: true, force: true }); }
  };
  const [{ feed, served, liveStatus, latestRelease }] = await Promise.all([readUpdaterFeed({ endpoint, repository }), launch()]);
  assert.deepEqual(readFileSync(binary), binaryBytes, 'launched binary changed');
  const { parseCompatibleUpdateManifest } = await import(pathToFileURL(join(root, 'dist/core/desktop/update-manifest.js')));
  const { getDesktopUpdateTrustForProfile } = await import(pathToFileURL(join(root, 'dist/core/desktop/update-trust.js')));
  checkFeed(feed, parseCompatibleUpdateManifest, getDesktopUpdateTrustForProfile('canonical-v2'));
  const snapshot = captureBuild({ root, eventSha: revision, parent: process.env.RUNNER_TEMP });
  const bundle = join(process.env.RUNNER_TEMP, 'release-handoff');
  const captured = captureArtifact({ root, sha: revision, out: bundle, snapshot,
    packageTarball: join(prepared, 'package.tgz'), reports: [], tools: () => prebuilt.tools });
  assert.deepEqual(captured.archive, prebuilt.archive, 'prepared dist bytes differ');
  assert.deepEqual(captured.package, prebuilt.package, 'prepared npm bytes differ');
  copyFileSync(binary, join(bundle, 'desktop-smoke-bin')); chmodSync(join(bundle, 'desktop-smoke-bin'), 0o400);
  // This existing receipt attests parser/launch checks, not live updater health.
  const receipt = { schemaVersion: 1, source: { revision, tree: git('rev-parse', 'HEAD^{tree}') }, pushCi,
    desktop: { filename: 'desktop-smoke-bin', sha256: digest(binaryBytes), bytes: binaryBytes.length, version, revision },
    smoke: { exitCode: 0, feedParsed: true, manifestParsed: true, versionVerified: true } };
  writeFileSync(join(bundle, 'fast-release.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o400 });
  const elapsedMs = Math.round(performance.now() - start);
  assert.ok(elapsedMs < 60000, 'release smoke exceeded the 60-second budget');
  appendFileSync(process.env.GITHUB_OUTPUT, `bundle=${bundle}\nelapsed_ms=${elapsedMs}\nupdater_live_http_status=${liveStatus}\nupdater_contract_source=${served}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release smoke: ${elapsedMs} ms; candidate ${revision}; reused push CI ${pushCi.runId}/${pushCi.runAttempt}; feed/manifest contract parsed from ${served === 'latest' ? 'releases/latest (HTTP 200)' : `stocked release ${served}; live endpoint remains unavailable (HTTP 404), latest ${latestRelease.tag} (${latestRelease.id}) is assetless; this is not updater recovery`}. Cold build, publication signature verification, signing and installed-app acceptance remain separate prerequisites.\n`);
}

/** Master is always accepted. A stable tag is accepted only when its peeled commit is this sha and an ancestor of master. */
export function acceptReleaseRef({ ref, sha, repository, read }) {
  if (ref === 'refs/heads/master') return;
  assert.match(ref ?? '', /^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'release smoke ref is not master or a stable tag');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  const name = ref.slice('refs/tags/'.length);
  let object = read(`repos/${repository}/git/ref/tags/${name}`)?.object;
  const seen = new Set();
  for (let depth = 0; object?.type === 'tag'; depth += 1) {
    assert.ok(depth < 4 && /^[a-f0-9]{40}$/.test(object.sha) && !seen.has(object.sha), 'invalid tag annotation');
    seen.add(object.sha);
    const tag = read(`repos/${repository}/git/tags/${object.sha}`);
    assert.equal(tag?.sha, object.sha, 'tag annotation sha mismatches');
    object = tag.object;
  }
  assert.equal(object?.type, 'commit', 'release tag does not peel to a commit');
  assert.equal(object.sha, sha, 'tag sha mismatches candidate');
  const compare = read(`repos/${repository}/compare/${sha}...master`);
  assert.ok(compare && (compare.status === 'ahead' || compare.status === 'identical'), 'tag is not an ancestor of master');
}

async function main() {
  const [verb] = process.argv.slice(2);
  if (verb === 'smoke') return smoke();
  if (verb === 'prepare') {
    const root = realpathSync(process.cwd()); const revision = process.env.GITHUB_SHA;
    const snapshot = captureBuild({ root, eventSha: revision, parent: process.env.RUNNER_TEMP });
    const packageTarball = packBuild({ root, eventSha: revision, snapshotPath: snapshot, parent: process.env.RUNNER_TEMP });
    const out = join(process.env.RUNNER_TEMP, 'build-handoff');
    captureArtifact({ root, sha: revision, out, snapshot, packageTarball, reports: [] });
    const prepared = join(process.env.RUNNER_TEMP, 'release-prepared'); mkdirSync(prepared, { mode: 0o700 });
    copyFileSync(join(out, 'dist.tar'), join(prepared, 'dist.tar'));
    copyFileSync(join(out, 'manifest.json'), join(prepared, 'build-manifest.json'));
    copyFileSync(packageTarball, join(prepared, 'package.tgz'));
    copyFileSync(join(root, 'desktop/src-tauri/target/debug/bundle/macos/Phantom.app/Contents/MacOS/ashlr-desktop'), join(prepared, 'desktop-smoke-bin'));
    appendFileSync(process.env.GITHUB_OUTPUT, `directory=${prepared}\n`);
    return;
  }
  assert.ok(Object.hasOwn(workflows, verb));
  const { repository } = requireProducerEnvironment(process.env);
  acceptReleaseRef({ ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, repository, read: api });
  const selected = selectRun({ kind: verb, repository, revision: process.env.GITHUB_SHA });
  appendFileSync(process.env.GITHUB_OUTPUT, `ready=${Boolean(selected)}\n`);
  for (const [key, value] of Object.entries(selected ?? {})) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`release smoke refused: ${error.message}`); process.exitCode = 1; });
}
