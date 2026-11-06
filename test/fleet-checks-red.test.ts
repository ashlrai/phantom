import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetChecksRed, fleetChecksRed } from '../src/cli/fleet-checks-red.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = () => Date.parse('2026-11-03T12:00:00Z');
const read = () => readFile(new URL('./fixtures/checks-red/jobs.jsonl', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

it('groups fixture merges by URL, excludes invalid and out-of-window rows, and sorts newest red PRs', async () => {
  const report = fleetChecksRed(await read(), 6, now());
  expect(report).toMatchObject({ red: true, ignored_rows: 4, by_repo: [
    { repo: 'ashlrai/phantom', merged: 5, merged_with_checks_red: 4, red_share: 0.8, checks_unknown: 1, red: true,
      newest_red_pr_urls: [1, 2, 3].map(n => `https://github.com/ashlrai/phantom/pull/${n}`) },
    { repo: 'other/locus', merged: 1, merged_with_checks_red: 0, red_share: 0, checks_unknown: 0, red: false },
  ] });
  expect(fleetChecksRed(await read(), 1, now()).by_repo[0]).toMatchObject({ merged: 1, red_share: 1, red: false });
  expect(fleetChecksRed('', 6, now())).toMatchObject({ by_repo: [], red: false });
});

it('requires at least five merges and strictly more than half red', () => {
  const rows = (count: number, red: number) => Array.from({ length: count }, (_, i) => JSON.stringify({
    event: 'outcome', state: 'MERGED', ts: '2026-11-03T12:00:00Z',
    url: `https://github.com/a/b/pull/${i + 1}`, checks_red: i < red,
  })).join('\n');
  for (const [count, red, expected] of [[4, 4, false], [6, 3, false], [5, 3, true]] as const) {
    expect(fleetChecksRed(rows(count, red), 6, now()).red).toBe(expected);
  }
});

it('reads the default ledger through injection, prints JSON and plain words, and returns health status', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const reader = vi.fn(read);
  expect(await cmdFleetChecksRed(['--json'], { read: reader, now })).toBe(1);
  expect(reader).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.checks-red.v1', hours: 6, red: true });
  expect(await cmdFleetChecksRed(['--hours', '1'], { read, now })).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('1 merged, 1 with red checks');
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['checks-red']!()).cmdFleetChecksRed).toBe('function');
});

it('rejects invalid flags before reading and hides read errors', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reader = vi.fn(async () => { throw new Error('private detail'); });
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', '-1'], ['--hours', 'Infinity'],
    ['--hours', '1e308'], ['--json', '--json'], ['--hours', '1', '--hours', '2'], ['--wat']]) {
    expect(await cmdFleetChecksRed(args, { read: reader, now })).toBe(2);
  }
  expect(await cmdFleetChecksRed(['--help'], { read: reader, now })).toBe(0);
  expect(reader).not.toHaveBeenCalled();
  expect(await cmdFleetChecksRed([], { read: reader, now })).toBe(1);
  expect(error.mock.calls.at(-1)).toEqual(['Unable to read jobs ledger.']);
});
