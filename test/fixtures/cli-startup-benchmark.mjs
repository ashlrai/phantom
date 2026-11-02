/** Compare installed launchers without reading a real home or invoking providers. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [baseline, candidate, sampleArg = '30'] = process.argv.slice(2);
const samples = Number(sampleArg);
if (!baseline || !candidate || !Number.isInteger(samples) || samples < 1 || samples > 1000 || process.argv.length > 5) {
  console.error('Usage: node test/fixtures/cli-startup-benchmark.mjs <baseline-bin> <candidate-bin> [samples=30]');
  process.exit(2);
}

const launchers = { baseline: resolve(baseline), candidate: resolve(candidate) };
const home = mkdtempSync(join(tmpdir(), 'phantom-startup-benchmark-'));
const env = {
  ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath),
  ASHLR_VERSION: '', NO_COLOR: '1', FORCE_COLOR: '0',
};
delete env.ASHLR_HOME;
const configDir = join(home, '.ashlr');
mkdirSync(configDir, { mode: 0o700 });
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ version: 1, roots: [] }), { mode: 0o600 });
writeFileSync(join(configDir, 'index.json'), JSON.stringify({ version: 1, items: [], generatedAt: '2026-10-26T00:00:00.000Z' }));

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    minMs: sorted[0], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1), samplesMs: values,
  };
}

const report = {
  node: process.version, platform: process.platform, arch: process.arch,
  cpus: availableParallelism(), loadBefore: loadavg(), warmups: 5, samples,
  method: 'Fresh Node processes; alternating order; shared temporary HOME and cached empty index; matching stdout and empty stderr; process creation and exit included.',
  commands: {},
};
try {
  for (const command of ['--version', 'status']) {
    const times = { baseline: [], candidate: [] };
    let expected;
    for (let iteration = 0; iteration < samples + report.warmups; iteration++) {
      const order = iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const label of order) {
        const start = performance.now();
        const result = spawnSync(process.execPath, [launchers[label], command], {
          cwd: home, env, encoding: 'utf8', timeout: 30_000,
        });
        const elapsed = performance.now() - start;
        // Don't echo captured output: only the metrics belong in this report.
        if (result.error || result.status !== 0 || result.stderr !== '') {
          throw new Error(`${label} ${command} failed or produced stderr`);
        }
        expected ??= result.stdout;
        if (result.stdout !== expected) throw new Error(`${command} stdout differs between launchers`);
        if (iteration >= report.warmups) times[label].push(elapsed);
      }
    }
    report.commands[command] = Object.fromEntries(Object.entries(times).map(([label, values]) => [label, summarize(values)]));
  }
  report.loadAfter = loadavg();
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
