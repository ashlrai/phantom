import test from 'node:test';
import assert from 'node:assert/strict';
import { diffNeedsOsLegs, pathIsOsSensitive } from '../scripts/ci-os-paths.mjs';
import { osGateDecision } from '../scripts/ci-os-gate.mjs';
import { typecheckArgs } from '../scripts/ci-os-typecheck.mjs';
import { PACKAGE, phmCandidates } from '../scripts/ci-install-smoke.mjs';
import { failureAnnotation, firstFailureLocation } from '../scripts/ci-fast-run.mjs';

test('docs and unrelated source skip the OS legs; scripts, manifests, workflows, installers and path code do not', () => {
  assert.equal(diffNeedsOsLegs(['docs/README.md', 'README.md']), false);
  assert.equal(diffNeedsOsLegs(['src/core/fleet/lanes.ts']), false);
  assert.equal(pathIsOsSensitive('scripts/install-custody.sh'), true);
  assert.equal(pathIsOsSensitive('package-lock.json'), true);
  assert.equal(pathIsOsSensitive('.github/workflows/ci.yml'), true);
  assert.equal(pathIsOsSensitive('bin/ashlr'), true);
  assert.equal(pathIsOsSensitive('src/core/files/path-join.ts'), true);
  assert.equal(pathIsOsSensitive('desktop/src-tauri/Cargo.toml'), true);
  assert.equal(diffNeedsOsLegs(['src/cli/index.ts', '.github/workflows/ci.yml']), true);
});

test('an OS gate passes on success or a path-gate skip and fails on failure or cancellation', () => {
  assert.equal(osGateDecision({ fast: { result: 'success' }, smoke: { result: 'skipped' } }).ok, true);
  assert.equal(osGateDecision({ fast: { result: 'failure' }, smoke: { result: 'success' } }).ok, false);
  assert.equal(osGateDecision({ fast: { result: 'cancelled' } }).ok, false);
  assert.equal(osGateDecision({ fast: { result: 'missing' } }).ok, false);
  assert.equal(osGateDecision({}).ok, false);
});

test('hosted OS typecheck uses the Linux fast gate commands', () => {
  assert.deepEqual(typecheckArgs('web'), ['run', 'typecheck:web']);
  assert.deepEqual(typecheckArgs('backend'), ['exec', '--no-install', 'tsgo', '--', '--noEmit']);
  assert.deepEqual(typecheckArgs('both'), ['run', 'typecheck']);
  assert.throws(() => typecheckArgs('other'));
});

test('the install smoke names the published package and looks up phm per OS', () => {
  assert.equal(PACKAGE, '@ashlr/phantom');
  const candidates = phmCandidates('/tmp/prefix');
  assert.ok(candidates.some((candidate) => candidate.endsWith('phm') || candidate.endsWith('phm.cmd')));
});

test('the first failing test becomes one file:line annotation', () => {
  const log = [
    ' FAIL  test/fleet-lane-console.test.ts > cmdFleet lanes > exits 2',
    'AssertionError: expected empty output',
    ' ❯ test/fleet-lane-console.test.ts:580:60',
  ].join('\n');
  const located = firstFailureLocation(log);
  assert.equal(located.file, 'test/fleet-lane-console.test.ts');
  assert.equal(located.line, '580');
  assert.match(failureAnnotation(located), /^::error file=test\/fleet-lane-console\.test\.ts,line=580::/);
  assert.equal(firstFailureLocation('no failure here'), null);
});
