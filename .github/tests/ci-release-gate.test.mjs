import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS_APP_ID, RELEASE_GATE, evaluateReleaseGate, gateMode, requireReleaseGate } from '../scripts/ci-release-gate.mjs';

const candidate = 'a'.repeat(40);
const repo = 'ashlrai/phantom';
const run = (name, conclusion = 'success', status = 'completed', app = ACTIONS_APP_ID) => ({ name, conclusion, status, app: { id: app } });
const green = () => [
  ...RELEASE_GATE.map(([name]) => run(name)),
  run('Fast gate (typecheck + affected tests)', 'skipped'),   // push run on the same SHA
  run('Desktop release smoke', 'skipped'),                    // push run on the same SHA
  run('Release suites (build + signing path)', 'skipped'),
];

test('mode defaults to full and rejects unknown values', () => {
  assert.equal(gateMode(undefined), 'full');
  assert.equal(gateMode(''), 'full');
  assert.equal(gateMode('split'), 'split');
  assert.throws(() => gateMode('off'), /unknown RELEASE_GATE_MODE/);
});

test('full mode delegates to the unchanged scheduled-full requirement', async () => {
  let called = 0;
  const full = async () => { called += 1; return { id: 1, head_sha: candidate }; };
  const result = await requireReleaseGate({ repo, candidate, mode: 'full', full, readRuns: () => { throw new Error('not read'); } });
  assert.equal(called, 1);
  assert.equal(result.mode, 'full');
  await assert.rejects(requireReleaseGate({ repo, candidate, mode: undefined, full: async () => { throw new Error('latest scheduled full is missing, red or pending; refusing to tag'); } }), /refusing to tag/);
});

test('split mode admits only when every release suite is green on the exact SHA', async () => {
  const result = await requireReleaseGate({ repo, candidate, mode: 'split', readRuns: green });
  assert.equal(result.green, true);
  await assert.rejects(requireReleaseGate({ repo, candidate: 'master', mode: 'split', readRuns: green }), /exact SHA/);
});

for (const [name] of RELEASE_GATE) {
  test(`split mode refuses when ${name} failed`, async () => {
    const runs = green().filter(r => r.name !== name).concat(run(name, 'failure'));
    await assert.rejects(requireReleaseGate({ repo, candidate, mode: 'split', readRuns: () => runs }), /release gate red/);
  });
  test(`split mode holds when ${name} is missing or running`, () => {
    assert.equal(evaluateReleaseGate(green().filter(r => r.name !== name)).green, false);
    const running = green().filter(r => r.name !== name).concat(run(name, null, 'in_progress'));
    assert.deepEqual(evaluateReleaseGate(running).bad, []);
    assert.equal(evaluateReleaseGate(running).green, false);
  });
}

test('all-rule checks treat skipped as red; any-rule checks need one success', () => {
  const skippedMerge = green().filter(r => r.name !== 'Merge Gate').concat(run('Merge Gate', 'skipped'));
  assert.match(evaluateReleaseGate(skippedMerge).bad.join(), /Merge Gate \(skipped\)/);
  const onlySkippedSmoke = green().filter(r => r.name !== 'Desktop release smoke').concat(run('Desktop release smoke', 'skipped'));
  assert.equal(evaluateReleaseGate(onlySkippedSmoke).green, false);
  assert.deepEqual(evaluateReleaseGate(onlySkippedSmoke).bad, []);
});

test('only GitHub Actions check runs count, other apps cannot satisfy a gate', () => {
  const forged = green().filter(r => r.name !== 'Release suites (build + signing path)')
    .concat(run('Release suites (build + signing path)', 'success', 'completed', 999));
  assert.equal(evaluateReleaseGate(forged).green, false);
});

test('release prep on the same SHA (push-scoped jobs skipped) stays green', () => {
  const prep = green().concat(['Check generated files', 'Check authority drift (hermetic)', 'Quick typecheck']
    .map(name => run(name, 'skipped')));
  assert.equal(evaluateReleaseGate(prep).green, true);
  const onlySkipped = green().filter(r => r.name !== 'Quick typecheck').concat(run('Quick typecheck', 'skipped'));
  assert.equal(evaluateReleaseGate(onlySkipped).green, false);
});

test('always-run security floor checks still treat skipped as red', () => {
  for (const name of ['Merge Gate', 'Secret-shape scan', 'Secret scan (diff)']) {
    assert.ok(evaluateReleaseGate(green().concat(run(name, 'skipped'))).bad.length === 1, name);
  }
});

test('neutral, cancelled and timed_out are red', () => {
  for (const conclusion of ['neutral', 'cancelled', 'timed_out', 'action_required', null]) {
    const runs = green().filter(r => r.name !== 'Quick typecheck').concat(run('Quick typecheck', conclusion));
    assert.equal(evaluateReleaseGate(runs).bad.length, 1, String(conclusion));
  }
});

test('the full suite is not a release gate in split mode', () => {
  const names = RELEASE_GATE.map(([name]) => name);
  assert.ok(!names.includes('Master full qualification'));
  assert.ok(!names.some(name => name.startsWith('Mac exhaustive') || name.startsWith('CI (Node 22')));
});
