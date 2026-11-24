#!/usr/bin/env node
/* global process */
// The same no-emit commands the Linux fast gate runs, chosen by ci-fast-inputs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function typecheckArgs(projects) {
  if (projects === 'web') return ['run', 'typecheck:web'];
  if (projects === 'backend') return ['exec', '--no-install', 'tsgo', '--', '--noEmit'];
  if (projects === 'both' || projects === 'none' || projects === '') return ['run', 'typecheck'];
  throw new Error(`unknown typecheck project set: ${projects}`);
}

function npm(args) {
  const result = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  npm(typecheckArgs(process.env.PROJECTS ?? 'both'));
}
