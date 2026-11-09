/* global process, URL */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { selectQuickDriftTests } from '../scripts/select-quick-drift-tests.mjs';

const CLI_TESTS = [
  'test/cli-registry-drift.test.ts',
  'test/cli-help-no-side-effects.test.ts',
];
const DOCUMENTATION_TEST = 'test/documentation-navigation.test.ts';

test('src/cli changes select both CLI drift suites', () => {
  assert.deepEqual(selectQuickDriftTests(['src/cli/index.ts']), CLI_TESTS);
  assert.deepEqual(selectQuickDriftTests(['src/cli/nested/command.ts']), CLI_TESTS);
});

test('docs and package changes select documentation navigation', () => {
  for (const path of [
    'docs/README.md',
    'docs/guides/nested.txt',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    assert.deepEqual(selectQuickDriftTests([path]), [DOCUMENTATION_TEST], path);
  }
});

test('mixed changes are deduplicated in stable test order', () => {
  assert.deepEqual(selectQuickDriftTests([
    'docs/README.md',
    'src/cli/help.ts',
    'package.json',
    'src/cli/completions.ts',
  ]), [...CLI_TESTS, DOCUMENTATION_TEST]);
});

test('unrelated and prefix-only paths select nothing', () => {
  for (const path of [
    'src/core/help.ts',
    'src/cli',
    'src/cli-other/help.ts',
    'docs',
    'docs.md',
    'README.md',
    'examples/package.json',
    'scripts/package-lock.json',
  ]) {
    assert.deepEqual(selectQuickDriftTests([path]), [], path);
  }
  assert.deepEqual(selectQuickDriftTests([]), []);
});

test('the command line interface maps path arguments to test files', () => {
  const script = fileURLToPath(new URL('../scripts/select-quick-drift-tests.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script, 'src/cli/index.ts', 'docs/README.md'], { encoding: 'utf8' });
  assert.equal(output, `${[...CLI_TESTS, DOCUMENTATION_TEST].join('\n')}\n`);
  assert.equal(execFileSync(process.execPath, [script, 'src/core/index.ts'], { encoding: 'utf8' }), '');
});
