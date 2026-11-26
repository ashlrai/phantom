#!/usr/bin/env node
/* global AbortController, process, console */
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
    const m = /^\s*(?:FAIL|×|✗)\s+(?:(?:\|[^|]*\||[^\s/|]+)\s+)?((?:test|\.github\/tests|src\/web-ui)\/[^\s>]+\.test\.(?:tsx|ts|mjs))/.exec(line);
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
    if (/^\s*(?:FAIL|×|✗)\s+\S/.test(line)) message = line.trim().slice(0, 300);
    if (/AssertionError:/.test(line)) message = line.trim().slice(0, 300);
    const at = /((?:test|\.github\/tests|src\/web-ui)\/\S+\.test\.(?:tsx|ts|mjs)):(\d+)/.exec(line);
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

const BAIL = '--bail=1';
const FAILURE_LOG_LINES = 200;
const FAILURE_LOG_CHARS = 64 * 1024;

function withBail(args) {
  if (args[0] !== 'scripts/test-ci.mjs' || args.includes(BAIL)) return args;
  return [args[0], BAIL, ...args.slice(1)];
}

export function run(command, args, signal) {
  return new Promise((done) => {
    let log = '';
    let settled = false;
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result) => { if (!settled) { settled = true; done(result); } };
    const stop = () => { child.kill('SIGTERM'); };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    const take = (stream, sink) => stream.on('data', (chunk) => { log += chunk; sink.write(chunk); });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on('error', (error) => finish({ code: 1, log: `${log}\nspawn error: ${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? 1, log }));
  });
}

function runQuiet(command, args) {
  return new Promise((done) => {
    let log = '';
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    child.on('error', (error) => done({ code: 1, log: `${log}\nspawn error: ${error.message}` }));
    child.on('close', (code) => done({ code: code ?? 1, log }));
  });
}

export async function settleJobs(jobs, runJob = run) {
  const controller = new AbortController();
  return Promise.all(jobs.map((job) => runJob(job.command, job.args, controller.signal).then((result) => {
    if (result.code !== 0) controller.abort();
    return result;
  })));
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

export function commandsFor(plan, cpus = availableParallelism()) {
  const jobs = [];
  if (plan.mode === 'fallback') {
    const live = (plan.shards ?? []).filter((shard) => shard.length);
    const workers = shardWorkers(cpus, live.length);
    for (const shard of live) jobs.push({ command: process.execPath, args: withBail(['scripts/test-ci.mjs', `--maxWorkers=${workers}`, ...shard]) });
  } else if (plan.tests?.length) {
    jobs.push({ command: process.execPath, args: withBail(['scripts/test-ci.mjs', ...plan.tests]) });
  }
  if (plan.web?.length) {
    jobs.push({ command: process.execPath, args: withBail(['scripts/test-ci.mjs', '--config', 'vitest.config.web.ts', ...plan.web]) });
  }
  if (plan.node?.length) jobs.push({ command: process.execPath, args: ['--test', ...plan.node] });
  return jobs;
}

export async function main(planPath, outPath) {
  if (reusedPriorGreen()) {
    writeFileSync(outPath, JSON.stringify({ failed: [], ok: true, reused: true }, null, 2));
    console.log('reused a prior green affected-test result');
    return 0;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const bail = process.env.CI_FAST_BAIL === '1';
  const jobs = commandsFor(plan);
  const results = [];
  if (bail) {
    for (const job of jobs) {
      const result = await runQuiet(job.command, job.args);
      results.push(result);
      if (result.code !== 0) break;
    }
  } else {
    results.push(...await settleJobs(jobs));
  }
  const log = results.map((result) => result.log).join('\n');
  const failed = failedTestFiles(log);
  const bad = results.some((result) => result.code !== 0);
  writeFileSync(outPath, JSON.stringify({ failed, ok: !bad }, null, 2));
  if (bad) {
    if (bail) {
      const tail = results.at(-1).log.trimEnd().split('\n').slice(-FAILURE_LOG_LINES).join('\n').slice(-FAILURE_LOG_CHARS);
      if (tail) console.error(tail);
      const located = firstFailureLocation(log);
      console.error(located ? failureAnnotation(located) : '::error::affected test failed');
    }
    console.error(`fast-gate tests failed${failed.length ? `: ${failed.join(', ')}` : ' (no file name parsed)'}`);
    return 1;
  }
  console.log(`fast-gate tests passed: ${plan.tests.length} vitest + ${(plan.web ?? []).length} web + ${plan.node.length} node files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.RUNNER_TEMP ?? '.';
  process.exitCode = await main(resolve(dir, 'fast-gate-plan.json'), resolve(dir, 'fast-gate-failures.json'));
}
