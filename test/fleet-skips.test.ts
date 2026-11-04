import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSkips, fleetSkips } from '../src/cli/fleet-skips.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-02T12:30:00Z');
const row = (event: string, hours: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event, ts: new Date(now - hours * 3_600_000).toISOString(), repo: 'phantom', pool: 'devin', ...extra });
const read = (...lines: string[]) => async () => lines;
afterEach(() => vi.restoreAllMocks());

const fixture = [
  row('launch', 1), row('precheck_skip', 1), row('precheck_skip', 2),
  row('launch', 1, { repo: 'locus', pool: 'claude-api' }), row('launch', 2, { repo: 'locus', pool: 'claude-api' }),
  row('launch', 8, { repo: 'old' }), row('finish', 1), 'not json', '[]',
];

it('counts per repo and lane, worst skip share first, within the window', async () => {
  const r = await fleetSkips(read(...fixture), 6, now);
  expect(r.totals).toEqual({ launches: 3, skips: 2, skip_share: 0.4 });
  expect(r.by_repo).toEqual([
    { name: 'phantom', launches: 1, skips: 2, skip_share: 2 / 3 },
    { name: 'locus', launches: 2, skips: 0, skip_share: 0 },
  ]);
  expect(r.by_lane.map(g => g.name)).toEqual(['devin', 'claude-api']);
  expect((await fleetSkips(read(...fixture), 12, now)).by_repo.map(g => g.name)).toContain('old');
});
it('only reads the last 3000 lines and reports unreadable metrics as unknown', async () => {
  const reader = vi.fn(async (_n: number) => Array.from({ length: 3001 }, () => row('launch', 1)));
  expect((await fleetSkips(reader, 6, now)).totals!.launches).toBe(3000);
  expect(reader).toHaveBeenCalledWith(3000);
  expect(await fleetSkips(async () => null, 6, now)).toMatchObject({ known: false, totals: null });
});
it('registers the verb; prints one plain line per repo, json, and exits 2 on bad --hours', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS['skips']!()).cmdFleetSkips).toBe(cmdFleetSkips);
  expect(await cmdFleetSkips([], read(...fixture), now)).toBe(0);
  expect(log.mock.calls[0]![0]).toBe('phantom: 1 launches, 2 skips, 66.7% skipped\nlocus: 2 launches, 0 skips, 0.0% skipped');
  expect(await cmdFleetSkips(['--hours', '12', '--json'], read(...fixture), now)).toBe(0);
  expect(JSON.parse(log.mock.calls[1]![0])).toMatchObject({ schema: 'fleet.skips.v1', window_hours: 12 });
  const reader = vi.fn(read());
  for (const args of [['--hours'], ['--hours', 'x'], ['--hours', '0'], ['--hours', '-1'], ['--bogus']])
    expect(await cmdFleetSkips(args, reader, now)).toBe(2);
  expect(await cmdFleetSkips(['--help'], reader)).toBe(0);
  expect(reader).not.toHaveBeenCalled();
});
