import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetTtm, fleetTtm } from '../src/cli/fleet-ttm.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const fixture = () => readFile('test/fixtures/fleet-ttm/jobs.jsonl', 'utf8');
afterEach(() => vi.restoreAllMocks());

it('joins launches outside the window and counts latest stale open outcomes once', async () => {
  const report = fleetTtm(await fixture(), 24, now);
  expect(report).toMatchObject({ open_over_30m: 1, ignored_rows: 1,
    by_repo: [
      { name: 'locus', jobs: 1, median_ttm_s: 0, p90_ttm_s: 0 },
      { name: 'phantom', jobs: 2, median_ttm_s: 200, p90_ttm_s: 300 },
    ],
    by_lane: [
      { name: 'unknown', jobs: 1, median_ttm_s: 0, p90_ttm_s: 0 },
      { name: 'work', jobs: 2, median_ttm_s: 200, p90_ttm_s: 300 },
    ] });
  expect(fleetTtm(await fixture(), 1, now).by_repo).toHaveLength(1);
  expect(fleetTtm('', 24, now).by_repo).toEqual([]);
  const rows = [-1, '10', null].map(ttm_s => JSON.stringify({ event: 'outcome', job: String(ttm_s),
    ts: '2026-11-03T11:00:00Z', state: 'MERGED', ttm_s })).join('\n');
  expect(fleetTtm(rows, 24, now).by_lane).toEqual([]);
});

it('uses the injected ledger reader, validates arguments, and registers the verb', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.fn(fixture), deps = { read, now: () => now };
  expect(await cmdFleetTtm(['--json'], deps)).toBe(0);
  expect(read).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
  expect(JSON.parse(log.mock.calls[0]![0] as string).hours).toBe(24);
  expect(await cmdFleetTtm(['--hours', '1'], deps)).toBe(0);
  expect(log.mock.lastCall![0]).toContain('Open over 30 minutes: 1');
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'NaN'], ['--json', '--json'], ['bad']]) {
    expect(await cmdFleetTtm(args, deps)).toBe(2);
  }
  expect(await cmdFleetTtm([], { ...deps, read: async () => { throw new Error('private'); } })).toBe(1);
  expect(await cmdFleetTtm(['--help'], deps)).toBe(0);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS.ttm!()).cmdFleetTtm).toBe('function');
});
