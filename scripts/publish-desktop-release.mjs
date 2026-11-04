#!/usr/bin/env node
// Maintainer publish step of the release train: take the private finalizer
// output, re-verify it exactly like the consumer does, attach its exact signed
// bytes to the tag's GitHub release and publish that release as latest.
// This never builds, signs, reauthorizes, clears Stop or touches installed
// state. Without --publish it performs every check and prints the plan only —
// that is the dry run that proves the tag -> release -> feed transition.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sourceBinding,
  inspectCommissionedManualPublication,
} from './hosted-build-artifact.mjs';
import {
  readFinalizedDesktopArtifacts,
  verifyManualDesktopSource,
} from './install-desktop-artifacts.mjs';
import { desktopPublisherGithub } from './finalize-desktop-update.mjs';
import { getDesktopReleaseToolchain } from './desktop-release-policy.mjs';
import { requireRepositoryMetadata } from '../.github/scripts/github-repository-binding.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const admissions = new WeakMap();
const digest = (data) => createHash('sha256').update(data).digest('hex');
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const text = (data) => { const value = data.toString('utf8'); assert.ok(Buffer.from(value).equals(data), 'invalid UTF8'); return value; };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const USAGE = 'node scripts/publish-desktop-release.mjs --candidate-source <qualified-checkout> --bundle <signed-hosted-bundle> --artifacts <private-finalizer-output> [--publish]';

export function parseReleasePublishArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const flags = {}; let publish = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--publish') { assert.equal(publish, false, 'duplicate publish'); publish = true; continue; }
    assert.ok(['--candidate-source', '--bundle', '--artifacts'].includes(flag) && !Object.hasOwn(flags, flag), 'unknown or duplicate argument');
    const value = argv[++i];
    assert.ok(typeof value === 'string' && value.length > 0 && resolve(value) === value && !value.startsWith('--'), 'expected canonical absolute directory');
    flags[flag] = value;
  }
  assert.equal(Object.keys(flags).length, 3, 'all three input directories are required');
  assert.ok(new Set(Object.values(flags)).size === 3, 'input directories must be distinct');
  return { candidateRoot: flags['--candidate-source'], bundle: flags['--bundle'], artifacts: flags['--artifacts'], publish };
}

/** Ordered asset plan: artifacts and signatures first, the feed pointer last. */
function expectedAssets(observed) {
  const m = observed.manifest, files = observed.files;
  const names = [m.cli.filename, `${m.cli.filename}.sig`, m.app.filename, `${m.app.filename}.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
  assert.deepEqual([...files.keys()].sort(), [...names].sort(), 'finalizer output does not match the published asset set');
  return names.map(name => ({ name, sha256: files.get(name).sha256, bytes: files.get(name).data.length }));
}

function ownedFile(path, expected) {
  const before = fs.lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid() && same(before, expected.identity), 'finalized artifact changed');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const data = fs.readFileSync(fd);
    assert.ok(data.length === before.size && same(before, fs.fstatSync(fd)) && digest(data) === expected.sha256, 'finalized artifact bytes differ');
  } finally { fs.closeSync(fd); }
}

/** Fresh ownership+byte proof at the effect boundary; nothing is trusted from the earlier admission. */
function unchangedArtifacts(observed) {
  for (const [name, row] of observed.files) ownedFile(join(observed.path, name), row);
}

/** Pure publication plan; refusal here means the operator fixes state, never the script. */
export function planDesktopReleasePublication({ version, revision, release, assets, expected }) {
  assert.ok(TAG.test(`v${version}`) && SHA.test(revision), 'invalid release identity');
  if (release === null) {
    return { releaseId: null, create: true, uploads: expected.map(a => a.name), publish: true };
  }
  assert.equal(object(release)?.draft, true, 'release is already published — refusing to touch a live feed');
  assert.equal(release.prerelease, false, 'prerelease flag differs');
  assert.equal(release.tag_name, `v${version}`, 'release tag differs');
  assert.equal(release.target_commitish, revision, 'release target commit differs from the qualified source');
  const known = new Map(expected.map(a => [a.name, a]));
  const uploads = new Set(expected.map(a => a.name));
  for (const asset of assets) {
    const want = known.get(asset.name);
    assert.ok(want !== undefined, `unexpected existing asset ${asset.name}`);
    assert.equal(asset.state, 'uploaded', `asset ${asset.name} is not uploaded`);
    assert.equal(asset.digest, `sha256:${want.sha256}`, `asset ${asset.name} digest differs`);
    uploads.delete(asset.name);
  }
  return { releaseId: release.id, create: false, uploads: [...uploads], publish: true };
}

/** Walk tag -> annotated tag -> commit; the tag must resolve to the qualified source. */
function resolveTagCommit(read, base, version) {
  const ref = read(`${base}/git/ref/tags/v${version}`);
  assert.equal(object(ref)?.ref, `refs/tags/v${version}`, 'release tag is absent');
  let target = ref.object; const seen = new Set();
  for (let depth = 0; target?.type === 'tag'; depth++) {
    assert.ok(depth < 4 && SHA.test(target.sha ?? '') && !seen.has(target.sha), 'invalid release tag chain');
    seen.add(target.sha);
    const tag = read(`${base}/git/tags/${target.sha}`);
    assert.equal(tag.sha, target.sha); target = tag.object;
  }
  assert.ok(target?.type === 'commit' && SHA.test(target.sha ?? ''), 'release tag does not resolve to a commit');
  return target.sha;
}

function pagedRead(read, endpoint, key) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const part = read(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = Array.isArray(part) ? part : (part?.[key] ?? []);
    rows.push(...list);
    if (!Array.isArray(list) || list.length < 100) break;
  }
  return rows;
}

export async function inspectDesktopReleasePublication(input, dependencies) {
  const observed = await readFinalizedDesktopArtifacts(input.artifacts, dependencies.primitives);
  const m = observed.manifest, repository = m.repository.nameWithOwner, base = `repos/${repository}`;
  const source = sourceBinding(input.candidateRoot, m.source.revision);
  assert.equal(source.tree, m.source.tree, 'candidate source tree differs');
  const envelope = { manifestText: text(observed.files.get('manifest.json').data), signature: text(observed.files.get('manifest.json.sig').data) };
  // The same hosted qualification proof the consumer requires, on the same
  // exact revision. A release can only ship the bytes the hosted chain made.
  const verifySource = dependencies.verifySource ?? ((i, manifest, envelope2) =>
    verifyReleaseSource(i, manifest, dependencies.transport, envelope2));
  await verifySource({ candidateRoot: input.candidateRoot, bundle: input.bundle }, m, envelope);
  requireRepositoryMetadata(repository, dependencies.transport.githubRead(base));
  const tagSha = resolveTagCommit(dependencies.transport.githubRead, base, m.version);
  assert.equal(tagSha, m.source.revision, 'release tag differs from the signed candidate');
  const release = await dependencies.transport.githubReadOrNull(`${base}/releases/tags/v${m.version}`);
  const assets = release === null ? [] : pagedRead(dependencies.transport.githubRead, `${base}/releases/${release.id}/assets`);
  const expected = expectedAssets(observed);
  const plan = planDesktopReleasePublication({ version: m.version, revision: m.source.revision, release, assets, expected });
  const result = Object.freeze({ state: 'verified-release-plan', version: m.version, tag: `v${m.version}`, plan: Object.freeze(plan) });
  admissions.set(result, { input, observed, envelope, repository, source, plan });
  return result;
}

export async function applyDesktopReleasePublication(result, dependencies) {
  const admitted = admissions.get(result);
  assert.ok(admitted && !admitted.attempted, 'missing or replayed in-process admission');
  admitted.attempted = true;
  const { input, observed, envelope, repository, plan } = admitted, m = observed.manifest;
  const tag = `v${m.version}`, base = `repos/${repository}`, transport = dependencies.transport;
  unchangedArtifacts(observed);
  let releaseId = plan.releaseId;
  if (plan.create) {
    const latest = await transport.githubReadOrNull(`${base}/releases/latest`);
    const fields = { tag_name: tag, target_commitish: m.source.revision, name: `Phantom ${m.version}`, draft: true, prerelease: false, generate_notes: true };
    if (object(latest) && TAG.test(latest.tag_name ?? '')) fields.notes_start_tag = latest.tag_name;
    const created = await transport.githubWrite('POST', `${base}/releases`, fields);
    assert.equal(object(created)?.draft, true, 'release did not land as a draft');
    releaseId = created.id;
  }
  const expected = expectedAssets(observed);
  for (const name of plan.uploads) {
    transport.upload(tag, join(input.artifacts, name), name);
  }
  const listed = pagedRead(transport.githubRead, `${base}/releases/${releaseId}/assets`);
  for (const asset of expected) {
    const match = listed.filter(a => a.name === asset.name);
    assert.equal(match.length, 1, `published asset ${asset.name} absent or ambiguous`);
    assert.equal(match[0].state, 'uploaded', `published asset ${asset.name} not uploaded`);
    assert.equal(match[0].size, asset.bytes, `published asset ${asset.name} size differs`);
    assert.equal(match[0].digest, `sha256:${asset.sha256}`, `published asset ${asset.name} digest differs`);
  }
  await transport.githubWrite('PATCH', `${base}/releases/${releaseId}`, { draft: false, make_latest: 'true' });
  const latest = transport.githubRead(`${base}/releases/latest`);
  assert.equal(latest.tag_name, tag, 'latest release does not resolve to this tag');
  assert.equal(latest.draft, false, 'published release still a draft');
  // The updater's entry point must now serve the verified feed bytes.
  const feed = await transport.downloadRead(`https://github.com/${repository}/releases/latest/download/latest.json`, 128 * 1024);
  assert.ok(feed.equals(observed.files.get('latest.json').data), 'published discovery feed differs');
  // Deep independent re-verification of the published state before reporting.
  await dependencies.verifyPublication({
    manifestText: envelope.manifestText, signature: envelope.signature,
    githubRead: transport.githubRead, downloadRead: transport.downloadRead,
  });
  return Object.freeze({ state: 'published', version: m.version, tag, releaseId });
}

/** Own code/build closure is qualified separately from the release being shipped. */
export async function productionPublisherDependencies() {
  const tools = getDesktopReleaseToolchain();
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(fs.realpathSync(process.execPath), tools.node, 'use the commissioned Node binary');
  const [manifest, trust, qualified, archive, authority] = await Promise.all([
    import('../dist/core/desktop/update-manifest.js'), import('../dist/core/desktop/update-trust.js'),
    import('../dist/core/desktop/qualified-update.js'), import('../dist/core/local-runtime/archive.js'), import('../dist/core/authority/surface.js')]);
  const updateTrust = trust.getDesktopUpdateTrust(), repository = updateTrust.repository.fullName;
  const github = desktopPublisherGithub(ROOT, tools);
  const env = { HOME: tools.home, GH_CONFIG_DIR: join(tools.home, '.config/gh'), GH_HOST: 'github.com', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  const gh = (args) => execFileSync(tools.gh, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const readOrNull = (endpoint) => {
    try { return JSON.parse(gh(['api', '--hostname', 'github.com', endpoint])); }
    catch (error) {
      if (/HTTP\s*404/.test(String(error?.stderr ?? ''))) return null;
      throw error;
    }
  };
  return {
    primitives: { ...manifest, ...qualified, ...archive, ...authority, trust: updateTrust, appleSigner: tools.appleSigner },
    transport: {
      githubRead: github.read, attestRun: github.attestRun,
      githubReadOrNull: async (endpoint) => readOrNull(endpoint),
      githubWrite: async (method, endpoint, fields) => JSON.parse(gh(['api', '--hostname', 'github.com', '-X', method, endpoint, ...Object.entries(fields).flatMap(([k, v]) => ['-F', `${k}=${v}`])])),
      upload: (tag, path, name) => { gh(['release', 'upload', tag, `${path}#${name}`, '--repo', repository]); },
      downloadRead: qualified.downloadQualifiedUpdateArtifact,
    },
    verifyPublication: ({ manifestText, signature, githubRead, downloadRead }) =>
      inspectCommissionedManualPublication({ manifestText, signature, githubRead, downloadRead }),
  };
}

/** The real hosted-qualification gate — the default behind the injected seam. */
export function verifyReleaseSource(input, manifest, transport, envelope) {
  return verifyManualDesktopSource(input, manifest, { githubRead: transport.githubRead, attestRun: transport.attestRun }, envelope);
}

async function main() {
  try {
    const input = parseReleasePublishArguments(process.argv.slice(2));
    if (input.help) { console.log(USAGE); console.log('Dry run by default: every check runs, nothing is written. --publish performs the upload and flips the draft to latest.'); return; }
    const dependencies = await productionPublisherDependencies();
    const inspected = await inspectDesktopReleasePublication(input, dependencies);
    const outcome = input.publish ? await applyDesktopReleasePublication(inspected, dependencies) : inspected;
    console.log(JSON.stringify(outcome));
  } catch (error) {
    console.error(JSON.stringify({ state: 'held', error: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
