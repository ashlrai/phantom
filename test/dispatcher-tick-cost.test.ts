import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readFastDaemonStatus } from '../src/core/daemon/status-fast.js';
import { freshDaemonState, saveDaemonState, daemonStatePath, daemonStateRecoveryMarkerPath } from '../src/core/daemon/state.js';
import { parseTickCost, readTickCost } from '../src/core/fleet/tick-cost.js';
import { cmdFleetTickCost } from '../src/cli/fleet-tick-cost.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tick-cost-')); dirs.push(dir);
  vi.stubEnv('HOME', dir); vi.stubEnv('ASHLR_RUNS_DIR', dir); return dir;
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('parses three real tick lines, local hourly SLOW counts and excludes old or future evidence', () => {
  const text = [48, 90, 145].map((wall, i) => `2026-11-21 18:2${i}:00 tick run={"local": 2} q=4 launched=2 reap=0 pause=False wall=${wall}s`);
  text.push('2026-11-21 18:21:01 SLOW ashlr timeout 2s, group killed', '2026-11-21 18:22:01 SLOW phm 8s',
    '2026-11-20 18:00:00 tick wall=999s', '2026-11-22 18:00:00 tick wall=999s', 'bad tick wall=999s');
  expect(parseTickCost(text.join('\n'), new Date(2026, 10, 21, 19).getTime())).toMatchObject({
    tickCount: 3, tickWallP50: 90, tickWallP95: 145, slowCount: 2, slowPerHour: 1, slowByHour: { '2026-11-21 18': 2 } });
  expect(parseTickCost(null)).toMatchObject({ known: false, tickWallP95: null, slowPerHour: null });
});
it('invalidates the timestamp cache when state changes, becomes corrupt or enters recovery', () => {
  fixture(); saveDaemonState({ ...freshDaemonState(), lastTickAt: '2026-11-21T18:00:00Z' });
  expect(readFastDaemonStatus().lastTickAt).toBe('2026-11-21T18:00:00Z');
  expect(JSON.parse(readFileSync(daemonStatePath() + '.tick-cache.json', 'utf8')).lastTickAt).toBe('2026-11-21T18:00:00Z');
  saveDaemonState({ ...freshDaemonState(), lastTickAt: '2026-11-21T19:00:00Z' });
  expect(readFastDaemonStatus().lastTickAt).toBe('2026-11-21T19:00:00Z');
  mkdirSync(join(daemonStateRecoveryMarkerPath(), '..'), { recursive: true }); writeFileSync(daemonStateRecoveryMarkerPath(), '{}');
  expect(readFastDaemonStatus().lastTickAt).toBeNull(); rmSync(daemonStateRecoveryMarkerPath());
  writeFileSync(daemonStatePath(), 'bad'); expect(readFastDaemonStatus().lastTickAt).toBeNull();
});
it('answers the real fast CLI within 500 ms with large unrelated fixture files', async () => {
  const dir = fixture(); mkdirSync(join(dir, 'queue'));
  saveDaemonState({ ...freshDaemonState(), lastTickAt: '2026-11-21T19:00:00Z' });
  writeFileSync(join(dir, 'queue/live-jobs.json'), JSON.stringify({ jobs: [], note: 'plain '.repeat(50_000) }).padEnd(341 * 1024));
  writeFileSync(join(dir, 'router-queue.md'), 'plain\n'.repeat(Math.ceil(5 * 1024 * 1024 / 6)));
  writeFileSync(join(dir, 'dispatchd.log'), '2026-11-21 18:20:00 tick run={} q=4 launched=2 reap=0 pause=False wall=48s\n'.repeat(80_000));
  // Compile before timing, as the installed CLI does; include the real executable shim.
  mkdirSync(join(dir, 'bin')); copyFileSync('bin/ashlr', join(dir, 'bin/ashlr'));
  await build({ entryPoints: ['src/cli/daemon-status-fast.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'dist/cli/daemon-status-fast.js') });
  for (const mode of ['cold', 'cached']) {
    const start = performance.now();
    const result = execFileSync(process.execPath, [join(dir, 'bin/ashlr'), 'daemon', 'status', '--fast', '--json'], { encoding: 'utf8', timeout: 5000 });
    const elapsed = performance.now() - start; console.log(`${mode} fast status: ${elapsed.toFixed(1)} ms`);
    expect(JSON.parse(result)).toEqual({ lastTickAt: '2026-11-21T19:00:00Z' }); expect(elapsed).toBeLessThan(500);
  }
  expect(await readTickCost(dir)).toMatchObject({ known: true, truncated: true });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect((await FLEET_SUBCOMMAND_LOADERS['tick-cost']!()).cmdFleetTickCost).toBe(cmdFleetTickCost);
  expect(await cmdFleetTickCost(['--json'])).toBe(0); expect(JSON.parse(String(output.mock.calls[0]![0])).schema).toBe('fleet.tick-cost.v1');
});
