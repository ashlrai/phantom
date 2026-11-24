import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readTickProfile } from '../src/core/fleet/tick-profile.js';
import { cmdFleetTickProfile } from '../src/cli/fleet-tick-profile.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
const now = new Date(2026, 10, 4, 12).getTime();
const summary = (wall: number, expired = 'none') => `2026-11-04 11:00:00 TICK total_s=${wall} setup_s=1.000 slowest=setup expired=${expired}`;
async function fixture(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'tick-profile-'));
  dirs.push(dir);
  await writeFile(join(dir, 'dispatchd.log'), text);
  return join(dir, 'dispatchd.log');
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('counts summaries once, including timeouts, and divides launches by the full window', async () => {
  const path = await fixture([summary(1), summary(3), summary(5), summary(7, 'setup,preflight'), summary(9),
    '2026-11-04 10:00:00 tick run={} q=2 launched=4 reap=0 pause=False wall=99s',
    '2026-11-04 11:00:00 tick run={} q=0 launched=0 reap=0 pause=True wall=99s',
    summary(900).replace('11:00:00', '09:59:59'), summary(999).replace('11:00:00', '12:00:01')].join('\n'));
  expect(await readTickProfile(path, 2, now)).toEqual({ schema: 'fleet.tick-profile.v1', known: true, window_hours: 2,
    tick_count: 5, launch_samples: 2, p50_seconds: 5, p90_seconds: 9, launches_per_hour: 2, timeout_share: 0.2 });
});

it('keeps missing, empty and malformed log metrics unknown', async () => {
  const path = await fixture(['garbage', summary(-1), summary(NaN), summary(Infinity), summary(1).replace('11-04', '02-30'),
    summary(1).replace('expired=none', 'expired='), '2026-11-04 11:00:00 tick launched=oops'].join('\n'));
  for (const file of [path, await fixture(''), path + '.missing']) {
    expect(await readTickProfile(file, 2, now)).toMatchObject({ known: file !== path + '.missing', tick_count: 0,
      launch_samples: 0, p50_seconds: null, p90_seconds: null, launches_per_hour: null, timeout_share: null });
  }
  expect((await readTickProfile(path, 2, new Date(2026, 2, 2, 12).getTime())).tick_count).toBe(0);
  await expect(readTickProfile(path, 0, now)).rejects.toThrow(RangeError);
});

it('reports observed zero launches without inventing timeout evidence for older logs', async () => {
  const path = await fixture('2026-11-04 11:00:00 tick run={} q=0 launched=0 reap=0 pause=False wall=1s');
  expect(await readTickProfile(path, 2, now)).toMatchObject({ known: true, tick_count: 0,
    launch_samples: 1, launches_per_hour: 0, timeout_share: null });
});

it('exposes registered JSON, plain text, help and usage errors through one command', async () => {
  const path = await fixture(summary(0, 'setup'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(path, '..'));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect((await FLEET_SUBCOMMAND_LOADERS['tick-profile']!()).cmdFleetTickProfile).toBe(cmdFleetTickProfile);
  expect(await cmdFleetTickProfile(['--hours', '0.5', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ window_hours: 0.5, tick_count: 0 });
  expect(await cmdFleetTickProfile([])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('timeout share: 100.0%');
  expect(await cmdFleetTickProfile(['--help'])).toBe(0);
  for (const args of [['--hours'], ['--hours', '-1'], ['--hours', '0'], ['--hours', 'NaN'], ['--hours', 'Infinity'], ['--wat'], ['--json', '--json']]) {
    expect(await cmdFleetTickProfile(args)).toBe(2);
  }
  vi.stubEnv('ASHLR_RUNS_DIR', path + '.missing');
  expect(await cmdFleetTickProfile(['--json'])).toBe(1);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ known: false, timeout_share: null });
});
