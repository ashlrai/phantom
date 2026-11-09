import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTickWall, fleetTickWall } from '../src/cli/fleet-tick-wall.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
const originalRoot = process.env.ASHLR_RUNS_DIR;
afterEach(async () => {
  if (originalRoot === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = originalRoot;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tick-wall-'));
  dirs.push(dir);
  await writeFile(join(dir, 'dispatchd.log'), contents);
  return dir;
}

describe('fleet tick-wall', () => {
  it('filters the local time window and summarizes ticks and separate SLOW lines', async () => {
    const root = await fixture([
      '2026-11-04 10:00:00 tick run=[] wall=1s',
      '2026-11-04 11:00:00 SLOW command 8s',
      '2026-11-04 11:01:00 tick run=[] wall=9s',
      '2026-11-04 11:02:00 tick run=[] wall=3s',
      '2026-11-04 11:03:00 tick run=[] wall=7s',
      '2026-11-04 11:04:00 tick run=[] wall=5s',
      '2026-11-04 12:00:01 tick wall=999s',
      '2026-11-04 11:05:00 other wall=100s',
      'bad tick wall=100s',
    ].join('\n'));
    const now = new Date(2026, 10, 4, 12).getTime();
    expect(await fleetTickWall(2, now, join(root, 'dispatchd.log'))).toMatchObject({ known: true, tick_count: 5, slow_count: 1, p50_seconds: 5, p90_seconds: 9, max_seconds: 9 });
    expect(await fleetTickWall(0.5, now, join(root, 'dispatchd.log'))).toMatchObject({ tick_count: 0, slow_count: 0, p50_seconds: null });
  });

  it('uses the root override and exposes the registered JSON command', async () => {
    process.env.ASHLR_RUNS_DIR = await fixture('');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await FLEET_SUBCOMMAND_LOADERS['tick-wall']!()).cmdFleetTickWall).toBe(cmdFleetTickWall);
    expect(await cmdFleetTickWall(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ known: true, window_hours: 2, tick_count: 0, max_seconds: null });
    expect(await cmdFleetTickWall([])).toBe(0);
    expect(String(log.mock.calls[1]![0])).toContain('Ticks: 0');
  });

  it('reports unreadable logs and rejects invalid flags', async () => {
    process.env.ASHLR_RUNS_DIR = join(tmpdir(), 'tick-wall-missing-dir');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetTickWall(['--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ known: false, tick_count: 0 });
    for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'Infinity'], ['--other']]) expect(await cmdFleetTickWall(args)).toBe(2);
    expect(await cmdFleetTickWall(['--help'])).toBe(0);
  });
});
