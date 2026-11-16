import assert from 'node:assert/strict';
import test from 'node:test';
import { TITLE_PREFIX, classifyRun, fixupLines, planGreen, planRed } from '../scripts/full-suite-fixforward.mjs';

const sha = 'c'.repeat(40);
const run = (extra = {}) => ({ id: 77, run_attempt: 1, head_sha: sha, head_branch: 'master', path: '.github/workflows/ci.yml',
  head_repository: { id: 1263526319 }, status: 'completed', conclusion: 'failure', ...extra });
const job = (name, conclusion) => ({ name, conclusion });

test('release prep and release-gate dispatch are ignored', () => {
  assert.equal(classifyRun(run(), [job('Desktop release smoke', 'success'), job('CI (Node 22, ubuntu, authority 1/3)', 'skipped')]).kind, 'ignore');
});

test('red full attempt lists failed jobs only', () => {
  const v = classifyRun(run(), [job('CI (Node 22, ubuntu, authority 1/3)', 'failure'), job('Mac exhaustive (2/4)', 'failure'), job('Merge Gate', 'failure'), job('Secret-shape scan', 'success')]);
  assert.equal(v.kind, 'red');
  assert.deepEqual(v.failed.map(j => j.name), ['CI (Node 22, ubuntu, authority 1/3)', 'Mac exhaustive (2/4)', 'Merge Gate']);
  const lines = fixupLines(run(), v.failed);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^- READY RQ-FIXUP-PHANTOM-ccccccc-1 \(P0, /);
});

test('green full attempt closes open fix-forward issues', () => {
  const v = classifyRun(run({ conclusion: 'success' }), [job('CI (Node 22, ubuntu, authority 1/3)', 'success')]);
  assert.equal(v.kind, 'green');
  const plans = planGreen(run(), [{ number: 5, title: `${TITLE_PREFIX} abcdef0` }, { number: 6, title: 'unrelated' }]);
  assert.deepEqual(plans.map(p => [p.action, p.number]), [['close', 5]]);
});

test('same SHA comments, new SHA creates', () => {
  const failed = [{ name: 'Mac exhaustive (1/4)', conclusion: 'failure' }];
  assert.equal(planRed(run(), failed, []).action, 'create');
  assert.deepEqual(planRed(run(), failed, [{ number: 9, title: `${TITLE_PREFIX} ccccccc` }]).action, 'comment');
});

test('foreign or malformed runs refuse', () => {
  for (const extra of [{ head_branch: 'x' }, { head_repository: { id: 1 } }, { path: '.github/workflows/fake.yml' }, { head_sha: 'master' }]) {
    assert.throws(() => classifyRun(run(extra), []));
  }
});
