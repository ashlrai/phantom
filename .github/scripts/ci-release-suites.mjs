// RELEASE-GATE-SPLIT-1: the release-relevant suites, run in order, fail fast.
// Build, release contracts (the same npm run check:release the full lane runs),
// hermetic signing-path tests (verification code only: no identity, no
// notarization, no secrets) and the release workflow script tests.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SIGNING_PATH_TESTS = Object.freeze([
  'test/m17.sign.test.ts',
  'test/m17.lazy-load-sign-fail-closed.test.ts',
  'test/m430.signed-evidence-pack.test.ts',
  'test/m431.evidence-signing-key.test.ts',
  'test/m506.signed-release-canary.test.ts',
]);
export const RELEASE_SCRIPT_TESTS = Object.freeze([
  '.github/tests/ci-release-gate.test.mjs',
  '.github/tests/ci-master-full.test.mjs',
  '.github/tests/full-suite-fixforward.test.mjs',
  '.github/tests/release-train.test.mjs',
  '.github/tests/release-cadence.test.mjs',
]);
export const SUITES = Object.freeze([
  ['build', 'npm', ['run', 'build']],
  ['release contracts', 'npm', ['run', 'check:release']],
  ['signing path', 'npm', ['run', 'test:ci', '--', '--maxWorkers=1', '--fileParallelism=false', ...SIGNING_PATH_TESTS]],
  ['release scripts', process.execPath, ['--test', ...RELEASE_SCRIPT_TESTS]],
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = mkdtempSync(join(tmpdir(), 'release-suites-'));
  for (const [label, command, args] of SUITES) {
    const started = Date.now();
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, HOME: home } });
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[release-suites] ${label}: exit ${result.status} in ${seconds}s`);
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
}
