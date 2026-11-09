#!/usr/bin/env node
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_TESTS = Object.freeze([
  'test/cli-registry-drift.test.ts',
  'test/cli-help-no-side-effects.test.ts',
]);
const DOCUMENTATION_TEST = 'test/documentation-navigation.test.ts';
const PACKAGE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

export function selectQuickDriftTests(paths) {
  const cli = paths.some((path) => path.startsWith('src/cli/') && path.length > 'src/cli/'.length);
  const documentation = paths.some((path) =>
    (path.startsWith('docs/') && path.length > 'docs/'.length) || PACKAGE_FILES.has(path));
  return [
    ...(cli ? CLI_TESTS : []),
    ...(documentation ? [DOCUMENTATION_TEST] : []),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = selectQuickDriftTests(process.argv.slice(2));
  if (selected.length > 0) process.stdout.write(`${selected.join('\n')}\n`);
}
