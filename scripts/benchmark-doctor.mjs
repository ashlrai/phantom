/** Repeatable process-to-exit doctor timing with an isolated home and tool inventory. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

if (process.platform === 'win32') throw new Error('The timing fixture requires POSIX tool shims');
const cli = resolve(process.argv[2] ?? 'dist/cli/index.js');
const samples = 10;
const root = mkdtempSync(join(tmpdir(), 'phantom-doctor-benchmark-'));
try {
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
  mkdirSync(bin);
  // Nine independent 25 ms version probes: enough to expose serialized work.
  // Secrets and Locus are absent, so this never queries a real account or vault.
  for (const binary of ['phm', 'ashlr', 'ashlrcode', 'ashlr-plugin', 'aw', 'stack', 'pulse', 'morphkit', 'binshield']) {
    writeFileSync(join(bin, binary), '#!/bin/sh\n/bin/sleep 0.025\nprintf "fixture 1.2.3\\n"\n', { mode: 0o755 });
  }
  writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://127.0.0.1:1', ollama: 'http://127.0.0.1:1', providerChain: ['lmstudio', 'ollama'] },
    telemetry: {}, tools: {}, plugins: { enabled: [], settings: {}, integrity: {} },
  }));
  const env = { HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1' };
  const times = [];
  let signature;
  for (let sample = 0; sample <= samples; sample++) {
    const started = performance.now();
    const child = spawnSync(process.execPath, [cli, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    times.push(performance.now() - started);
    if (child.error || child.status !== 0) throw new Error(`Doctor failed in sample ${sample}; exit ${child.status}`);
    const report = JSON.parse(child.stdout);
    if (!report.checks.length || report.summary.fail !== 0) throw new Error('Incomplete or failing report');
    const actual = JSON.stringify(report.checks.map(check => [check.id, check.status]));
    signature ??= actual;
    if (actual !== signature) throw new Error('Health outcomes changed across benchmark samples');
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, architecture: process.arch,
    samples, toolVersionDelayMs: 25, checks: JSON.parse(signature).length,
    coldMs: Math.round(times[0]), warmMedianMs: Math.round((warm[4] + warm[5]) / 2),
    warmP95Ms: Math.round(warm[9]), warmMaxMs: Math.round(warm.at(-1)),
    samplesMs: times.map(value => Math.round(value)),
  }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
