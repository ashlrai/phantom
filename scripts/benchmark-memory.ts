#!/usr/bin/env node
/** Offline memory quality benchmark over authored synthetic histories, executed with existing tsx. No install/build/model/provider. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMemoryBenchmark } from '../src/core/local-eval/memory-benchmark.js';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function git(args: string[]): string | null {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}
export function parseMemoryBenchmarkArgs(argv: string[]): { cases: boolean } {
  if (argv.some(arg => arg !== '--json' && arg !== '--cases') || new Set(argv).size !== argv.length) throw new Error('MEMORY_BENCH_ARGUMENTS');
  return { cases: argv.includes('--cases') };
}
export function benchmarkMemoryCli(argv = process.argv.slice(2)): { exitCode: number; output: unknown } {
  let options: { cases: boolean };
  try { options = parseMemoryBenchmarkArgs(argv); } catch {
    return { exitCode: 2, output: { code: 'MEMORY_BENCH_ARGUMENTS', error: 'Usage: npm run --silent bench:memory -- [--json] [--cases]. Only the bundled synthetic cases are supported.' } };
  }
  const report = runMemoryBenchmark();
  const sha = git(['rev-parse', 'HEAD']); const dirty = git(['status', '--porcelain', '--untracked-files=normal']);
  const arms = report.arms.map(arm => options.cases ? arm : { ...arm, cases: arm.cases.filter(entry => !entry.pass || entry.pendingDecision).map(entry => entry.id) });
  // A measurement, not a gate: the exit code reports only whether the benchmark ran.
  return { exitCode: 0, output: { source: { sha, dirty: dirty === null ? null : dirty.length > 0, observation: 'source-checkout-not-installed-build' }, ...report, arms } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = benchmarkMemoryCli(); process.stdout.write(JSON.stringify(result.output, null, 2) + '\n'); process.exitCode = result.exitCode;
}
