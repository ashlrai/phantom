import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffNeedsOsLegs, pathIsOsSensitive } from '../scripts/ci-os-paths.mjs';
import { osGateDecision } from '../scripts/ci-os-gate.mjs';
import { typecheckArgs } from '../scripts/ci-os-typecheck.mjs';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { PACKAGE, assertReleaseChecksum, assertVersion, phmCandidates, releaseChecksumFields } from '../scripts/ci-install-smoke.mjs';
import { failureAnnotation, firstFailureLocation } from '../scripts/ci-fast-run.mjs';

test('the quiet fast gate prints the failing subprocess tail before its annotation and still bails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-fast-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'test-ci.mjs'), `
    console.log('old noise');
    for (let i = 0; i < 200; i++) console.log('progress');
    console.log('FAIL unit test/fixture.test.ts > fixture');
    console.error('TypeError: fixture failed');
    console.error('    at test/fixture.test.ts:23:4');
    process.exitCode = 1;
  `);
  writeFileSync(join(root, 'next.test.mjs'), "console.error('should not run');");
  writeFileSync(join(root, 'fast-gate-plan.json'), JSON.stringify({
    tests: ['test/fixture.test.ts'], node: ['next.test.mjs'],
  }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-fast-run.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: root, CI_FAST_BAIL: '1', CI_GREEN_RECEIPT: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TypeError: fixture failed\r?\n {4}at test\/fixture\.test\.ts:23:4[\s\S]*::error file=test\/fixture\.test\.ts,line=23::/);
  assert.doesNotMatch(result.stderr, /old noise|should not run/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'fast-gate-failures.json'), 'utf8')), {
    failed: ['test/fixture.test.ts'], ok: false,
  });
});

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

test('the published tarball is rejected before install when its checksum is missing or wrong', () => {
  const bytes = Buffer.from('phantom-release-bytes');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const meta = releaseChecksumFields({
    version: '3.30.72',
    'dist.integrity': integrity,
    'dist.tarball': 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-3.30.72.tgz',
  });
  assert.equal(meta.integrity, integrity);
  assert.doesNotThrow(() => assertReleaseChecksum(bytes, meta.integrity));
  let installed = false;
  const install = () => { installed = true; };
  assert.throws(() => { assertReleaseChecksum(Buffer.alloc(0), integrity); install(); }, /tarball is missing/);
  assert.throws(() => { assertReleaseChecksum(bytes, ''); install(); }, /checksum is missing/);
  assert.throws(() => { assertReleaseChecksum(bytes, 'sha1-abc'); install(); }, /checksum is missing/);
  assert.throws(() => { assertReleaseChecksum(bytes, 'sha512-aaaaaaaa'); install(); }, /checksum mismatch/);
  assert.equal(installed, false);
  assert.throws(() => releaseChecksumFields({ version: '3.30.72', 'dist.tarball': meta.tarball }), /checksum is missing/);
});

test('a checksum-valid release fails when the installed CLI prints a different version', () => {
  const bytes = Buffer.from('checksum-valid-not-a-tarball');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const meta = releaseChecksumFields({
    version: '3.30.72',
    'dist.integrity': integrity,
    'dist.tarball': 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-3.30.72.tgz',
  });
  assert.doesNotThrow(() => assertReleaseChecksum(bytes, meta.integrity));
  const dir = mkdtempSync(join(tmpdir(), 'phantom-version-fixture-'));
  try {
    const bin = join(dir, process.platform === 'win32' ? 'phm.cmd' : 'phm');
    writeFileSync(bin, process.platform === 'win32'
      ? '@echo off\r\nnode -e "process.stdout.write(\'9.9.9\\n\')"\r\n'
      : '#!/usr/bin/env node\nprocess.stdout.write("9.9.9\\n");\n');
    chmodSync(bin, 0o755);
    assert.throws(() => assertVersion(bin, meta.version), (error) => {
      assert.match(error.message, /^::error file=\.github\/scripts\/ci-install-smoke\.mjs,line=\d+::installed phm version 9\.9\.9, expected 3\.30\.72$/);
      assert.equal(error.message.includes('\n'), false);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
