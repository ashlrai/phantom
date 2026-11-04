/* global Buffer, URL */
// RQ-NIGHT-RELEASE-1 dry run of the whole train: merged release PR -> tag ->
// GitHub release -> published feed with the unsigned mac artifact -> installed
// 3.29.15 reports 3.29.17 available. Hermetic: a fake GitHub remote records
// every read/write; all verification code under test is the real thing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {parse} from 'yaml';
import {createTagAndDraftRelease} from '../scripts/tag-github-release.mjs';
import {
  parseReleasePublishArguments, planDesktopReleasePublication,
  inspectDesktopReleasePublication, applyDesktopReleasePublication,
} from '../../scripts/publish-desktop-release.mjs';

const REPO = 'ashlrai/phantom';
const hash = data => createHash('sha256').update(data).digest('hex');
const MODULES = ['desktop/update-manifest', 'authority/canonical-json', 'verse/release-version-guard'];
const repository = {full_name: REPO, id: 1263526319, node_id: 'R_kgDOS0_hrw',
  owner: {id: 258113726, login: 'ashlrai'}, default_branch: 'master', private: false, visibility: 'public'};

function transpile(dir) {
  for (const name of MODULES) {
    const out = join(dir, 'core', `${name}.js`);
    fs.mkdirSync(join(out, '..'), {recursive: true});
    fs.writeFileSync(out, ts.transpileModule(
      fs.readFileSync(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8'),
      {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText);
  }
}

/** In-memory GitHub: refs, releases and assets behind the exact API surface the scripts use. */
function remote() {
  const refs = new Map(), releases = new Map(), assets = new Map();
  let nextId = 100; const calls = [];
  const notFound = () => { const e = new Error('HTTP 404'); e.status = 404; return e; };
  const latestRelease = () => [...releases.values()].filter(r => !r.draft).sort((a, b) => b.id - a.id)[0] ?? null;
  const publicJson = row => ({...row, assets: undefined});
  const read = endpoint => {
    const path = endpoint.split('?')[0], seg = path.split('/');
    calls.push(['read', endpoint]);
    if (path === `repos/${REPO}`) return repository;
    if (seg[3] === 'git' && seg[4] === 'ref') { const ref = refs.get(seg.slice(5).join('/')); if (!ref) throw notFound(); return ref; }
    if (seg[3] === 'git' && seg[4] === 'tags') { const tag = refs.get(`tags/${seg[5]}`); if (!tag) throw notFound(); return tag; }
    if (seg[3] === 'releases' && seg[4] === 'tags') { const r = [...releases.values()].find(x => x.tag_name === seg[5]); if (!r) throw notFound(); return publicJson(r); }
    if (seg[3] === 'releases' && seg[4] === 'latest') { const r = latestRelease(); if (!r) throw notFound(); return publicJson(r); }
    if (seg[3] === 'releases' && seg[5] === 'assets') { return [...(assets.get(Number(seg[4]))?.values() ?? [])].map((asset) => { const rest = {...asset}; delete rest.data; return rest; }); }
    if (seg[3] === 'releases') { const r = releases.get(Number(seg[4])); if (!r) throw notFound(); return publicJson(r); }
    throw new Error(`unhandled read ${endpoint}`);
  };
  const write = async (method, endpoint, fields) => {
    calls.push(['write', method, endpoint, fields]);
    const seg = endpoint.split('/');
    if (method === 'POST' && endpoint === `repos/${REPO}/git/refs`) {
      assert.equal(refs.has(fields.ref), false, 'ref exists');
      refs.set(fields.ref.slice(5), {ref: fields.ref, object: {type: 'commit', sha: fields.sha}});
      return refs.get(fields.ref.slice(5));
    }
    if (method === 'POST' && endpoint === `repos/${REPO}/releases`) {
      const row = {id: ++nextId, draft: fields.draft === true || fields.draft === 'true', prerelease: false,
        tag_name: fields.tag_name, target_commitish: fields.target_commitish, name: fields.name,
        published_at: '2026-11-04T00:00:00Z'};
      releases.set(row.id, row); assets.set(row.id, new Map());
      return publicJson(row);
    }
    if (method === 'PATCH' && seg[3] === 'releases' && seg.length === 5) {
      const row = releases.get(Number(seg[4])); assert.ok(row, 'release missing');
      if (fields.draft === false || fields.draft === 'false') { row.draft = false; row.make_latest = fields.make_latest; }
      return publicJson(row);
    }
    throw new Error(`unhandled write ${method} ${endpoint}`);
  };
  const upload = (tag, path, name) => {
    calls.push(['upload', tag, name]);
    const row = [...releases.values()].find(r => r.tag_name === tag); assert.ok(row, 'release missing');
    const data = fs.readFileSync(path); const id = ++nextId;
    assets.get(row.id).set(name, {id, name, size: data.length, digest: `sha256:${hash(data)}`, state: 'uploaded',
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, data});
    return {id};
  };
  const downloadRead = async (url) => {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/(latest|download\/(v[^/]+))\/download\/(.+)$/.exec(url);
    assert.ok(match && match[1] === REPO, 'foreign feed URL');
    const row = match[2] === 'latest' ? latestRelease() : [...releases.values()].find(r => r.tag_name === match[3]);
    assert.ok(row, 'no published release for feed');
    const asset = assets.get(row.id)?.get(match[4]);
    assert.ok(asset, `feed asset ${match[4]} absent`);
    return asset.data;
  };
  return {refs, releases, assets, calls, read, write, upload, downloadRead, latestRelease};
}

function fixtureKeys() {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519'), id = Buffer.from('0102030405060708', 'hex');
  const publicPacket = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({format: 'der', type: 'spki'}).subarray(-32)]);
  const trusted = Buffer.from(`untrusted comment: train fixture\n${publicPacket.toString('base64')}\n`).toString('base64');
  const sig = data => {
    const signed = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'train fixture';
    return Buffer.from(`untrusted comment: t\n${Buffer.concat([Buffer.from('ED'), id, signed]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64');
  };
  return {trusted, sig};
}

/** Real git checkout at the release revision + private finalizer output dir. */
async function fixture(t, remoteRepo, version = '3.29.17') {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'release-train-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(join(dir, 'core'), {recursive: true}); transpile(dir);
  const manifest = await import(pathToFileURL(join(dir, 'core/desktop/update-manifest.js')));
  const {canonicalJson} = await import(pathToFileURL(join(dir, 'core/authority/canonical-json.js')));
  const guard = await import(pathToFileURL(join(dir, 'core/verse/release-version-guard.js')));
  const {trusted, sig} = fixtureKeys();
  const trust = {publicKey: trusted, repository: {fullName: REPO, repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw',
    ownerLogin: 'ashlrai', ownerId: 258113726, ownerNodeId: 'O_kgDOD2KAvg'}, channel: 'stable', platform: 'darwin-aarch64'};

  const candidate = join(dir, 'candidate'); fs.mkdirSync(candidate, {mode: 0o700});
  const git = args => execFileSync('git', args, {cwd: candidate, encoding: 'utf8', env: {HOME: dir, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1'}});
  git(['init', '-q', '-b', 'master']); git(['config', 'user.email', 'fixture@example.com']); git(['config', 'user.name', 'fixture']);
  fs.writeFileSync(join(candidate, 'package.json'), JSON.stringify({name: '@ashlr/phantom', version}));
  git(['add', '-A']); git(['commit', '-qm', `release ${version}`]);
  const revision = git(['rev-parse', 'HEAD']).trim(), tree = git(['rev-parse', 'HEAD^{tree}']).trim();

  const cli = Buffer.from('test-only signed cli package'), app = Buffer.from('test-only unsigned mac app archive');
  const artifact = (filename, data) => ({filename, url: `https://github.com/${REPO}/releases/download/v${version}/${filename}`,
    bytes: data.length, sha256: hash(data), signature: sig(data)});
  const surface = 'a'.repeat(64);
  const m = {schemaVersion: 2, kind: 'phantom-paired-release', channel: 'stable', platform: 'darwin-aarch64', version,
    repository: {nameWithOwner: REPO, repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw', ownerId: 258113726, ownerLogin: 'ashlrai', defaultBranch: 'master'},
    source: {revision, tree}, authoritySurfaceDigest: surface,
    cli: {...artifact(`ashlr-phantom-${version}.tgz`, cli), packageName: '@ashlr/phantom', binName: 'ashlr'},
    app: {...artifact(`Phantom_${version}_aarch64.app.tar.gz`, app), bundleIdentifier: 'ai.ashlr.desktop', executable: 'ashlr-desktop',
      inventorySha256: 'b'.repeat(64), signer: 'A'.repeat(40)},
    qualification: {manifestSha256: 'c'.repeat(64), archiveSha256: 'd'.repeat(64), packageSha256: hash(cli), qualificationSha256: 'e'.repeat(64),
      producer: {runId: 10, runAttempt: 1, eventSha: revision}, attestor: {revision: 'f'.repeat(40), runId: 11, runAttempt: 1}, audit: {revision, runId: 12, runAttempt: 1}}};
  const manifestText = canonicalJson(m), envelope = {manifestText, signature: sig(Buffer.from(manifestText))};
  const marker = Buffer.from(canonicalJson({schemaVersion: 1, version, source: m.source, authoritySurfaceDigest: surface, packageSha256: hash(cli)}));
  const feed = canonicalJson({version, platforms: {'darwin-aarch64': {url: m.app.url, signature: m.app.signature}}, phantom: envelope});

  const artifacts = join(dir, 'artifacts'); fs.mkdirSync(artifacts, {mode: 0o700});
  const write = (name, data, mode = 0o600) => { fs.writeFileSync(join(artifacts, name), data, {mode}); };
  write('manifest.json', manifestText); write('manifest.json.sig', envelope.signature, 0o644);
  write(m.cli.filename, cli); write(`${m.cli.filename}.sig`, m.cli.signature, 0o644);
  write(m.app.filename, app); write(`${m.app.filename}.sig`, m.app.signature, 0o644);
  write('latest.json', feed);
  const bundle = join(dir, 'bundle'); fs.mkdirSync(bundle, {mode: 0o700});
  fs.writeFileSync(join(bundle, m.cli.filename), cli);
  fs.writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({producer: {repository: REPO}, source: m.source,
    package: {filename: m.cli.filename, sha256: m.cli.sha256}}));

  const primitives = {...manifest, trust, appleSigner: 'A'.repeat(40),
    inspectSignedAppArchive: () => [{path: 'Phantom.app/Contents/Resources/phantom-release.json', directory: false, data: marker}],
    readPinnedRuntimeArchive: async () => ({pins: new Map(Array.from({length: cli.length}, (_, i) => [`f${i}`, i]))})};
  return {dir, candidate, bundle, artifacts, manifest: m, manifestModule: manifest, canonicalJson, guard, envelope, feed, primitives, revision};
}

const transport = (remoteRepo) => ({
  githubRead: (endpoint) => remoteRepo.read(endpoint),
  githubReadOrNull: async (endpoint) => { try { return remoteRepo.read(endpoint); } catch (error) { if (error.status === 404) return null; throw error; } },
  githubWrite: (method, endpoint, fields) => remoteRepo.write(method, endpoint, fields),
  upload: (tag, path, name) => remoteRepo.upload(tag, path, name),
  attestRun: () => '',
  downloadRead: (url) => remoteRepo.downloadRead(url),
});

test('release train dry run: merged PR -> tag -> draft -> published feed -> update available for 3.29.15', async t => {
  const remoteRepo = remote(), f = await fixture(t, remoteRepo);
  // Prior world: v3.29.15 shipped — the installed app's last known good feed.
  const old = {id: 99, tag_name: 'v3.29.15', draft: false, prerelease: false, target_commitish: '0'.repeat(40),
    name: 'Phantom 3.29.15', published_at: '2026-10-14T00:00:00Z'};
  remoteRepo.releases.set(99, old); remoteRepo.assets.set(99, new Map());
  remoteRepo.refs.set('tags/v3.29.15', {ref: 'refs/tags/v3.29.15', object: {type: 'commit', sha: '0'.repeat(40)}});

  // 1. auto-tag.yml leg: version on the merged commit is untagged, checks green.
  const leg = await createTagAndDraftRelease({repo: REPO, version: '3.29.17', sha: f.revision,
    read: async ep => { try { return remoteRepo.read(ep); } catch (e) { if (e.status === 404) return null; throw e; } },
    write: (m, ep, fields) => remoteRepo.write(m, ep, fields)});
  assert.equal(leg.release, 'draft-created');
  assert.deepEqual(remoteRepo.refs.get('tags/v3.29.17'), {ref: 'refs/tags/v3.29.17', object: {type: 'commit', sha: f.revision}});
  const draft = [...remoteRepo.releases.values()].find(r => r.tag_name === 'v3.29.17');
  assert.equal(draft.draft, true); assert.equal(draft.target_commitish, f.revision); assert.equal(draft.name, 'Phantom 3.29.17');
  // A draft never disturbs the updater's latest endpoint while it is unstocked.
  assert.equal(remoteRepo.latestRelease().tag_name, 'v3.29.15');
  assert.equal(remoteRepo.calls.find(c => c[0] === 'write' && c[2].endsWith('/releases'))[3].notes_start_tag, 'v3.29.15');

  // 2. Sanctioned publish leg: verification only (dry run) mutates nothing.
  const deps = {primitives: f.primitives, transport: transport(remoteRepo),
    verifySource: async (i, m) => { assert.equal(m.version, '3.29.17'); return {revision: f.revision}; },
    verifyPublication: async ({manifestText, signature, downloadRead}) => {
      const checked = f.manifestModule.verifyCompatibleUpdateManifest({manifestText, signature}, f.primitives.trust);
      assert.equal(checked.manifest.version, '3.29.17');
      const feed = JSON.parse((await downloadRead(`https://github.com/${REPO}/releases/latest/download/latest.json`)).toString());
      assert.equal(feed.version, '3.29.17');
    }};
  const before = remoteRepo.calls.length;
  const inspected = await inspectDesktopReleasePublication({candidateRoot: f.candidate, bundle: f.bundle, artifacts: f.artifacts}, deps);
  assert.equal(inspected.state, 'verified-release-plan');
  assert.deepEqual(inspected.plan, {releaseId: draft.id, create: false, uploads: [
    `ashlr-phantom-3.29.17.tgz`, `ashlr-phantom-3.29.17.tgz.sig`,
    `Phantom_3.29.17_aarch64.app.tar.gz`, `Phantom_3.29.17_aarch64.app.tar.gz.sig`,
    'manifest.json', 'manifest.json.sig', 'latest.json'], publish: true});
  assert.equal(remoteRepo.calls.slice(before).every(c => c[0] === 'read'), true, 'inspection wrote to the remote');

  // 3. --publish: the unsigned mac artifact lands, the release goes latest.
  const published = await applyDesktopReleasePublication(inspected, deps);
  assert.equal(published.state, 'published'); assert.equal(published.tag, 'v3.29.17');
  const feedAsset = remoteRepo.assets.get(draft.id).get('latest.json');
  assert.ok(feedAsset && remoteRepo.latestRelease().id === draft.id && remoteRepo.latestRelease().draft === false);
  const names = [...remoteRepo.assets.get(draft.id).keys()];
  for (const name of names) assert.ok(inspected.plan.uploads.includes(name), `unplanned asset ${name}`);

  // 4. An installed 3.29.15 resolves releases/latest/download/latest.json,
  // verifies the signed envelope and finds a strictly newer version.
  const feedBytes = await remoteRepo.downloadRead(`https://github.com/${REPO}/releases/latest/download/latest.json`);
  const discovery = JSON.parse(feedBytes.toString());
  assert.deepEqual(Object.keys(discovery).sort(), ['phantom', 'platforms', 'version']);
  const checked = f.manifestModule.verifyCompatibleUpdateManifest(discovery.phantom, f.primitives.trust);
  assert.equal(checked.manifest.version, '3.29.17');
  assert.equal(discovery.platforms['darwin-aarch64'].url, checked.manifest.app.url);
  assert.equal(discovery.platforms['darwin-aarch64'].signature, checked.manifest.app.signature);
  const installed = f.guard.parseReleaseVersion('3.29.15'), latest = f.guard.parseReleaseVersion(checked.manifest.version);
  assert.equal(f.guard.compareReleaseVersions(installed, latest), -1, 'installed 3.29.15 must see 3.29.17 as newer');
});

test('inspection refuses a live release, a foreign tag target and tampered bytes', async t => {
  const remoteRepo = remote(), f = await fixture(t, remoteRepo);
  const deps = {primitives: f.primitives, transport: transport(remoteRepo),
    verifySource: async () => ({}), verifyPublication: async () => {}};
  remoteRepo.refs.set('tags/v3.29.17', {ref: 'refs/tags/v3.29.17', object: {type: 'commit', sha: f.revision}});

  // Already-published release: refuse without a single write.
  remoteRepo.releases.set(1, {id: 1, tag_name: 'v3.29.17', draft: false, prerelease: false, target_commitish: f.revision, name: 'x', published_at: '2026-01-01T00:00:00Z'});
  remoteRepo.assets.set(1, new Map());
  await assert.rejects(inspectDesktopReleasePublication({candidateRoot: f.candidate, bundle: f.bundle, artifacts: f.artifacts}, deps), /already published/);
  assert.equal(remoteRepo.calls.every(c => c[0] === 'read'), true);

  remoteRepo.releases.clear(); remoteRepo.assets.clear();
  remoteRepo.refs.set('tags/v3.29.17', {ref: 'refs/tags/v3.29.17', object: {type: 'commit', sha: '9'.repeat(40)}});
  await assert.rejects(inspectDesktopReleasePublication({candidateRoot: f.candidate, bundle: f.bundle, artifacts: f.artifacts}, deps), /release tag differs/);

  remoteRepo.refs.set('tags/v3.29.17', {ref: 'refs/tags/v3.29.17', object: {type: 'commit', sha: f.revision}});
  fs.appendFileSync(join(f.artifacts, f.manifest.cli.filename), 'tamper');
  await assert.rejects(inspectDesktopReleasePublication({candidateRoot: f.candidate, bundle: f.bundle, artifacts: f.artifacts}, deps));
});

test('tag+draft script is idempotent and refuses tag drift', async () => {
  const remoteRepo = remote(); const sha = 'a'.repeat(40);
  const read = async ep => { try { return remoteRepo.read(ep); } catch (e) { if (e.status === 404) return null; throw e; } };
  const write = (m, ep, fields) => remoteRepo.write(m, ep, fields);
  const first = await createTagAndDraftRelease({repo: REPO, version: '3.29.17', sha, read, write});
  assert.equal(first.release, 'draft-created');
  remoteRepo.calls.length = 0;
  const second = await createTagAndDraftRelease({repo: REPO, version: '3.29.17', sha, read, write});
  assert.equal(second.release, 'exists');
  assert.equal(remoteRepo.calls.some(c => c[0] === 'write'), false, 'rerun rewrote the remote');
  await assert.rejects(createTagAndDraftRelease({repo: REPO, version: '3.29.17', sha: 'b'.repeat(40), read, write}), /different commit/);
});

test('workflows carry the merged-PR -> tag -> release wiring with no widened permissions', () => {
  const read = name => fs.readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
  const autoTag = parse(read('auto-tag.yml'));
  const ci = parse(read('ci.yml'));
  const rp = parse(read('release-please.yml'));

  // Merged release PR -> workflow fires on the master push (and on CI's
  // workflow_run for queue merges whose checks completed elsewhere).
  assert.ok(autoTag.on.push.branches.includes('master'));
  assert.ok(autoTag.on.push.paths.includes('package.json'));
  assert.equal(autoTag.on.workflow_run.workflows[0], 'CI');
  assert.deepEqual(autoTag.permissions, {});
  const tagJob = autoTag.jobs.tag;
  assert.deepEqual(tagJob.permissions, {contents: 'read', checks: 'read'});
  const names = tagJob.steps.map(s => s.name ?? '');
  assert.ok(names.some(n => n.startsWith('Detect version')));
  assert.ok(names.some(n => n.startsWith('Require every required check')));;
  const tagStep = tagJob.steps.find(s => typeof s.run === 'string' && s.run.includes('tag-github-release.mjs'));
  assert.ok(tagStep, 'tag step must run .github/scripts/tag-github-release.mjs');
  assert.ok(tagStep.run.includes('node .github/scripts/tag-github-release.mjs'));
  assert.ok(String(tagStep.if).includes('checks.outputs.green'), 'tag step must gate on green checks');
  assert.ok(String(tagStep.env?.GH_TOKEN).includes('steps.app.outputs.token'), 'tag step must use the scoped app token, not GITHUB_TOKEN');
  const detect = tagJob.steps.find(s => /Detect version/.test(s.name ?? ''));
  assert.ok(detect.run.includes('ls-remote --exit-code --tags'), 'tag existence check must run before the version-unchanged bail-out');
  assert.ok(detect.run.indexOf('ls-remote --exit-code --tags') < detect.run.indexOf('"$new" = "$old"'),
    'tag existence must be checked before the unchanged-version early exit');

  // Master pushes produce the required Merge Gate check without widening perms.
  assert.deepEqual(ci.on.push.branches, ['master']);
  assert.deepEqual(ci.permissions, {contents: 'read'});
  assert.ok(String(ci.jobs.quick.if).includes("github.event_name == 'push' && github.ref == 'refs/heads/master'"), 'quick gate must run on master pushes only');
  assert.ok(String(ci.jobs.ci.if).includes("github.event_name == 'push' && github.ref == 'refs/heads/master'"), 'full matrix stays off master pushes');
  assert.ok(String(ci.jobs.ci.if).includes('!('), 'ci must exclude master pushes while keeping tag-push reusable calls');
  const mergeGate = ci.jobs['merge-gate'] ?? ci.jobs[Object.keys(ci.jobs).find(k => /merge/i.test(k))];
  const gateRun = mergeGate.steps.map(s => s.run ?? '').join('\n');
  assert.ok(gateRun.includes("'push'"), 'Merge Gate must treat push as fast lane');
  assert.equal(mergeGate.steps.every(s => !s.env || !String(s.env.GITHUB_TOKEN).includes('secrets.')), true);

  // The merge leg stays the sanctioned guarded route, not a workflow shortcut:
  // release-please.yml must not gain an unguarded `gh pr merge` (the ops merge
  // API's releaseVersionVerdict is what refuses a stale downgrade).
  assert.deepEqual(rp.permissions, {});
  assert.deepEqual(rp.jobs['release-please'].permissions, {'contents': 'write', 'pull-requests': 'write'});
  const allRuns = Object.values(rp.jobs).flatMap(j => (j.steps ?? []).map(s => s.run ?? '')).join('\n');
  assert.equal(allRuns.includes('pr merge'), false, 'workflows must not merge the release PR directly');
});

test('argument and plan contracts are fail-closed', () => {
  assert.throws(() => parseReleasePublishArguments([]));
  assert.throws(() => parseReleasePublishArguments(['--artifacts', '/tmp/x']));
  assert.throws(() => parseReleasePublishArguments(['--candidate-source', 'relative', '--bundle', '/a', '--artifacts', '/b']));
  const expected = [{name: 'a.tgz', sha256: 'a'.repeat(64)}, {name: 'b.app.tar.gz', sha256: 'b'.repeat(64)}];
  const plan = planDesktopReleasePublication({version: '3.29.17', revision: 'c'.repeat(40), release: null, assets: [], expected});
  assert.deepEqual(plan, {releaseId: null, create: true, uploads: ['a.tgz', 'b.app.tar.gz'], publish: true});
  const draft = {id: 7, draft: true, prerelease: false, tag_name: 'v3.29.17', target_commitish: 'c'.repeat(40)};
  const partial = planDesktopReleasePublication({version: '3.29.17', revision: 'c'.repeat(40), release: draft,
    assets: [{name: 'a.tgz', state: 'uploaded', digest: `sha256:${'a'.repeat(64)}`}], expected});
  assert.deepEqual(partial, {releaseId: 7, create: false, uploads: ['b.app.tar.gz'], publish: true});
  assert.throws(() => planDesktopReleasePublication({version: '3.29.17', revision: 'c'.repeat(40), release: draft,
    assets: [{name: 'foreign', state: 'uploaded', digest: 'sha256:' + '9'.repeat(64)}], expected}), /unexpected existing asset/);
  assert.throws(() => planDesktopReleasePublication({version: '3.29.17', revision: 'd'.repeat(40), release: draft, assets: [], expected}), /target commit differs/);
});
