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

export function firstFailureLocation(log) {
  const lines = stripVTControlCharacters(log).split('\n');
  let message = 'affected test failed';
  let file = '';
  let lineNo = '';
  for (const line of lines) {
    const fail = /^\s*(?:FAIL|×|✗)\s+\S/.exec(line);
    if (fail) message = line.trim().slice(0, 300);
    const at = /((?:test|\.github\/tests)\/\S+\.test\.(?:ts|mjs)):(\d+)/.exec(line);
    if (at && !file) {
      file = at[1];
      lineNo = at[2];
    }
  }
  if (!file || !lineNo) return null;
  return { file, line: lineNo, message };
}

export function failureAnnotation(failure) {
  const text = failure.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::error file=${failure.file},line=${failure.line}::${text}`;
}

// Fallback shards run at once. Each one must take a share of the machine,
// not all of it: three shards at full width is 12 forks on a 4-vCPU runner,
// and suites that pass alone then hit the 5000 ms timeout.
export function shardWorkers(cpus, shards) {
  return Math.max(1, Math.floor(cpus / Math.max(1, shards)));
}

function run(command, args, stream) {
  return new Promise((done) => {
    let log = '';
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (incoming, sink) => incoming.on('data', (chunk) => {
      log += chunk;
      if (stream) sink.write(chunk);
    });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on('error', (error) => done({ code: 1, log: `${log}\nspawn error: ${error.message}` }));
    child.on('close', (code) => done({ code: code ?? 1, log }));
  });
}

function commandsFor(plan, bail) {
  const commands = [];
  const bailArg = bail ? ['--bail=1'] : [];
  if (plan.mode === 'fallback') {
    const live = plan.shards.filter((shard) => shard.length);
    const workers = shardWorkers(availableParallelism(), bail ? 1 : live.length);
    for (const shard of live) commands.push([process.execPath, ['scripts/test-ci.mjs', `--maxWorkers=${workers}`, ...bailArg, ...shard]]);
  } else if (plan.tests.length) {
    commands.push([process.execPath, ['scripts/test-ci.mjs', ...bailArg, ...plan.tests]]);
  }
  if (plan.node.length) {
    if (bail) {
      for (const file of plan.node) commands.push([process.execPath, ['--test', file]]);
    } else {
      commands.push([process.execPath, ['--test', ...plan.node]]);
    }
  }
  return commands;
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
  const bail = process.env.CI_FAST_BAIL === '1';
  const commands = commandsFor(plan, bail);
  const results = [];
  if (bail) {
    for (const [command, args] of commands) {
      const result = await run(command, args, false);
      results.push(result);
      if (result.code !== 0) break;
    }
  } else {
    results.push(...await Promise.all(commands.map(([command, args]) => run(command, args, true))));
  }
  const log = results.map((result) => result.log).join('\n');
  const failed = failedTestFiles(log);
  const bad = results.some((result) => result.code !== 0);
  writeFileSync(outPath, JSON.stringify({ failed, ok: !bad }, null, 2));
  if (bad) {
    if (bail) {
      const located = firstFailureLocation(log);
      console.error(located ? failureAnnotation(located) : '::error::affected test failed');
    }
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
