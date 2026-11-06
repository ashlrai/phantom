import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetDiskTrend, readDiskTrend } from '../src/cli/fleet-disk-trend.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 3, 18).getTime();
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const row = (hour: string, free: string, kind = 'LEADER') => `2026-11-03 ${hour}:00:00 ${kind} free_gb=${free}`;
async function fixture(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'disk-trend-')); dirs.push(dir);
  const path = join(dir, 'dispatch-events.log');
  await writeFile(path, lines.join('\n'));
  return { now: () => now, readEvents: async () => readFile(path, 'utf8') };
}

it('uses the newest falling run after cleanup, sorted by time, with last timestamp tie winning', async () => {
  const readers = await fixture([row('12', '400'), row('13', '110'), row('14', '200'),
    row('17', '125'), row('15', '175'), row('17', '120'), row('18', '100', 'OPUS-LEADER'),
    row('11', '999'), row('19', '0'), row('18', 'NaN'), row('18', '-1'), row('18', '1oops'),
    'broken', '2026-99-99 18:00:00 LEADER free_gb=0']);
  expect(await readDiskTrend(6, 100, readers)).toMatchObject({ samples: 5, fallingSamples: 3,
    freeGb: 120, fallGbPerHour: 80 / 3, hoursUntilFloor: 0.75, status: 'red' });
  expect(await readDiskTrend(0.5, 100, readers)).toMatchObject({ samples: 0, status: 'unknown' });
});

it('handles the exact red boundary, plateaus, rises, one reading, and an already reached floor', async () => {
  for (const [lines, expected] of [
    [[row('16', '180'), row('18', '160')], { hoursUntilFloor: 6, status: 'ok' }],
    [[row('16', '150'), row('18', '150')], { fallGbPerHour: 0, hoursUntilFloor: null, status: 'ok' }],
    [[row('16', '120'), row('18', '200')], { fallGbPerHour: null, status: 'unknown' }],
    [[row('18', '100')], { hoursUntilFloor: 0, status: 'red' }],
    [[], { freeGb: null, status: 'unknown' }],
  ] as const) expect(await readDiskTrend(6, 100, await fixture([...lines]))).toMatchObject(expected);
});

it('prints JSON and plain words, honors flags, and exposes the generated verb', async () => {
  const readers = await fixture([row('16', '160'), row('18', '120')]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetDiskTrend(['--json'], readers)).toBe(1);
  expect(JSON.parse(log.mock.lastCall![0] as string)).toMatchObject({ freeGb: 120, hoursUntilFloor: 1, status: 'red' });
  expect(await cmdFleetDiskTrend(['--hours', '3', '--floor', '0'], readers)).toBe(0);
  expect(log.mock.lastCall![0]).toContain('6 hours until 0 GB floor');
  expect(await cmdFleetDiskTrend(['--help'], readers)).toBe(0);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['disk-trend']!()).cmdFleetDiskTrend).toBe('function');
});

it('rejects bad flags before reading and reports unreadable files as unknown', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const readEvents = vi.fn(async () => readFile('/missing/disk-trend.log', 'utf8'));
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'Infinity'], ['--floor', '-1'],
    ['--floor', 'no'], ['--json', '--json'], ['--hours', '2', '--hours', '3'], ['--bad']]) {
    expect(await cmdFleetDiskTrend(args, { readEvents })).toBe(2);
  }
  expect(readEvents).not.toHaveBeenCalled();
  expect(await readDiskTrend(6, 100, { readEvents, now: () => now })).toMatchObject({ status: 'unknown', freeGb: null });
  expect(await cmdFleetDiskTrend(['--json'], { readEvents })).toBe(0);
});
