/* global AbortController, Buffer, DOMException, URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { cadenceMinutes, nextPatch, planReleaseCadence, createPublicMetadataReader } from '../scripts/release-cadence.mjs';
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

function metadataReaderFixture(responses) {
  let clock = 0;
  const calls = [], waits = [], reports = [];
  const read = createPublicMetadataReader({
    now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    report: message => reports.push(message),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      assert.ok(response, 'unexpected metadata request');
      if (response.error) throw response.error;
      clock += response.elapsed ?? 0;
      return { status: response.status, text: async () => {
        clock += response.bodyElapsed ?? 0;
        return response.text ?? JSON.stringify(response.data ?? {});
      } };
    },
  });
  return { read, calls, waits, reports };
}

test('anonymous GET retries gateway failures within one bounded read budget', async () => {
  const f = metadataReaderFixture([{ status: 503 }, { status: 504 }, { status: 200, data: repo }]);
  assert.deepEqual(await f.read('repos/ashlrai/phantom'), repo);
  assert.deepEqual(f.waits, [250, 500]);
  assert.deepEqual(f.reports, ['release metadata transient read failure: 503 at repos/ashlrai/phantom']);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(call.url, 'https://api.github.com/repos/ashlrai/phantom');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(call.options.headers, { Accept: 'application/vnd.github+json' });
    assert.equal(call.options.signal.aborted, false);
  }
});

test('persistent transient failure stops after three reads and retains the original failure', async () => {
  const f = metadataReaderFixture([{ status: 504 }, { status: 502 }, { status: 503 }]);
  await assert.rejects(f.read('repos/ashlrai/phantom'), /503.*after 3 read attempts; first transient 504/);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.waits, [250, 500]);
  assert.equal(f.reports.length, 1);
  assert.match(f.reports[0], /504/);
});

test('fetch and body timeouts retry within the shared budget without masking other errors', async () => {
  for (const body of [false, true]) {
    let calls = 0, clock = 0;
    const budgets = [], reports = [];
    const read = createPublicMetadataReader({ now: () => clock, sleep: async ms => { clock += ms; },
      report: message => reports.push(message), timeoutSignal: ms => {
        budgets.push(ms);
        const controller = new AbortController();
        if (calls === 0) controller.abort(new DOMException('timed out', 'TimeoutError'));
        return controller.signal;
      }, fetchImpl: async (_url, { signal }) => {
        calls++;
        if (calls === 1) {
          clock += 5_000;
          if (!body) throw signal.reason;
          return { status: 200, text: async () => { throw new DOMException('aborted', 'AbortError'); } };
        }
        return { status: 200, text: async () => JSON.stringify(repo) };
      } });
    assert.deepEqual(await read('repos/ashlrai/phantom'), repo);
    assert.equal(calls, 2);
    assert.deepEqual(budgets, [5_000, 5_000]);
    assert.match(reports[0], /timeout at repos\/ashlrai\/phantom/);
  }
});

test('the fixed thirty-second deadline is shared across endpoints, backoff and body reads', async () => {
  const f = metadataReaderFixture([{ status: 200, elapsed: 14_900 }, { status: 504, elapsed: 14_900 }]);
  await f.read('repos/ashlrai/phantom');
  await assert.rejects(f.read('repos/ashlrai/phantom/branches/master'), /deadline exhausted; first transient 504/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.waits, []);
  const lateBody = metadataReaderFixture([{ status: 200, elapsed: 14_999, bodyElapsed: 15_001 }]);
  await assert.rejects(lateBody.read('repos/ashlrai/phantom'), /deadline exhausted/);
  await assert.rejects(lateBody.read('repos/ashlrai/phantom'), /deadline exhausted/);
  assert.equal(lateBody.calls.length, 1);
});

test('malformed, oversized, permission and transport failures never become retryable', async () => {
  for (const response of [
    { status: 200, text: '{' },
    { status: 200, text: ' '.repeat(4 * 1024 * 1024 + 1) },
    ...[400, 401, 403, 404, 429, 500].map(status => ({ status })),
    { error: new TypeError('transport refused') },
  ]) {
    const f = metadataReaderFixture([response]);
    await assert.rejects(f.read('repos/ashlrai/phantom'));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.reports, []);
  }
  const missingTag = metadataReaderFixture([{ status: 404 }]);
  assert.equal(await missingTag.read('repos/ashlrai/phantom/git/ref/tags/v3.30.1'), null);
  assert.equal(missingTag.calls.length, 1);
  const foreign = metadataReaderFixture([]);
  await assert.rejects(foreign.read('repos/other/phantom'));
  assert.equal(foreign.calls.length, 0);
});

test('a recovered metadata read still passes every cadence identity and fresh-tip guard', async () => {
  const f = fixture();
  let requests = 0;
  const reports = [];
  const read = createPublicMetadataReader({ now: () => 0, sleep: async () => {}, report: message => reports.push(message),
    fetchImpl: async url => {
      if (++requests === 1) return { status: 504 };
      return { status: 200, text: async () => JSON.stringify(await f.read(url.slice('https://api.github.com/'.length))) };
    } });
  assert.equal((await planReleaseCadence({ ...f.input, read })).due, true);
  assert.equal(reports.length, 1);
  const badIdentity = metadataReaderFixture([{ status: 200, data: { ...repo, id: 1 } }]);
  await assert.rejects(planReleaseCadence({ ...f.input, read: badIdentity.read }));
  assert.equal(badIdentity.calls.length, 1);
  const g = fixture(); let branches = 0;
  const movedRead = createPublicMetadataReader({ now: () => 0, fetchImpl: async url => {
    const path = url.slice('https://api.github.com/'.length);
    const data = path.endsWith('/branches/master') && ++branches > 1 ? { commit: { sha: tagged } } : await g.read(path);
    return { status: 200, text: async () => JSON.stringify(data) };
  } });
  assert.deepEqual(await planReleaseCadence({ ...g.input, read: movedRead }), { due: false, reason: 'master-moved' });
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
