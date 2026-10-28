#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { affected } from './affected-tests.mjs';

const args = process.argv.slice(2);
const fast = args[0] === '--fast';
if (fast) args.shift();
if (args.length && (args.length !== 2 || args[0] !== '--base')) {
  console.error('Usage: node scripts/run-affected-tests.mjs [--fast] [--base REF]');
  process.exit(2);
}
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (fast) {
  run('npm', ['run', 'typecheck']);
  run(process.execPath, ['--test', 'scripts/affected-tests.test.mjs']);
}
const selection = affected(args[1]);
if (selection === 'ALL') {
  console.log('Affected tests: ALL');
  run('npm', ['run', 'test:ci']);
  run('npm', ['run', 'test:web']);
} else {
  const tests = new Set(selection);
  if (fast) {
    const smoke = JSON.parse(readFileSync('scripts/gate-smoke.json', 'utf8'));
    for (const entry of [...smoke.backend, ...smoke.web]) tests.add(entry.file);
    // Invariants include the security and Tier-1 custody checks.
    const tracked = spawnSync('git', ['ls-files', 'test/h*.test.ts', 'test/*security*.test.ts', 'test/*tier1*.test.ts'], { encoding: 'utf8' });
    if (tracked.status !== 0) process.exit(1);
    for (const file of tracked.stdout.split('\n').filter(Boolean)) tests.add(file);
  }
  const backend = [...tests].filter((file) => file.startsWith('test/')).sort();
  const web = [...tests].filter((file) => file.startsWith('src/web-ui/')).sort();
  if (backend.length) run('npm', ['run', 'test:ci', '--', ...backend]);
  if (web.length) run('npm', ['run', 'test:web', '--', ...web]);
  if (!tests.size) console.log('No affected tests.');
}
