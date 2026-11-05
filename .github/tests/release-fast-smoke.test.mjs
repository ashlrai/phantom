import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFeed, checkLaunch, readUpdaterFeed, restorePreparedDist, selectRun, stockedFeedTag } from '../scripts/release-fast-smoke.mjs';

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
      : [job('Secret-shape scan', ['Scan candidate diff (fail closed)'], ['ubuntu-latest']), job('Quick typecheck', ['Core no-emit type check', 'Check authority drift (hermetic)'], ['ubuntu-latest']), job('Classify PR site lane', ['Bind candidate source'], ['ubuntu-latest']), job('Merge Gate', ['Require selected CI lane'], ['ubuntu-latest'])];
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

const FEED_ENDPOINT = `https://github.com/${repository}/releases/latest/download/latest.json`;
const feedResponse = (status, body) => ({ status, body: body === undefined ? null : (async function* () { yield Buffer.from(JSON.stringify(body)); })() });
const stockedRow = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false,
  created_at: '2026-11-01T00:00:00Z', assets: [{ name: 'latest.json', state: 'uploaded' }], ...extra });

test('only a stocked published release row can supply the feed contract', () => {
  assert.equal(stockedFeedTag([
    stockedRow('v9.9.9', { draft: true }),
    stockedRow('v9.9.8', { prerelease: true }),
    stockedRow('v9.9.7', { assets: [] }),
    stockedRow('v9.9.6', { assets: [{ name: 'latest.json', state: 'starter' }] }),
    stockedRow('v9.9.5', { assets: [{ name: 'latest.json', state: 'uploaded' }, { name: 'latest.json', state: 'uploaded' }] }),
    stockedRow('desktop-v9.9'),
    stockedRow('v9.9.4', { created_at: '2026-11-03T00:00:00Z' }),
    stockedRow('v9.9.3'),
  ]), 'v9.9.4');
  assert.equal(stockedFeedTag([]), null);
  assert.throws(() => stockedFeedTag({}), /invalid release inventory/);
  assert.throws(() => stockedFeedTag(Array.from({ length: 101 }, () => stockedRow('v9.9.9'))), /invalid release inventory/);
});

test('a serving live endpoint supplies the feed without any release lookup', async () => {
  const feed = { version: '3.30.7', platforms: { 'darwin-aarch64': { url: 'https://example.invalid/app', signature: 's' } } };
  const result = await readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository,
    read: () => assert.fail('release inventory fetched while live feed serves'),
    fetchImpl: async url => { assert.equal(url, FEED_ENDPOINT); return feedResponse(200, feed); } });
  assert.equal(result.served, 'latest');
  assert.deepEqual(result.feed, feed);
});

test('an assetless latest falls back to the newest stocked published feed', async () => {
  const releases = [
    stockedRow('v3.30.8', { assets: [], created_at: '2026-11-05T00:00:00Z' }),
    stockedRow('v3.30.7', { created_at: '2026-11-04T00:00:00Z' }),
    stockedRow('v3.30.6', { created_at: '2026-11-03T00:00:00Z' }),
  ];
  const feed = { version: '3.30.7' }; const fetched = [];
  const result = await readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository,
    read: path => { assert.equal(path, `repos/${repository}/releases?per_page=100&page=1`); return releases; },
    fetchImpl: async url => { fetched.push(url); return url === FEED_ENDPOINT ? feedResponse(404) : feedResponse(200, feed); } });
  assert.deepEqual(fetched, [FEED_ENDPOINT, `https://github.com/${repository}/releases/download/v3.30.7/latest.json`]);
  assert.equal(result.served, 'v3.30.7');
  assert.deepEqual(result.feed, feed);
});

test('the stocked-feed scan pages the release inventory until one is found', async () => {
  const first = Array.from({ length: 100 }, (_, index) => stockedRow('v3.30.8', { assets: [], created_at: `2026-11-05T00:${String(index).padStart(2, '0')}:00Z` }));
  const feed = { version: '3.30.7' };
  const result = await readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository,
    read: path => path.endsWith('page=1') ? first : [stockedRow('v3.30.7')],
    fetchImpl: async url => url === FEED_ENDPOINT ? feedResponse(404) : feedResponse(200, feed) });
  assert.equal(result.served, 'v3.30.7');
});

test('the feed check refuses an endpoint that cannot serve and has no stocked fallback', async () => {
  await assert.rejects(readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository,
    read: () => [stockedRow('v3.30.8', { assets: [] })],
    fetchImpl: async () => feedResponse(404) }), /no stocked updater feed release/);
  await assert.rejects(readUpdaterFeed({ endpoint: FEED_ENDPOINT, repository,
    read: () => [stockedRow('v3.30.7')],
    fetchImpl: async () => feedResponse(404) }), /stocked updater feed unavailable/);
  await assert.rejects(readUpdaterFeed({ endpoint: 'https://example.invalid/feed.json', repository,
    read: () => [], fetchImpl: async () => feedResponse(404) }));
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

function preparedArchiveFixture(t, prefix = 'dist') {
  const root = mkdtempSync(join(tmpdir(), 'release-dist-test-'));
  const prepared = mkdtempSync(join(tmpdir(), 'release-input-test-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(prepared, { recursive: true, force: true }); });
  const content = Buffer.from('original build bytes');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const entries = [{ path: prefix, type: 'directory', mode: 0o755 },
    { path: `${prefix}/worker.js`, type: 'file', mode: 0o755, bytes: content.length, sha256: hash(content) },
    { path: `${prefix}/inventory.json`, type: 'file', mode: 0o400, bytes: content.length, sha256: hash(content) }];
  const parts = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
    header.write(entry.path, 0); header.write(octal(entry.mode, 8), 100);
    header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
    header.write(octal(entry.bytes ?? 0, 12), 124); header.write(octal(0, 12), 136);
    header.fill(32, 148, 156); header[156] = entry.type === 'directory' ? 53 : 48;
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header);
    if (entry.type === 'file') parts.push(content, Buffer.alloc(512 - content.length));
  }
  const bytes = Buffer.concat([...parts, Buffer.alloc(1024)]);
  writeFileSync(join(prepared, 'dist.tar'), bytes);
  return { root, prepared, manifest: { archive: { bytes: bytes.length, sha256: hash(bytes), entries } }, bytes, content };
}

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
