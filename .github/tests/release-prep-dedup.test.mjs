import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { ACTIONS_APP_ID, SMOKE, SUITES, RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS, masterReleaseSettled, releasePrepDecision, releasePrepPlan } from '../scripts/release-prep-dedup.mjs';

const check = (name, status, conclusion, appId = ACTIONS_APP_ID) => ({ name, status, conclusion, appId });
const run = (event, status, conclusion = null, path = '.github/workflows/ci.yml') => ({ path, event, status, conclusion });
const pushSuccess = () => run('push', 'completed', 'success');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const dispatchRun = (status, ageMs = 60_000, event = 'workflow_dispatch', path = '.github/workflows/ci.yml') =>
  ({ path, event, status, createdAt: NOW - ageMs });

test('dispatches when this sha has no smoke or suites yet', () => {
  assert.deepEqual(releasePrepDecision({ checks: [], runs: [pushSuccess()] }), { dispatch: true, reason: 'needed' });
});

test('waits for completed exact-sha push CI before dispatching', () => {
  assert.deepEqual(releasePrepDecision({ checks: [], runs: [] }), { dispatch: false, reason: 'push-ci-pending' });
  assert.deepEqual(releasePrepDecision({
    checks: [], runs: [run('push', 'in_progress')],
  }), { dispatch: false, reason: 'push-ci-pending' });
});

test('does not dispatch after completed exact-sha push CI fails', () => {
  assert.deepEqual(releasePrepDecision({
    checks: [], runs: [run('push', 'completed', 'failure')],
  }), { dispatch: false, reason: 'push-ci-red' });
});

test('does not dispatch when both checks are already green on this sha', () => {
  const checks = [
    check(SMOKE, 'completed', 'success'),
    check(SUITES, 'completed', 'success'),
    check(SMOKE, 'completed', 'skipped'),
  ];
  assert.equal(releasePrepDecision({ checks, runs: [] }).reason, 'already-green');
});

test('does not dispatch while either check or a release-gate run is in flight', () => {
  assert.equal(releasePrepDecision({
    checks: [check(SMOKE, 'in_progress', null)], runs: [],
  }).reason, 'checks-in-progress');
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess(), run('workflow_dispatch', 'queued')],
  }).reason, 'release-run-in-flight');
  assert.equal(releasePrepDecision({
    checks: [], runs: [run('push', 'in_progress')],
  }).reason, 'push-ci-pending');
});

test('ignores a same-named check from another app', () => {
  const checks = [
    check(SMOKE, 'completed', 'success', 1),
    check(SUITES, 'completed', 'success', 1),
  ];
  assert.equal(releasePrepDecision({ checks, runs: [pushSuccess()] }).reason, 'needed');
});

test('an unfinished master dispatch on any sha already covers the owed version', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.equal(releasePrepDecision({ checks: [], runs: [pushSuccess()], dispatchRuns: [dispatchRun(status)], now: NOW }).reason,
      'release-run-in-flight');
  }
  // Completed dispatches, scheduled full runs and foreign paths never block:
  // only an unfinished workflow_dispatch on master is release-gate work.
  for (const row of [
    dispatchRun('completed'),
    dispatchRun('in_progress', 60_000, 'schedule'),
    dispatchRun('queued', 60_000, 'workflow_dispatch', '.github/workflows/other.yml'),
    { path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'queued' },
  ]) {
    assert.equal(releasePrepDecision({ checks: [], runs: [pushSuccess()], dispatchRuns: [row], now: NOW }).reason, 'needed');
  }
});

test('a stale or future-dated unfinished dispatch cannot gate later decisions forever', () => {
  assert.equal(RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS, 3 * 60 * 60_000);
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess()], dispatchRuns: [dispatchRun('queued', RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS + 1)], now: NOW,
  }).reason, 'needed');
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess()], dispatchRuns: [dispatchRun('queued', RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS)], now: NOW,
  }).reason, 'release-run-in-flight');
  // Sixty seconds of clock skew still counts as in flight; beyond that or a
  // missing timestamp fails open to dispatching, matching prior behavior.
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess()], dispatchRuns: [dispatchRun('queued', -60_000)], now: NOW,
  }).reason, 'release-run-in-flight');
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess()], dispatchRuns: [dispatchRun('queued', -120_000)], now: NOW,
  }).reason, 'needed');
});

test('sha-local evidence still decides before the cross-sha dispatch check', () => {
  const blocking = [dispatchRun('in_progress')];
  assert.equal(releasePrepDecision({
    checks: [check(SMOKE, 'completed', 'success'), check(SUITES, 'completed', 'success')], runs: [], dispatchRuns: blocking, now: NOW,
  }).reason, 'already-green');
  assert.equal(releasePrepDecision({
    checks: [check(SMOKE, 'in_progress', null)], runs: [], dispatchRuns: blocking, now: NOW,
  }).reason, 'checks-in-progress');
  assert.equal(releasePrepDecision({
    checks: [], runs: [pushSuccess(), run('workflow_dispatch', 'queued')], dispatchRuns: blocking, now: NOW,
  }).reason, 'release-run-in-flight');
});

const SHA40 = 'b'.repeat(40);
const http = (status) => new Error(`GitHub API request failed (HTTP ${status})`);
const pkgBody = (version, encoding = 'base64') => ({
  encoding,
  content: Buffer.from(JSON.stringify({ version })).toString('base64'),
});
// Routes the three settled-check reads; anything else is a test bug.
const settledRead = ({ version = '3.30.40', tag = 'ok', release = 'ok', pkg = null } = {}) => {
  const paths = [];
  const read = (path) => {
    paths.push(path);
    if (path === `repos/ashlrai/phantom/contents/package.json?ref=${SHA40}`) {
      if (pkg instanceof Error) throw pkg;
      return pkg ?? pkgBody(version);
    }
    if (path.startsWith('repos/ashlrai/phantom/git/ref/tags/')) {
      if (tag === 'ok') return { ref: 'refs/tags/v3.30.40' };
      throw http(tag);
    }
    if (path.startsWith('repos/ashlrai/phantom/releases/tags/')) {
      if (release === 'ok') return { id: 1, draft: false };
      throw http(release);
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { read, paths };
};

test('masterReleaseSettled requires the carried version tagged and published', () => {
  const { read, paths } = settledRead();
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, read), true);
  assert.deepEqual(paths, [
    `repos/ashlrai/phantom/contents/package.json?ref=${SHA40}`,
    'repos/ashlrai/phantom/git/ref/tags/v3.30.40',
    'repos/ashlrai/phantom/releases/tags/v3.30.40',
  ]);
});

test('an untagged carried version stays a candidate without a release read', () => {
  const { read, paths } = settledRead({ version: '3.30.41', tag: 404 });
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, read), false);
  assert.equal(paths.some((p) => p.includes('/releases/tags/')), false);
});

test('a tag whose release is still a draft or missing stays a candidate', () => {
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ release: 404 }).read), false);
});

test('incomplete or failed evidence fails open to a candidate', () => {
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ pkg: http(500) }).read), false);
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ pkg: pkgBody('3.30') }).read), false);
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ pkg: { encoding: 'none', content: '' } }).read), false);
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ release: 500 }).read), false);
  assert.equal(masterReleaseSettled('ashlrai/phantom', SHA40, settledRead({ tag: 500 }).read), false);
});

test('releasePrepPlan skips the inventory once the version is settled', () => {
  const settled = settledRead();
  assert.deepEqual(releasePrepPlan('ashlrai/phantom', SHA40, settled.read), { dispatch: false, reason: 'release-settled' });
  assert.equal(settled.paths.some((p) => p.includes('check-runs')), false);
  const owed = settledRead({ version: '3.30.41', tag: 404 });
  const decision = releasePrepPlan('ashlrai/phantom', SHA40, (path) => {
    if (/check-runs/.test(path)) return { check_runs: [] };
    if (path.includes('event=workflow_dispatch&branch=master')) return { workflow_runs: [] };
    if (/workflows\/ci\.yml\/runs/.test(path)) return { workflow_runs: [pushSuccess()] };
    return owed.read(path);
  });
  assert.deepEqual(decision, { dispatch: true, reason: 'needed' });
});
