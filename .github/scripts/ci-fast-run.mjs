#!/usr/bin/env node
/* global process, console */
// Runs the tests chosen by ci-fast-select.mjs (RQ-CI-FASTGATE-1). Vitest goes
// through scripts/test-ci.mjs (hermetic HOME, watchdog). The fallback shards run
// as parallel processes. Failing test files are written for merge-group
// attribution. No reruns: a failure fails the job.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export function failedTestFiles(log) {
  const found = new Set();
  for (const line of stripVTControlCharacters(log).split('\n')) {
    const m = /^\s*(?:FAIL|×|✗)\s+(?:\|[^|]*\|\s+)?((?:test|\.github\/tests)\/[^\s>]+\.test\.(?:ts|mjs))/.exec(line);
    if (m) found.add(m[1]);
  }
  return [...found].sort();
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

export async function main(planPath, outPath) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const jobs = [];
  if (plan.mode === 'fallback') {
    for (const shard of plan.shards) if (shard.length) jobs.push(run(process.execPath, ['scripts/test-ci.mjs', ...shard]));
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
