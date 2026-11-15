#!/usr/bin/env node
// Measure the built CLI with an empty home and a warmed Node compile cache.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const runs = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
  throw new Error('Usage: node scripts/benchmark-cli.mjs [runs: 1-100]');
}
const home = mkdtempSync(join(tmpdir(), 'phantom-cli-bench-'));
const cli = resolve('bin/ashlr');
try {
  for (const [name, args, expected] of [
    ['help', ['--help'], 0],
    ['setup', ['setup', '--json'], 1],
    ['status', ['status'], 0],
  ]) {
    const samples = [];
    for (let i = 0; i <= runs; i++) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, HOME: home, NODE_COMPILE_CACHE: join(home, 'cache') },
        stdio: 'ignore', timeout: 30000,
      });
      if (result.error || result.status !== expected) {
        throw new Error(`${name}: ${result.error?.message ?? `exit ${result.status}, expected ${expected}`}`);
      }
      if (i > 0) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(`${name}: median ${samples[Math.floor(samples.length / 2)].toFixed(1)} ms (n=${runs}, warm cache, empty HOME)`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
