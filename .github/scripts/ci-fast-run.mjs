#!/usr/bin/env node
/* global process, console */
// Runs the tests chosen by ci-fast-select.mjs (RQ-CI-FASTGATE-1). Vitest goes
// through scripts/test-ci.mjs (hermetic HOME, watchdog). The fallback shards run
// as parallel processes. Failing test files are written for merge-group
// attribution. No reruns: a failure fails the job.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { proveReuse } from './ci-green-reuse.mjs';

export function failedTestFiles(log) {
  const found = new Set();
  for (const line of stripVTControlCharacters(log).split('\n')) {
    const m = /^\s*(?:FAIL|×|✗)\s+(?:(?:\|[^|]*\||[^\s/|]+)\s+)?((?:test|\.github\/tests)\/[^\s>]+\.test\.(?:ts|mjs))/.exec(line);
    if (m) found.add(m[1]);
  }
  return [...found].sort();
}

// Fallback shards run at once. Each one must take a share of the machine,
// not all of it: three shards at full width is 12 forks on a 4-vCPU runner,
// and suites that pass alone then hit the 5000 ms timeout.
export function shardWorkers(cpus, shards) {
  return Math.max(1, Math.floor(cpus / Math.max(1, shards)));
}

function run(command, args) {
  return new Promise((done) => {
    let log = '';
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (stream, sink) => stream.on('data', (chunk) => { log += chunk; sink.write(chunk); });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on('error', (error) => done({ code: 1, log: `${log}\nspawn error: ${error.message}` }));
    child.on('close', (code) => done({ code: code ?? 1, log }));
  });
}

function reusedPriorGreen() {
  const receipt = process.env.CI_GREEN_RECEIPT;
  const hash = process.env.CI_GREEN_HASH;
  const job = process.env.CI_GREEN_JOB;
  if (!receipt || !hash || !job) return false;
  try {
    return proveReuse(readFileSync(receipt, 'utf8'), job, hash);
  } catch {
    return false;
  }
}

export async function main(planPath, outPath) {
  if (reusedPriorGreen()) {
    writeFileSync(outPath, JSON.stringify({ failed: [], ok: true, reused: true }, null, 2));
    console.log('reused a prior green affected-test result');
    return 0;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const jobs = [];
  if (plan.mode === 'fallback') {
    const live = plan.shards.filter((shard) => shard.length);
    const workers = shardWorkers(availableParallelism(), live.length);
    for (const shard of live) jobs.push(run(process.execPath, ['scripts/test-ci.mjs', `--maxWorkers=${workers}`, ...shard]));
  } else if (plan.tests.length) {
    jobs.push(run(process.execPath, ['scripts/test-ci.mjs', ...plan.tests]));
  }
  if (plan.node.length) jobs.push(run(process.execPath, ['--test', ...plan.node]));
  const results = await Promise.all(jobs);
  const failed = failedTestFiles(results.map((r) => r.log).join('\n'));
  const bad = results.some((r) => r.code !== 0);
  writeFileSync(outPath, JSON.stringify({ failed, ok: !bad }, null, 2));
  if (bad) {
    console.error(`fast-gate tests failed${failed.length ? `: ${failed.join(', ')}` : ' (no file name parsed)'}`);
    return 1;
  }
  console.log(`fast-gate tests passed: ${plan.tests.length} vitest + ${plan.node.length} node files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.RUNNER_TEMP ?? '.';
  process.exitCode = await main(resolve(dir, 'fast-gate-plan.json'), resolve(dir, 'fast-gate-failures.json'));
}
