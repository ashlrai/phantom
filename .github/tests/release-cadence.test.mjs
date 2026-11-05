/* global Buffer, URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { cadenceMinutes, nextPatch, planReleaseCadence } from '../scripts/release-cadence.mjs';
import { reconcileTaggedReleasePrs } from '../scripts/release-pr-labels.mjs';
import { normalizeReleaseNotes } from '../../scripts/sync-release-notes.mjs';

const revision = 'a'.repeat(40), tagged = 'b'.repeat(40);
const repo = { full_name: 'ashlrai/phantom', id: 1263526319, node_id: 'R_kgDOS0_hrw',
  owner: { id: 258113726, login: 'ashlrai' }, default_branch: 'master', private: false, visibility: 'public' };
const now = Date.parse('2026-11-05T04:00:00Z');
function fixture(overrides = {}) {
  const run = { id: 123, run_attempt: 1, path: '.github/workflows/ci.yml', head_sha: revision,
    repository: repo, head_branch: 'master', event: 'push', status: 'completed', conclusion: 'success' };
  const data = {
    '': repo, '/branches/master': { commit: { sha: revision } },
    [`/contents/package.json?ref=${revision}`]: { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: '3.30.1' })).toString('base64') },
    [`/contents/.release-please-manifest.json?ref=${revision}`]: { encoding: 'base64', content: Buffer.from('{".":"3.30.1"}').toString('base64') },
    '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: tagged } },
    [`/compare/${tagged}...${revision}`]: { status: 'ahead', ahead_by: 4 },
    [`/commits/${tagged}`]: { commit: { committer: { date: '2026-11-05T03:20:00Z' } } },
    [`/actions/workflows/ci.yml/runs?event=push&branch=master&head_sha=${revision}&per_page=100`]: { total_count: 1, workflow_runs: [run] },
    ...overrides,
  };
  const read = async path => {
    assert.ok(path.startsWith('repos/ashlrai/phantom'));
    const key = path.slice('repos/ashlrai/phantom'.length);
    assert.ok(Object.hasOwn(data, key), `unexpected read ${key}`);
    return data[key];
  };
  return { read, run, data, input: { repository: 'ashlrai/phantom', revision, now, read } };
}

test('default cadence produces next patch only for new green master work', async () => {
  const f = fixture();
  assert.equal(cadenceMinutes(), 30);
  assert.equal(nextPatch('3.30.0'), '3.30.1');
  assert.deepEqual(await planReleaseCadence(f.input), { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision, ciRunId: 123, ciRunAttempt: 1 });
  assert.deepEqual(await planReleaseCadence({ ...f.input, minutes: 60 }), { due: false, reason: 'cadence-not-due' });
});

test('no new commits, an untagged bump, and moved master never open another version PR', async () => {
  for (const [overrides, reason] of [
    [{ '/branches/master': { commit: { sha: tagged } } }, 'master-moved'],
    [{ '/git/ref/tags/v3.30.1': null }, 'current-version-awaits-tag'],
    [{ '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: revision } } }, 'no-new-commits'],
  ]) assert.deepEqual(await planReleaseCadence(fixture(overrides).input), { due: false, reason });
});

test('failed, running, absent, foreign and ambiguous CI evidence fails closed', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', null]) {
    const f = fixture(); f.run.conclusion = conclusion;
    assert.equal((await planReleaseCadence(f.input)).due, false);
  }
  const f = fixture(); f.run.status = 'in_progress';
  assert.equal((await planReleaseCadence(f.input)).due, false);
  f.run.status = 'completed'; f.run.head_sha = tagged;
  await assert.rejects(planReleaseCadence(f.input));
  const missing = fixture(); const key = Object.keys(missing.data).find(k => k.includes('/runs?'));
  missing.data[key] = { total_count: 0, workflow_runs: [] };
  assert.equal((await planReleaseCadence(missing.input)).due, false);
  missing.data[key] = { total_count: 101, workflow_runs: [] };
  await assert.rejects(planReleaseCadence(missing.input), /incomplete/);
});

test('a newer failed run cannot inherit an older success; tip rechecked before eligibility', async () => {
  const f = fixture(); const key = Object.keys(f.data).find(k => k.includes('/runs?'));
  f.data[key] = { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 124, conclusion: 'failure' }] };
  assert.equal((await planReleaseCadence(f.input)).due, false);
  const g = fixture(); let branches = 0;
  const read = path => path.endsWith('/branches/master') && ++branches > 1 ? { commit: { sha: tagged } } : g.read(path);
  assert.deepEqual(await planReleaseCadence({ ...g.input, read }), { due: false, reason: 'master-moved' });
});

test('invalid cadence, divergent tag and source/manifest drift refuse', async () => {
  for (const value of ['0', '-1', '30x', '1.5', '1441', ' 30', '4']) assert.throws(() => cadenceMinutes(value));
  for (const version of ['3.30', 'v3.30.1', '3.30.01', '3.30.1-beta']) assert.throws(() => nextPatch(version));
  const f = fixture(); f.data[`/compare/${tagged}...${revision}`].status = 'diverged';
  await assert.rejects(planReleaseCadence(f.input), /ancestor/);
  const g = fixture(); g.data[`/contents/.release-please-manifest.json?ref=${revision}`].content = Buffer.from('{".":"3.29.15"}').toString('base64');
  await assert.rejects(planReleaseCadence(g.input), /manifest differ/);
});

test('generated notes normalize below Unreleased without losing previous text', () => {
  const body = '### Fixes\n\n- A meaningful set of changes lands in the release with complete metadata.\n\n';
  const old = '## [3.30.0] — 2026-11-04\n\nOld notes preserved.\n';
  const source = `# Changelog\n\n## [3.30.1](https://github.com/ashlrai/phantom/compare/v3.30.0...v3.30.1) (2026-11-05)\n\n${body}## [Unreleased]\n\nFuture notes.\n\n${old}`;
  const normalized = normalizeReleaseNotes(source, '3.30.1');
  assert.ok(normalized.indexOf('## [Unreleased]') < normalized.indexOf('## [3.30.1]'));
  assert.ok(normalized.includes('## [3.30.1] — 2026-11-05'));
  assert.ok(normalized.includes('Future notes.'));
  assert.ok(normalized.endsWith(old));
  assert.equal(normalizeReleaseNotes(normalized, '3.30.1'), normalized);
  assert.throws(() => normalizeReleaseNotes(source + source, '3.30.1'), /one current/);
  assert.throws(() => normalizeReleaseNotes(source.replace(body, 'tiny\n'), '3.30.1'), /too short/);
});

test('timer cadence keeps the existing permissions and guarded merge route', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const workflow = parse(read('../workflows/release-please.yml'));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs['release-please'].permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.deepEqual(workflow.on.schedule, [{ cron: '17,47 * * * *' }]);
  assert.equal(workflow.on.workflow_run, undefined);
  const steps = workflow.jobs['release-please'].steps;
  assert.equal(steps.find(s => s.id === 'rp').if, "steps.cadence.outputs.due == 'true'");
  assert.match(steps.find(s => s.id === 'cadence').env.RELEASE_CADENCE_MINUTES, /vars.RELEASE_CADENCE_MINUTES/);
  const config = JSON.parse(read('../../release-please-config.json'));
  assert.equal(config.versioning, 'always-bump-patch');
  assert.equal(config['skip-changelog'], false);
  assert.ok(config['changelog-sections'].some(s => s.type === 'bridge' && !s.hidden));
  assert.ok(workflow.jobs['sync-and-refresh'].steps.some(s => s.run?.includes('sync-release-notes.mjs')));
  assert.equal(read('../workflows/release-please.yml').includes('pr merge'), false);
  const tag = parse(read('../workflows/auto-tag.yml'));
  assert.deepEqual(tag.jobs.tag.permissions, { contents: 'read', checks: 'read' });
  assert.deepEqual(tag.on.schedule, [{ cron: '22,52 * * * *' }]);
  assert.deepEqual(tag.on.workflow_run.workflows, ['CI']);
  assert.ok(tag.jobs.tag.if.includes("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'"), 'manual retry must not tag a feature branch');
});


test('external auto-tag clears only backed merged release PR pending labels', async () => {
  const calls = [];
  const content = { encoding: 'base64', content: Buffer.from('{"name":"@ashlr/phantom","version":"3.30.1"}').toString('base64') };
  const read = async path => {
    if (path === 'repos/ashlrai/phantom') return repo;
    if (path.includes('/issues?')) return [{ number: 7, pull_request: {} }, { number: 8 }];
    if (path.endsWith('/pulls/7')) return { merged_at: '2026-11-05', merge_commit_sha: revision, head: { ref: 'release-please--master', repo }, base: { ref: 'master', repo } };
    if (path.includes('/contents/package.json')) return content;
    if (path.includes('/git/ref/tags/')) return { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: revision } };
    assert.fail(`unexpected read ${path}`);
  };
  const write = async (...args) => calls.push(args);
  assert.deepEqual(await reconcileTaggedReleasePrs({ repository: repo.full_name, read, write }), { reconciled: 1 });
  assert.deepEqual(calls, [
    ['POST', 'repos/ashlrai/phantom/issues/7/labels', { labels: ['autorelease: tagged'] }],
    ['DELETE', 'repos/ashlrai/phantom/issues/7/labels/autorelease%3A%20pending'],
  ]);
  calls.length = 0;
  await reconcileTaggedReleasePrs({ repository: repo.full_name, write,
    read: async path => path.includes('/git/ref/tags/') ? null : read(path) });
  assert.equal(calls.length, 0, 'missing tag must preserve pending label');
  await assert.rejects(reconcileTaggedReleasePrs({ repository: repo.full_name, write,
    read: async path => path.endsWith('/pulls/7') ? { ...(await read(path)), base: { ref: 'other', repo } } : read(path) }));
  assert.equal(calls.length, 0, 'foreign base must refuse before writes');
});
