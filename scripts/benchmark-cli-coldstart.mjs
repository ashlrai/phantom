#!/usr/bin/env node
/** Fresh Node processes, installed shim, empty cached status, no external tools. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'phantom-coldstart-'));
const samples = 31;
try {
  mkdirSync(join(home, '.ashlr'));
  writeFileSync(join(home, '.ashlr/config.json'), JSON.stringify({ version: 1, roots: [] }));
  writeFileSync(join(home, '.ashlr/index.json'), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), items: [],
  }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'),
    PATH: dirname(process.execPath), NO_COLOR: '1',
  };
  delete env.ASHLR_VERSION;
  delete env.NODE_OPTIONS;
  console.log(JSON.stringify({ platform: platform(), arch: arch(), node: process.version, samples }));
  for (const command of ['--version', '--help', 'status']) {
    const times = [];
    for (let sample = 0; sample < samples; sample++) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'bin/ashlr'), command], {
        cwd: home, env, encoding: 'utf8', timeout: 10_000,
      });
      times.push(performance.now() - start);
      if (result.error || result.status !== 0 || !result.stdout.trim()) {
        throw new Error(`${command} did not complete successfully (exit ${result.status})`);
      }
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({
      command,
      medianMs: Number(times[Math.floor(samples / 2)].toFixed(2)),
      minMs: Number(times[0].toFixed(2)),
      maxMs: Number(times.at(-1).toFixed(2)),
    }));
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
