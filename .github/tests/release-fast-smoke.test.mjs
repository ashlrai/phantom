/* global structuredClone */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { preparedArchiveFixture } from './fixtures/release-prepared.mjs';
import { acceptReleaseRef, checkFeed, checkLaunch, readUpdaterFeed, restorePreparedDist, selectRun, stockedFeedTag } from '../scripts/release-fast-smoke.mjs';

const repository = 'ashlrai/phantom', revision = 'a'.repeat(40);
const repo = { full_name: repository, id: 1263526319, node_id: 'R_kgDOS0_hrw', owner: { id: 258113726, login: 'ashlrai' }, default_branch: 'master', private: false, visibility: 'public' };
function setup(kind = 'build') {
  const workflow = 'ci.yml';
  const run = { id: 30, run_attempt: 2, head_sha: revision, head_branch: 'master', path: `.github/workflows/${workflow}`, event: kind === 'push' ? 'push' : 'schedule', status: 'completed', conclusion: 'success', repository: repo };
  const list = { total_count: 1, workflow_runs: [run] };
  const artifact = { id: 100, name: kind === 'build' ? 'phantom-release-input-30-2' : 'ashlr-build-30-2', expired: false, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 30, head_sha: revision } };
  const inventory = { total_count: 1, artifacts: [artifact] };
  const step = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  const job = (name, steps, labels = ['macos-15']) => ({ id: 200, run_id: 30, head_sha: revision, name, labels, status: 'completed', conclusion: 'success', steps: steps.map(name => step(name)) });
  const jobs = kind === 'build' ? [job('Prepare unsigned desktop release', ['Reuse successful push CI and existing prepared artifact', 'Upload immutable release input', 'Build unsigned desktop and original package once'])]
    : kind === 'attest' ? [job('Desktop release smoke', ['Verify green master push CI', 'Smoke desktop release artifact', 'Upload qualified build handoff'])]
      : [job('Secret-shape scan', ['Scan candidate diff (fail closed)'], ['ubuntu-latest']), job('Secret scan (diff)', ['Scan the commits this event adds'], ['ubuntu-latest']), job('Quick typecheck', ['Core no-emit type check', 'Check authority drift (hermetic)'], ['ubuntu-latest']), job('Classify PR site lane', ['Bind candidate source'], ['ubuntu-latest']), job('Merge Gate', ['Require selected CI lane'], ['ubuntu-latest'])];
  if (kind === 'build') jobs[0].steps.push(step('Download existing immutable build', 'skipped'));
  const jobResponse = { total_count: jobs.length, jobs };
  let freshRun = run;
  const overrides = new Map();
  const read = path => {
    if (overrides.has(path)) return overrides.get(path);
    if (path === `repos/${repository}`) return repo;
    if (path.includes('/actions/workflows/')) return list;
    if (path.endsWith('/artifacts?per_page=100')) return inventory;
    if (path.includes('/runs/31/attempts/2/jobs?')) return { total_count: jobs.length, jobs: jobs.map(job => ({ ...job, run_id: 31 })) };
    if (path.includes('/jobs?')) return jobResponse;
    if (path.includes('/runs/30/attempts/2')) return freshRun;
    if (path.includes('/runs/31/attempts/2')) return list.workflow_runs.find(row => row.id === 31);
    assert.fail(`unexpected read: ${path}`);
  };
  const select = (extra = {}) => selectRun({ kind, repository, revision, read, excludeRunId: undefined, ...extra });
  return { run, list, artifact, inventory, jobs, jobResponse, overrides, select, replaceRun: value => { freshRun = value; } };
}

for (const kind of ['push', 'build', 'attest']) test(`selects exact-source successful ${kind} evidence`, () => {
  const f = setup(kind); assert.deepEqual(f.select(), { run: 30, attempt: 2, sha: revision, ...(kind === 'push' ? {} : { artifact: 100 }) });
});

test('combined canonical smoke job reuses the same immutable input without a second prepare role', () => {
  const f = setup(); f.jobs[0].name = 'Desktop release smoke';
  assert.equal(f.select().artifact, 100);
});

test('legacy two-job producer still selects only its original preparation role', () => {
  const f = setup(); f.jobs.push({ ...f.jobs[0], id: 201, name: 'Desktop release smoke' }); f.jobResponse.total_count++;
  assert.equal(f.select().artifact, 100);
});

test('reuses the immutable build only when its download step passed and compilation was skipped', () => {
  const f = setup(); f.jobs[0].steps[2].conclusion = 'skipped'; f.jobs[0].steps[3].conclusion = 'success'; assert.equal(f.select().artifact, 100);
});

test('excludes the currently executing build when looking for reusable input', () => {
  const f = setup(); f.list.workflow_runs.push({ ...f.run, id: 31, status: 'in_progress', conclusion: null }); f.list.total_count++;
  assert.equal(f.select({ excludeRunId: '31' }).run, 30);
  assert.equal(f.select(), null);
});

for (const state of [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }]) {
  test(`latest ${state.status}/${state.conclusion} run cannot be masked by older green evidence`, () => {
    const f = setup(); f.list.workflow_runs.push({ ...f.run, id: 31, ...state }); f.list.total_count++;
    assert.equal(f.select(), null);
  });
}

test('an eligible no-op run without the expected artifact remains unready', () => {
  const f = setup(); f.inventory.artifacts = []; f.inventory.total_count = 0; f.jobs[0].steps[1].conclusion = 'skipped'; assert.equal(f.select(), null);
});

test('a fresh API conclusion change remains unready', () => {
  const f = setup(); f.replaceRun({ ...f.run, conclusion: 'failure' }); assert.equal(f.select(), null);
});

for (const mutation of ['truncated runs', 'duplicate runs', 'bad repository', 'changed sha', 'changed attempt', 'truncated artifacts', 'duplicate artifact', 'wrong artifact sha', 'wrong artifact run', 'bad digest', 'expired artifact', 'self-hosted', 'skipped required step', 'missing required step', 'both paths ran', 'neither path ran', 'duplicate job', 'truncated jobs']) {
  test(`refuses ${mutation} before executing prepared bytes`, () => {
    const f = setup();
    if (mutation === 'truncated runs') f.list.total_count++;
    if (mutation === 'duplicate runs') { f.list.workflow_runs.push({ ...f.run }); f.list.total_count++; }
    if (mutation === 'bad repository') f.run.repository = { ...repo, id: 1 };
    if (mutation === 'changed sha') f.replaceRun({ ...f.run, head_sha: 'c'.repeat(40) });
    if (mutation === 'changed attempt') f.replaceRun({ ...f.run, run_attempt: 3 });
    if (mutation === 'truncated artifacts') f.inventory.total_count++;
    if (mutation === 'duplicate artifact') { f.inventory.artifacts.push({ ...f.artifact, id: 101 }); f.inventory.total_count++; }
    if (mutation === 'wrong artifact sha') f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (mutation === 'wrong artifact run') f.artifact.workflow_run.id++;
    if (mutation === 'bad digest') f.artifact.digest = 'sha256:no';
    if (mutation === 'expired artifact') f.artifact.expired = true;
    if (mutation === 'self-hosted') f.jobs[0].labels.push('self-hosted');
    if (mutation === 'skipped required step') f.jobs[0].steps[0].conclusion = 'skipped';
    if (mutation === 'missing required step') f.jobs[0].steps.shift();
    if (mutation === 'both paths ran') f.jobs[0].steps[3].conclusion = 'success';
    if (mutation === 'neither path ran') f.jobs[0].steps[2].conclusion = 'skipped';
    if (mutation === 'duplicate job') { f.jobs.push({ ...f.jobs[0] }); f.jobResponse.total_count++; }
    if (mutation === 'truncated jobs') f.jobResponse.total_count++;
    assert.throws(f.select);
  });
}

test('native launch must report exact compiled version and revision', () => {
  const output = JSON.stringify({ schemaVersion: 1, version: '3.30.1', revision, state: 'pass' });
  checkLaunch(output, '3.30.1', revision);
  assert.throws(() => checkLaunch(output, '3.30.2', revision));
  assert.throws(() => checkLaunch(output, '3.30.1', 'c'.repeat(40)));
  assert.throws(() => checkLaunch('{}', '3.30.1', revision));
});

test('feed parser uses the manifest trust parser and requires matching app discovery fields', () => {
  const feed = { version: '3.30.0', platforms: { 'darwin-aarch64': { url: 'https://example.invalid/app', signature: 'fixture-signature' } }, phantom: { manifestText: 'manifest' } };
  const manifest = { version: feed.version, app: { ...feed.platforms['darwin-aarch64'] } };
  const trust = {}; const parse = (text, actual) => { assert.equal(text, 'manifest'); assert.equal(actual, trust); return manifest; };
  assert.equal(checkFeed(feed, parse, trust), manifest);
  assert.throws(() => checkFeed({ ...feed, version: '3.30.1' }, parse, trust));
  assert.throws(() => checkFeed(feed, () => { throw new Error('invalid manifest'); }, trust));
});

for (const kind of ['build', 'attest']) {
  for (const state of ['missing', 'skipped', 'no-op']) test(`${kind} ignores newer ${state} full/nightly run without hiding an attempted release`, () => {
    const f = setup(kind);
    f.list.workflow_runs.push({ ...f.run, id: 31 }); f.list.total_count++;
    const job = { ...f.jobs[0], run_id: 31, steps: f.jobs[0].steps.map(row => ({ ...row })) };
    if (state === 'skipped') job.conclusion = 'skipped';
    if (state === 'no-op') job.steps.find(row => row.name.startsWith('Upload ')).conclusion = 'skipped';
    const jobs = state === 'missing' ? [{ ...job, name: 'Mac exhaustive (isolated)' }] : [job];
    f.overrides.set(`repos/${repository}/actions/runs/31/attempts/2/jobs?per_page=100&page=1`, { total_count: jobs.length, jobs });
    f.overrides.set(`repos/${repository}/actions/runs/31/artifacts?per_page=100`, { total_count: 0, artifacts: [] });
    assert.equal(f.select().run, 30);
  });
}

test('a successful upload with no artifact cannot silently fall back', () => {
  const f = setup(); f.inventory.artifacts = []; f.inventory.total_count = 0;
  assert.throws(f.select, /successful release upload missing artifact/);
});

test('prepared tar preserves executable and readonly modes across artifact ZIP transport', t => {
  const f = preparedArchiveFixture(t); restorePreparedDist(f);
  assert.equal(lstatSync(join(f.root, 'dist/worker.js')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(f.root, 'dist/inventory.json')).mode & 0o777, 0o400);
  assert.deepEqual(readFileSync(join(f.root, 'dist/worker.js')), f.content);
});

test('prepared archive corruption is refused before creating executable output', t => {
  const f = preparedArchiveFixture(t); f.bytes[1024] ^= 1;
  writeFileSync(join(f.prepared, 'dist.tar'), f.bytes);
  assert.throws(() => restorePreparedDist(f), /digest differs/);
  assert.equal(existsSync(join(f.root, 'dist')), false);
});

test('canonical archive members still cannot escape the dist subtree', t => {
  const f = preparedArchiveFixture(t, 'outside');
  assert.throws(() => restorePreparedDist(f), /escapes dist/);
  assert.equal(existsSync(join(f.root, 'outside')), false);
});

test('prepared restoration never overwrites an existing dist tree', t => {
  const f = preparedArchiveFixture(t); mkdirSync(join(f.root, 'dist'));
  writeFileSync(join(f.root, 'dist/keep'), 'keep');
  assert.throws(() => restorePreparedDist(f), /dist already exists/);
  assert.equal(readFileSync(join(f.root, 'dist/keep'), 'utf8'), 'keep');
});

const FEED_ENDPOINT = `https://github.com/${repository}/releases/latest/download/latest.json`;
const feedResponse = (status, body) => ({ status, body: body === undefined ? null :
  (async function* () { yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); })() });
function stockedRow(id, extra = {}) {
  const tag = `v3.30.${id}`, bytes = Buffer.from(JSON.stringify({version: `3.30.${id}`}));
  return { id, tag_name: tag, draft: false, prerelease: false,
    url: `https://api.github.com/repos/${repository}/releases/${id}`,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets_url: `https://api.github.com/repos/${repository}/releases/${id}/assets`,
    created_at: `2026-11-0${id}T00:00:00Z`, published_at: `2026-11-0${id}T01:00:00Z`,
    assets: [{ id: id * 10, name: 'latest.json', state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      url: `https://api.github.com/repos/${repository}/releases/assets/${id * 10}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/latest.json` }], ...extra };
}
function feedFixture() {
  const latest = stockedRow(8, { assets: [] }), stocked = stockedRow(7);
  const f = { latest, stocked, inventory: [latest, stocked], fetched: [], reads: [], liveStatus: 404,
    feed: { version: '3.30.7' }, overrides: new Map() };
  f.bindFeed = () => {
    const bytes = Buffer.from(JSON.stringify(f.feed));
    Object.assign(f.stocked.assets[0], {size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`});
  };
  f.read = path => {
    f.reads.push(path);
    if (f.overrides.has(path)) { const value = f.overrides.get(path); return typeof value === 'function' ? value() : value; }
    if (path === `repos/${repository}`) return repo;
    if (path === `repos/${repository}/releases/latest`) return structuredClone(f.latest);
    if (path === `repos/${repository}/releases?per_page=100&page=1`) return structuredClone(f.inventory);
    for (const row of [f.latest, f.stocked]) {
      if (path === `repos/${repository}/releases/${row.id}`) return structuredClone(row);
      if (path === `repos/${repository}/releases/${row.id}/assets?per_page=100&page=1`) return structuredClone(row.assets);
    }
    assert.fail(`unexpected API read: ${path}`);
  };
  f.fetchImpl = async url => {
    f.fetched.push(url);
    if (url === FEED_ENDPOINT) return { ...feedResponse(f.liveStatus), url: `https://github.com/${repository}/releases/download/${f.latest.tag_name}/latest.json` };
    assert.equal(url, `https://github.com/${repository}/releases/download/v3.30.7/latest.json`);
    return feedResponse(200, f.feed);
  };
  f.run = () => readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository, read: f.read, fetchImpl: f.fetchImpl });
  return f;
}

test('a serving live endpoint needs no fallback metadata and records live HTTP success', async () => {
  const f = feedFixture(); f.fetchImpl = async () => feedResponse(200, f.feed);
  f.read = () => assert.fail('metadata read for healthy live feed');
  const result = await f.run();
  assert.equal(result.served, 'latest'); assert.equal(result.liveStatus, 200); assert.deepEqual(result.feed, f.feed);
});

test('only a verified unchanged zero-asset latest 404 admits a stocked contract, never live recovery', async () => {
  const f = feedFixture(); const result = await f.run();
  assert.deepEqual(result, { feed: f.feed, served: 'v3.30.7', liveStatus: 404, latestRelease: { id: 8, tag: 'v3.30.8' } });
  assert.equal(f.fetched.filter(url => url === FEED_ENDPOINT).length, 2);
  assert.equal(f.reads.filter(path => path.endsWith('/releases/latest')).length, 2);
  assert.equal(f.reads.filter(path => path.endsWith('/releases/8/assets?per_page=100&page=1')).length, 2);
});

for (const status of [201, 204, 301, 302, 400, 401, 403, 410, 429, 500, 502, 503]) {
  test(`live HTTP ${status} never falls back to an older feed`, async () => {
    const f = feedFixture(); f.liveStatus = status;
    await assert.rejects(f.run, /updater feed unavailable/);
    assert.equal(f.fetched.length, 1); assert.equal(f.reads.length, 0);
  });
}

test('network errors, malformed and oversized live feeds fail without any fallback', async () => {
  for (const body of ['{', ' '.repeat(128 * 1024 + 1), null]) {
    const f = feedFixture(); f.fetchImpl = async () => feedResponse(200, body);
    f.read = () => assert.fail('failure must not trigger a fallback');
    if (body === null) { const result = await f.run(); assert.throws(() => checkFeed(result.feed, () => {}, {})); }
    else await assert.rejects(f.run);
  }
  const f = feedFixture(); f.fetchImpl = async () => { throw new Error('network refused'); };
  await assert.rejects(f.run, /network refused/); assert.equal(f.reads.length, 0);
});

for (const mutation of ['draft', 'prerelease', 'missing flag', 'missing assets', 'null asset', 'feed uploaded', 'feed starter',
  'other asset', 'wrong id', 'wrong URL', 'wrong assets URL', 'wrong tag URL', 'bad tag', 'bad timestamp', 'unpublished', 'array']) {
  test(`latest ${mutation} cannot excuse an unavailable feed`, async () => {
    const f = feedFixture();
    if (mutation === 'draft') f.latest.draft = true;
    if (mutation === 'prerelease') f.latest.prerelease = true;
    if (mutation === 'missing flag') delete f.latest.draft;
    if (mutation === 'missing assets') delete f.latest.assets;
    if (mutation === 'null asset') f.latest.assets = [null];
    if (mutation.startsWith('feed')) f.latest.assets = [{ ...f.stocked.assets[0], state: mutation === 'feed starter' ? 'starter' : 'uploaded' }];
    if (mutation === 'other asset') f.latest.assets = [{ ...f.stocked.assets[0], name: 'partial-app.zip' }];
    if (mutation === 'wrong id') f.latest.id = 0;
    if (mutation === 'wrong URL') f.latest.url = 'https://api.github.com/repos/other/repo/releases/8';
    if (mutation === 'wrong assets URL') f.latest.assets_url += '/wrong';
    if (mutation === 'wrong tag URL') f.latest.html_url += '/wrong';
    if (mutation === 'bad tag') f.latest.tag_name = 'v3.30.8/redirect';
    if (mutation === 'bad timestamp') f.latest.created_at = 'yesterday';
    if (mutation === 'unpublished') f.latest.published_at = null;
    if (mutation === 'array') f.latest = [];
    await assert.rejects(f.run);
    assert.ok(f.fetched.every(url => url === FEED_ENDPOINT));
  });
}

for (const mutation of ['repository identity', 'metadata unavailable', 'asset API unavailable', 'asset inventory disagrees', 'asset inventory malformed']) {
  test(`${mutation} cannot prove an assetless latest release`, async () => {
    const f = feedFixture();
    if (mutation === 'repository identity') f.overrides.set(`repos/${repository}`, { ...repo, id: 1 });
    if (mutation === 'metadata unavailable') f.overrides.set(`repos/${repository}/releases/latest`, () => { throw new Error('metadata HTTP 403'); });
    if (mutation === 'asset API unavailable') f.overrides.set(`repos/${repository}/releases/8/assets?per_page=100&page=1`, () => { throw new Error('asset HTTP 500'); });
    if (mutation === 'asset inventory disagrees') f.overrides.set(`repos/${repository}/releases/8/assets?per_page=100&page=1`, f.stocked.assets);
    if (mutation === 'asset inventory malformed') f.overrides.set(`repos/${repository}/releases/8/assets?per_page=100&page=1`, {});
    await assert.rejects(f.run); assert.equal(f.fetched.length, 1);
  });
}

for (const mutation of ['new latest', 'feed appeared', 'unpublished latest', 'live recovered', 'live server failure', 'stocked asset replaced']) {
  test(`${mutation} during fallback selection refuses the metadata/pointer race`, async () => {
    const f = feedFixture(); const fetch = f.fetchImpl;
    f.fetchImpl = async url => {
      const result = await fetch(url);
      if (url !== FEED_ENDPOINT) {
        if (mutation === 'new latest') f.latest = stockedRow(9, { assets: [] });
        if (mutation === 'feed appeared') f.latest.assets = f.stocked.assets;
        if (mutation === 'unpublished latest') f.latest.draft = true;
        if (mutation === 'live recovered') f.liveStatus = 200;
        if (mutation === 'live server failure') f.liveStatus = 503;
        if (mutation === 'stocked asset replaced') f.stocked.assets[0].id++;
      }
      return result;
    };
    await assert.rejects(f.run);
  });
}

for (const mutation of ['duplicate release', 'null release', 'missing latest', 'changed latest', 'newer stocked', 'incomplete page',
  'bad asset state', 'duplicate feed', 'wrong asset URL', 'wrong download URL', 'changed stocked metadata', 'changed asset inventory']) {
  test(`${mutation} cannot select fallback evidence`, async () => {
    const f = feedFixture();
    if (mutation === 'duplicate release') f.inventory.push(structuredClone(f.stocked));
    if (mutation === 'null release') f.inventory.push(null);
    if (mutation === 'missing latest') f.inventory = [f.stocked];
    if (mutation === 'changed latest') f.inventory = [{ ...f.latest, published_at: '2026-11-08T02:00:00Z' }, f.stocked];
    if (mutation === 'newer stocked') f.stocked.created_at = '2026-11-09T00:00:00Z';
    if (mutation === 'incomplete page') f.inventory = Array.from({ length: 100 }, () => structuredClone(f.stocked));
    if (mutation === 'bad asset state') f.stocked.assets[0].state = 'starter';
    if (mutation === 'duplicate feed') f.stocked.assets.push({ ...f.stocked.assets[0], id: 71 });
    if (mutation === 'wrong asset URL') f.stocked.assets[0].url += '/wrong';
    if (mutation === 'wrong download URL') f.stocked.assets[0].browser_download_url = 'https://example.invalid/latest.json';
    if (mutation === 'changed stocked metadata') f.overrides.set(`repos/${repository}/releases/7`, { ...f.stocked, draft: true });
    if (mutation === 'changed asset inventory') f.overrides.set(`repos/${repository}/releases/7/assets?per_page=100&page=1`, []);
    await assert.rejects(f.run);
  });
}

test('fallback feed errors, oversized bytes, malformed JSON and version drift are not rescued', async () => {
  for (const body of ['{', ' '.repeat(128 * 1024 + 1), { version: '3.30.6' }]) {
    const f = feedFixture(); f.feed = body; await assert.rejects(f.run);
  }
  const f = feedFixture(); const fetch = f.fetchImpl; f.fetchImpl = async url => url === FEED_ENDPOINT ? fetch(url) : feedResponse(404);
  await assert.rejects(f.run, /stocked updater feed unavailable/);
});

test('a tag ref is accepted only when its peeled commit is this sha and an ancestor of master', () => {
  const sha = 'a'.repeat(40);
  const annotation = 'b'.repeat(40);
  const read = (path) => {
    if (path.endsWith('/git/ref/tags/v3.30.28')) return { ref: 'refs/tags/v3.30.28', object: { type: 'commit', sha } };
    if (path.endsWith('/compare/' + sha + '...master')) return { status: 'ahead' };
    throw new Error(path);
  };
  acceptReleaseRef({ ref: 'refs/heads/master', sha, repository, read: () => { throw new Error('master does not compare'); } });
  acceptReleaseRef({ ref: 'refs/tags/v3.30.28', sha, repository, read });
  const annotated = (path) => {
    if (path.endsWith('/git/ref/tags/v3.30.28')) return { ref: 'refs/tags/v3.30.28', object: { type: 'tag', sha: annotation } };
    if (path.endsWith('/git/tags/' + annotation)) return { sha: annotation, object: { type: 'commit', sha } };
    if (path.endsWith('/compare/' + sha + '...master')) return { status: 'ahead' };
    throw new Error(path);
  };
  acceptReleaseRef({ ref: 'refs/tags/v3.30.28', sha, repository, read: annotated });
  assert.throws(() => acceptReleaseRef({ ref: 'refs/tags/v3.30.28', sha, repository, read: (path) => path.includes('/git/ref/') ? { ref: 'refs/tags/v3.30.28', object: { type: 'commit', sha: annotation } } : { status: 'ahead' } }), /tag sha mismatches/);
  assert.throws(() => acceptReleaseRef({ ref: 'refs/tags/v3.30.28', sha, repository, read: (path) => path.includes('/git/ref/') ? { ref: 'refs/tags/v3.30.28', object: { type: 'commit', sha } } : { status: 'diverged' } }), /ancestor/);
  assert.throws(() => acceptReleaseRef({ ref: 'refs/tags/nightly', sha, repository, read }), /stable tag/);
  assert.throws(() => acceptReleaseRef({ ref: 'refs/heads/v3.30.28', sha, repository, read }), /stable tag/);
});

test('stocked feed selection uses the highest semver, not list order or a newer timestamp on an older release', () => {
  const row = (id, version, created) => {
    const tag = `v${version}`;
    const bytes = Buffer.from(JSON.stringify({ version }));
    return {
      id, tag_name: tag, draft: false, prerelease: false,
      url: `https://api.github.com/repos/${repository}/releases/${id}`,
      html_url: `https://github.com/${repository}/releases/tag/${tag}`,
      assets_url: `https://api.github.com/repos/${repository}/releases/${id}/assets`,
      created_at: created, published_at: created,
      assets: [{ id: id * 10, name: 'latest.json', state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        url: `https://api.github.com/repos/${repository}/releases/assets/${id * 10}`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/latest.json` }],
    };
  };
  const entries = [
    row(1, '3.29.3', '2026-11-09T00:00:00Z'),
    row(2, '3.30.24', '2026-11-01T00:00:00Z'),
    row(3, '3.30.28', '2026-11-02T00:00:00Z'),
  ];
  assert.equal(stockedFeedTag(entries), 'v3.30.28');
  assert.equal(stockedFeedTag([...entries].reverse()), 'v3.30.28');
});

test('empty inventories, absent stocked feeds and changed endpoints fail closed', async () => {
  const f = feedFixture(); f.inventory = [f.latest]; await assert.rejects(f.run, /no stocked updater feed release/);
  assert.equal(stockedFeedTag([]), null);
  assert.throws(() => stockedFeedTag({}), /invalid release inventory/);
  assert.throws(() => stockedFeedTag([stockedRow(7), stockedRow(7)]));
  await assert.rejects(readUpdaterFeed({ endpoint: 'https://example.invalid/latest.json', repository,
    read: () => assert.fail('unexpected metadata read'), fetchImpl: () => assert.fail('unexpected fetch') }));
  await assert.rejects(readUpdaterFeed({ endpoint: 'https://github.com/other/repo/releases/latest/download/latest.json', repository: 'other/repo',
    read: () => assert.fail('unexpected metadata read'), fetchImpl: () => assert.fail('unexpected fetch') }));
});

test('fallback still passes the envelope and trust unchanged to the parser and propagates rejection', async () => {
  const f = feedFixture();
  f.feed = { version: '3.30.7', platforms: { 'darwin-aarch64': { url: 'https://example.invalid/app', signature: 'bad' } }, phantom: { manifestText: 'signed' } };
  f.bindFeed(); const result = await f.run(); const trust = {};
  assert.throws(() => checkFeed(result.feed, (text, actual) => {
    assert.equal(text, 'signed'); assert.equal(actual, trust); throw new Error('invalid signature');
  }, trust), /invalid signature/);
});

for (const url of [FEED_ENDPOINT, 'https://example.invalid/404', `https://github.com/${repository}/releases/download/v3.30.6/latest.json`, undefined]) {
  test(`missing-asset response must identify the observed latest tag (${url ?? 'unknown URL'})`, async () => {
    const f = feedFixture(); f.fetchImpl = async () => ({ ...feedResponse(404), url });
    await assert.rejects(f.run, /missing feed redirect differs/);
  });
}

test('complete pagination selects the newest stocked feed across pages, not just the first match', async () => {
  const f = feedFixture();
  const old = Array.from({ length: 99 }, (_, index) => {
    const id = index + 100, tag = `v1.0.${id}`;
    return { ...stockedRow(6, { assets: [] }), id, tag_name: tag,
      url: `https://api.github.com/repos/${repository}/releases/${id}`,
      html_url: `https://github.com/${repository}/releases/tag/${tag}`,
      assets_url: `https://api.github.com/repos/${repository}/releases/${id}/assets` };
  });
  f.inventory = [f.latest, ...old]; f.overrides.set(`repos/${repository}/releases?per_page=100&page=2`, [f.stocked]);
  assert.equal((await f.run()).served, 'v3.30.7');
  assert.ok(f.reads.includes(`repos/${repository}/releases?per_page=100&page=2`));
});

test('ten full inventory pages remain incomplete and cannot admit fallback', async () => {
  const f = feedFixture();
  for (let page = 1; page <= 10; page++) f.overrides.set(`repos/${repository}/releases?per_page=100&page=${page}`, Array(100).fill(f.latest));
  await assert.rejects(f.run, /incomplete release inventory/);
  assert.equal(f.reads.filter(path => path.includes('/releases?')).length, 10);
});

test('a full asset page is ambiguous even when no feed is visible', async () => {
  const f = feedFixture(); f.overrides.set(`repos/${repository}/releases/8/assets?per_page=100&page=1`, Array(100).fill(f.stocked.assets[0]));
  await assert.rejects(f.run, /incomplete release asset inventory/);
});

test('workflow evidence labels fallback as unavailable without expanding admission receipt authority', () => {
  const source = readFileSync(new URL('../scripts/release-fast-smoke.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('updater_live_http_status=${liveStatus}'));
  assert.ok(source.includes('updater_contract_source=${served}'));
  assert.ok(source.includes('live endpoint remains unavailable (HTTP 404)'));
  assert.ok(source.includes('this is not updater recovery'));
  assert.ok(source.includes("getDesktopUpdateTrustForProfile('canonical-v2')"));
  assert.ok(source.includes('smoke: { exitCode: 0, feedParsed: true, manifestParsed: true, versionVerified: true }'));
});


test('legitimate untagged draft URLs do not block a complete published fallback', async () => {
  const f = feedFixture();
  f.inventory.push(stockedRow(9, {draft: true, published_at: null, html_url: `https://github.com/${repository}/releases/tag/untagged-fixture`, assets: []}));
  assert.equal((await f.run()).served, 'v3.30.7');
});

test('historical feed rejects a size mismatch even when its digest matches', async () => {
  const f = feedFixture(); f.stocked.assets[0].size = 1;
  await assert.rejects(f.run, /stocked feed bytes differ from asset/);
});

for (const change of [{size: 128 * 1024 + 1}, {digest: null}, {digest: `sha256:${'f'.repeat(64)}`}]) {
  test('historical feed bytes require bounded exact asset size and digest', async () => {
    const f = feedFixture(); Object.assign(f.stocked.assets[0], change);
    await assert.rejects(f.run, /invalid stocked feed asset|stocked feed bytes differ from asset/);
  });
}

test('version equality remains required even with matching declared feed bytes', async () => {
  const f = feedFixture(); f.feed = {version: '3.30.6'}; f.bindFeed();
  await assert.rejects(f.run, /stocked feed version differs/);
});
