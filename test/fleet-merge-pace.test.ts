import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergePace, fleetMergePace } from '../src/cli/fleet-merge-pace.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const row = (job: string, hours: number, ttm_s: unknown, repo = 'ashlrai/phantom') => ({
  event: 'outcome', state: 'MERGED', job, ts: new Date(now - hours * 3_600_000).toISOString(),
  url: `https://github.com/${repo}/pull/1`, ttm_s,
});
const reader = (...rows: unknown[]) => async () => rows.map(r => JSON.stringify(r)).join('\n');
afterEach(() => vi.restoreAllMocks());

it('keeps the newest matching row per job and calculates repo and pooled medians', async () => {
  expect(await fleetMergePace(reader(row('a', 1, 30), row('a', 2, 999), row('b', 6, 10),
    row('c', 0, 100, 'ashlrai/other'), row('a', 1, 50)), now)).toEqual({
    schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [
      { repo: 'ashlrai/other', merges: 1, merges_per_hour: 1 / 6, median_ttm_s: 100 },
      { repo: 'ashlrai/phantom', merges: 2, merges_per_hour: 2 / 6, median_ttm_s: 30 },
      { repo: 'total', merges: 3, merges_per_hour: 0.5, median_ttm_s: 50 },
    ],
  });
});

it('rejects unrelated, old, future and malformed rows and excludes invalid times only from medians', async () => {
  const valid = row('a', 1, 0);
  const read = reader(valid, row('b', 2, -1), row('c', 2, '30'), row('d', 2, null),
    row('old', 6.001, 1), row('future', -1, 1), { ...valid, job: 'closed', state: 'CLOSED' },
    { ...valid, job: 'launch', event: 'launch' }, { ...valid, job: '' }, { ...valid, ts: 'bad' },
    { ...valid, url: 'https://evil.test/owner/repo/pull/1' }, null, [], 4);
  const result = await fleetMergePace(async () => `{broken\n${await read()}\n`, now);
  expect(result.rows).toEqual([
    { repo: 'ashlrai/phantom', merges: 4, merges_per_hour: 4 / 6, median_ttm_s: 0 },
    { repo: 'total', merges: 4, merges_per_hour: 4 / 6, median_ttm_s: 0 },
  ]);
  expect((await fleetMergePace(reader(row('x', 1, null)), now)).rows?.[0]?.median_ttm_s).toBeNull();
});

it('distinguishes unread metrics from an observed empty window', async () => {
  for (const read of [async () => null, async (): Promise<string> => { throw new Error('private'); }]) {
    expect(await fleetMergePace(read, now)).toMatchObject({ known: false, rows: null });
  }
  expect((await fleetMergePace(reader(), now)).rows).toEqual([
    { repo: 'total', merges: 0, merges_per_hour: 0, median_ttm_s: null },
  ]);
});

it('provides JSON, plain output and help; invalid arguments never read metrics', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const read = vi.fn(reader(row('a', 1, 20)));
  expect(await cmdFleetMergePace(['--json'], read, now)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0]).rows.at(-1).merges).toBe(1);
  expect(await cmdFleetMergePace([], read, now)).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('median time to merge: 20 seconds');
  await cmdFleetMergePace([], async () => null, now);
  expect(log.mock.calls.at(-1)![0]).toContain('unknown');
  read.mockClear();
  expect(await cmdFleetMergePace(['--help'], read)).toBe(0);
  for (const args of [['--write'], ['--json', '--json']]) expect(await cmdFleetMergePace(args, read)).toBe(2);
  expect(read).not.toHaveBeenCalled();
});

it('registers merge-pace for fleet dispatch', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['merge-pace']!()).cmdFleetMergePace).toBe(cmdFleetMergePace);
});
