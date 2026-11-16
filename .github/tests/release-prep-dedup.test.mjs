import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS_APP_ID, SMOKE, SUITES, releasePrepDecision } from '../scripts/release-prep-dedup.mjs';

const check = (name, status, conclusion, appId = ACTIONS_APP_ID) => ({ name, status, conclusion, appId });
const run = (event, status, path = '.github/workflows/ci.yml') => ({ path, event, status });

test('dispatches when this sha has no smoke or suites yet', () => {
  assert.deepEqual(releasePrepDecision({ checks: [], runs: [] }), { dispatch: true, reason: 'needed' });
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
    checks: [], runs: [run('workflow_dispatch', 'queued')],
  }).reason, 'release-run-in-flight');
  assert.equal(releasePrepDecision({
    checks: [], runs: [run('push', 'in_progress')],
  }).reason, 'needed');
});

test('ignores a same-named check from another app', () => {
  const checks = [
    check(SMOKE, 'completed', 'success', 1),
    check(SUITES, 'completed', 'success', 1),
  ];
  assert.equal(releasePrepDecision({ checks, runs: [] }).reason, 'needed');
});
