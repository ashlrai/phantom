#!/usr/bin/env node
/* global process, console */
// Lint the files chosen by the dependency graph. An empty list is success.
// A missing eslint install fails closed instead of reporting a pass.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function lintArgs(files) {
  return files.filter((file) => typeof file === 'string' && file.length > 0 && !file.startsWith('-') && !file.includes('\0'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const listPath = process.env.CI_LINT_LIST;
  if (!listPath) {
    console.error('CI_LINT_LIST is not set');
    process.exitCode = 1;
  } else {
    let files = [];
    try {
      files = lintArgs(readFileSync(listPath, 'utf8').split('\n').filter(Boolean));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    if (process.exitCode) {
      // already failed
    } else if (files.length === 0) {
      console.log('no lintable files in the diff');
    } else if (!existsSync('node_modules/eslint/bin/eslint.js')) {
      console.error('eslint is not installed; not treating the lint step as a pass');
      process.exitCode = 1;
    } else {
      const cache = `${process.env.RUNNER_TEMP ?? '.'}/eslintcache-ci`;
      const result = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--cache', '--cache-location', cache, ...files], { stdio: 'inherit' });
      process.exitCode = result.status ?? 1;
    }
  }
}
