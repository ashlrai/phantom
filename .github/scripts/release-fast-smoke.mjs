/* global process, console, fetch, AbortSignal */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireProducerEnvironment, requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';
import { captureBuild, packBuild } from './ci-pack-smoke.mjs';
import { captureArtifact, inspectTar, sourceBinding, verifyPushCi } from '../../scripts/hosted-build-artifact.mjs';

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
    const nameOfJob = kind === 'build' ? 'Prepare unsigned desktop release' : 'Desktop release smoke';
    const matchingJobs = jobs.filter(job => job.name === nameOfJob);
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
  assert.equal(new Set(release.assets.map(asset => asset?.id)).size, release.assets.length, 'duplicate release asset identity');
  assert.equal(new Set(release.assets.map(asset => asset?.name)).size, release.assets.length, 'duplicate release asset name');
  for (const asset of release.assets) {
    assert.ok(asset && positive(asset.id) && typeof asset.name === 'string' && asset.name.length > 0 && asset.name.length <= 255, 'invalid release asset identity');
    assert.ok(['starter', 'uploaded'].includes(asset.state), 'unknown release asset state');
    assert.equal(asset.url, `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, 'release asset repository differs');
    assert.equal(asset.browser_download_url, `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`, 'release asset tag differs');
  }
}

/** Newest published release still carrying an uploaded `latest.json` asset, or
 * null. The assetless `latest` row makes the configured endpoint 404 until the
 * next stocked release publishes; the signed feed contract is then verified
 * against the last stocked feed instead of skipped. The list endpoint reports
 * newest first, but candidates are re-sorted on `created_at` defensively. */
export function stockedFeedTag(releases, repository = 'ashlrai/phantom') {
  assert.ok(Array.isArray(releases) && releases.length <= 100, 'invalid release inventory');
  for (const release of releases) assert.ok(release && positive(release.id)
    && typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean', 'unknown release state');
  assert.equal(new Set(releases.map(release => release.id)).size, releases.length, 'duplicate release identity');
  // GitHub legitimately gives drafts an /untagged-* HTML URL even after their
  // tag exists. They cannot supply this published-feed fallback.
  const candidates = releases.filter(release => !release.draft && !release.prerelease && stableTag.test(release.tag_name ?? ''));
  assert.equal(new Set(candidates.map(release => release.tag_name)).size, candidates.length, 'duplicate published release tag');
  for (const release of candidates) releaseIdentity(release, repository);
  const stocked = candidates.filter(release => release.assets.filter(asset => asset.name === 'latest.json' && asset.state === 'uploaded').length === 1);
  if (!stocked.length) return null;
  stocked.sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
  return stocked[0].tag_name;
}

/** The updater feed the installed base would consume. The configured endpoint
 * is read first; when the release it points at carries no feed asset, the
 * newest stocked published feed serves the same signed envelope, so the
 * contract check runs against it rather than dying on a mutable pointer. */
export async function readUpdaterFeed({ endpoint, repository, read = api, fetchImpl = fetch }) {
  assert.equal(endpoint, `https://github.com/${repository}/releases/latest/download/latest.json`);
  const live = await fetchImpl(endpoint, { signal: AbortSignal.timeout(10000) });
  if (live.status === 200) return { feed: await feedBody(live), served: 'latest' };
  await live.body?.cancel();
  assert.equal(live.status, 404, 'live updater feed unavailable');
  // Historical contract checks apply only to a confirmed assetless latest.
  // Outages, auth errors and missing advertised assets must remain failures.
  const latest = read(`repos/${repository}/releases/latest`);
  releaseIdentity(latest, repository);
  assert.ok(latest?.draft === false && latest.prerelease === false
    && stableTag.test(latest.tag_name ?? '')
    && latest.assets.every(asset => asset.name !== 'latest.json'), 'latest release is not confirmed assetless');
  for (let page = 1; page <= 10; page++) {
    const releases = read(`repos/${repository}/releases?per_page=100&page=${page}`);
    const tag = stockedFeedTag(releases, repository);
    if (tag === null) { if (releases.length < 100) break; continue; }
    const stocked = await fetchImpl(`https://github.com/${repository}/releases/download/${tag}/latest.json`, { signal: AbortSignal.timeout(10000) });
    assert.equal(stocked.status, 200, 'stocked updater feed unavailable');
    const asset = releases.find(release => release.tag_name === tag).assets.find(asset => asset.name === 'latest.json' && asset.state === 'uploaded');
    assert.ok(positive(asset.size) && asset.size <= 128 * 1024 && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''), 'invalid stocked feed asset');
    const feed = await feedBody(stocked, asset);
    assert.equal(`v${feed.version}`, tag, 'stocked feed version differs from release');
    return { feed, served: tag };
  }
  assert.fail('no stocked updater feed release');
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
  const prebuilt = JSON.parse(readFileSync(join(prepared, 'build-manifest.json')));
  assert.deepEqual(prebuilt.source, sourceBinding(root, revision), 'prepared artifact source differs');
  // download-artifact checks the immutable artifact's digest before this step.
  // These are output paths from a successful trusted master build, never PR caches.
  restorePreparedDist({ root, prepared, manifest: prebuilt });
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const binary = join(prepared, 'desktop-smoke-bin'); const stat = lstatSync(binary);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 512 * 1024 * 1024);
  const binaryBytes = readFileSync(binary); chmodSync(binary, 0o700);
  const isolatedHome = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'release-smoke-home-'));
  try {
    checkLaunch(execFileSync(binary, ['--release-smoke'], { encoding: 'utf8', timeout: 5000,
      maxBuffer: 4096, env: { HOME: isolatedHome, PATH: '/usr/bin:/bin' } }), version, revision);
  } finally { rmSync(isolatedHome, { recursive: true, force: true }); }
  assert.deepEqual(readFileSync(binary), binaryBytes, 'launched binary changed');
  const endpoint = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'))).plugins.updater.endpoints[0];
  const { feed, served } = await readUpdaterFeed({ endpoint, repository });
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
  const receipt = { schemaVersion: 1, source: { revision, tree: git('rev-parse', 'HEAD^{tree}') }, pushCi,
    desktop: { filename: 'desktop-smoke-bin', sha256: digest(binaryBytes), bytes: binaryBytes.length, version, revision },
    smoke: { exitCode: 0, feedParsed: true, manifestParsed: true, versionVerified: true } };
  writeFileSync(join(bundle, 'fast-release.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o400 });
  const elapsedMs = Math.round(performance.now() - start);
  assert.ok(elapsedMs < 60000, 'release smoke exceeded the 60-second budget');
  appendFileSync(process.env.GITHUB_OUTPUT, `bundle=${bundle}\nelapsed_ms=${elapsedMs}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release smoke: ${elapsedMs} ms; candidate ${revision}; reused push CI ${pushCi.runId}/${pushCi.runAttempt}; updater feed verified from ${served === 'latest' ? 'releases/latest' : `stocked release ${served}`}. Cold build and signing are separate prerequisites.\n`);
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
  assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
  const { repository } = requireProducerEnvironment(process.env);
  const selected = selectRun({ kind: verb, repository, revision: process.env.GITHUB_SHA });
  appendFileSync(process.env.GITHUB_OUTPUT, `ready=${Boolean(selected)}\n`);
  for (const [key, value] of Object.entries(selected ?? {})) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`release smoke refused: ${error.message}`); process.exitCode = 1; });
}
