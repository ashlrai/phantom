import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetLaneSupply, fleetLaneSupply } from '../src/cli/fleet-lane-supply.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const row = (event: string, job: string | null, hours: number, extra = {}) => JSON.stringify({ event, ...(job ? { job } : {}),
  ts: new Date(now - hours * 3_600_000).toISOString(), ...extra });
const read = (...rows: string[]) => async () => rows.join('\n');
const jobs = (lane: string, n: number, merged: number, empty: number) => Array.from({ length: n }, (_, i) => {
  const id = `${lane}-${i}`;
  return [row('launch', id, 5, { lane }), row('finish', id, 4, { empty: i < empty }),
    ...(i >= n - merged ? [row('outcome', id, 3, { state: 'MERGED' }), row('outcome', id, 2, { state: 'MERGED' })] : [])];
}).flat();
afterEach(() => vi.restoreAllMocks());

it('classifies healthy, zero-merge, empty-heavy, low-sample, held and no-start lanes over 24 hours', async () => {
  const report = await fleetLaneSupply(read(
    ...jobs('good', 4, 2, 1), ...jobs('dud', 3, 0, 0), ...jobs('hollow', 4, 1, 3), ...jobs('new', 1, 0, 0),
    row('autobackoff_hold', null, 2, { lane: 'paused' }), row('autobackoff_skip', null, 1, { lane: 'paused' }), row('authbackoff_skip', null, 1, { lane: 'paused' }),
    row('precheck_skip', 'q1', 1, { lane: 'quiet' }), row('launch', 'old', 30, { lane: 'quiet' }),
    '{', 'null', '[]'), 24, now);
  expect(report.known).toBe(true);
  const by = Object.fromEntries(report.lanes.map(l => [l.lane, l]));
  expect(by.good).toMatchObject({ starts: 4, merged: 2, merged_per_start: 0.5, finishes: 4, empty_finishes: 1, empty_share: 0.25, held_launches: 0, status: 'healthy' });
  expect(by.dud).toMatchObject({ starts: 3, merged: 0, merged_per_start: 0, empty_share: 0, status: 'zero-merge' });
  expect(by.hollow).toMatchObject({ merged: 1, empty_share: 0.75, status: 'empty-heavy' });
  expect(by.new).toMatchObject({ starts: 1, status: 'low-sample' });
  expect(by.paused).toEqual({ lane: 'paused', starts: 0, merged: 0, finishes: 0, empty_finishes: 0, held_launches: 3, merged_per_start: null, empty_share: null, status: 'held' });
  expect(by.quiet).toMatchObject({ starts: 0, held_launches: 0, merged_per_start: null, status: 'no-start' });
  expect(report.recommendations.map(r => r.lane)).toEqual(['dud', 'hollow', 'paused', 'quiet']);
  expect(report.recommendations.find(r => r.lane === 'paused')!.text).toContain('phm fleet held');
});

it('counts merged once per job, takes the lane from the launch row and the latest finish per job', async () => {
  const report = await fleetLaneSupply(read(
    row('launch', 'J1', 3, { lane: 'a' }), row('finish', 'J1', 2.5, { empty: true }), row('finish', 'J1', 2, { empty: false }),
    row('outcome', 'J1', 1, { state: 'MERGED' }), row('outcome', 'J1', 0.5, { state: 'MERGED' })), 24, now);
  expect(report.lanes).toEqual([{ lane: 'a', starts: 1, merged: 1, finishes: 1, empty_finishes: 0, held_launches: 0, merged_per_start: 1, empty_share: 0, status: 'healthy' }]);
  expect((await fleetLaneSupply(read(row('launch', 'J1', 3, { lane: 'a' })), 2, now)).lanes).toEqual([]);
});

it('reports unknown for unreadable metrics and rejects a bad window', async () => {
  expect(await fleetLaneSupply(async () => null, 24, now)).toMatchObject({ known: false, lanes: [], recommendations: [] });
  expect((await fleetLaneSupply(async () => { throw new Error('boom'); }, 24, now)).known).toBe(false);
  await expect(fleetLaneSupply(read(), 0, now)).rejects.toThrow(RangeError);
});

it('prints typed json and plain recommendations, and rejects bad flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const data = read(...jobs('good', 3, 2, 0), row('autobackoff_hold', null, 1, { lane: 'paused' }));
  expect(await cmdFleetLaneSupply(['--json'], data, now)).toBe(0);
  const json = JSON.parse(log.mock.calls[0]![0] as string);
  expect(json).toMatchObject({ schema: 'fleet.lane-supply.v1', window_hours: 24, known: true });
  expect(json.recommendations).toEqual([{ lane: 'paused', status: 'held', text: expect.stringContaining('1 held launches') }]);
  log.mockClear();
  expect(await cmdFleetLaneSupply([], data, now)).toBe(0);
  const out = log.mock.calls[0]![0] as string;
  expect(out).toContain('good: healthy; 3 starts, 2 merged (0.67 per start), 0% empty, 0 held');
  expect(out).toContain('Do next:\n- paused started nothing and had 1 held launches.');
  log.mockClear();
  expect(await cmdFleetLaneSupply([], read(...jobs('good', 3, 2, 0)), now)).toBe(0);
  expect(log.mock.calls[0]![0]).toContain('No lane needs attention.');
  log.mockClear();
  expect(await cmdFleetLaneSupply([], async () => null, now)).toBe(0);
  expect(log.mock.calls[0]![0]).toBe('Lane supply: unknown (metrics unreadable)');
  for (const bad of [['--hours'], ['--hours', '0'], ['--hours', 'x'], ['--json', '--json'], ['--nope']]) expect(await cmdFleetLaneSupply(bad, data, now)).toBe(2);
  expect(err).toHaveBeenCalled();
  log.mockClear();
  expect(await cmdFleetLaneSupply(['--help'], data, now)).toBe(0);
  expect(log.mock.calls[0]![0]).toContain('Usage: phm fleet lane-supply');
});

it('lane-supply is registered as a fleet verb', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['lane-supply']!()).cmdFleetLaneSupply).toBe(cmdFleetLaneSupply);
});
