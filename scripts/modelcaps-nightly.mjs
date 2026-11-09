#!/usr/bin/env node
/** Run once per scheduled invocation. Secrets output is never forwarded. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runModelcapsNightly(args) {
  const loader = createRequire(import.meta.url).resolve('tsx/esm');
  const worker = fileURLToPath(new URL('../src/core/modelcaps.ts', import.meta.url));
  const result = spawnSync('phantom', ['exec', '--', process.execPath, '--import', loader, worker, ...args],
    { stdio: 'ignore', shell: false, timeout: 60_000 });
  return !result.error && result.status === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') === '--help') {
    console.log('Usage: node scripts/modelcaps-nightly.mjs --provider ID [--output ABS_PATH]');
  } else {
    try {
      process.exitCode = runModelcapsNightly(process.argv.slice(2));
      console.log(process.exitCode === 0 ? 'modelcaps: cache refreshed' : 'modelcaps: probe failed');
    } catch {
      console.error('modelcaps: runner failed');
      process.exitCode = 1;
    }
  }
}
