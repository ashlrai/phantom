import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRepoRate, fleetRepoRate } from '../src/cli/fleet-repo-rate.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const fixture = () => readFile(new URL('./fixtures/fleet-repo-rate/jobs.jsonl', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

describe('fleet repo-rate', () => {
  it('uses PR repos, inclusive boundaries and newest deduplicated outcomes', async () => {
    const report = fleetRepoRate(await fixture(), 6, 5, false, now);
    expect(report.by_repo).toEqual([
      { repo: 'ashlrai/phantom', merged: 5, median_ttm_s: 200, newest_merge_at: '2026-11-03T11:00:00.000Z', checked: true, red: false },
      { repo: 'other/locus', merged: 1, median_ttm_s: null, newest_merge_at: '2026-11-03T11:00:00.000Z', checked: false, red: false },
    ]);
    expect(report.red).toBe(false);
    expect(report.ignored_rows).toBe(5);
    expect(fleetRepoRate(await fixture(), 6, 5, true, now).red).toBe(true);
    expect(fleetRepoRate(await fixture(), 1, 2, false, now).red).toBe(true);
  });

  it('reports zero Phantom merges and unknown median and newest time on empty input', () => {
    expect(fleetRepoRate('', 6, 20, false, now).by_repo).toEqual([
      { repo: 'ashlrai/phantom', merged: 0, median_ttm_s: null, newest_merge_at: null, checked: true, red: true },
    ]);
    expect(fleetRepoRate('', 6, 0, false, now).red).toBe(false);
  });

  it('reads only the injected ledger path and prints machine readable results and red exit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(async () => fixture());
    expect(await cmdFleetRepoRate(['--json', '--hours', '6', '--target', '5'], { read, now: () => now })).toBe(0);
    expect(read).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
    expect(JSON.parse(String(log.mock.calls[0]![0])).schema).toBe('fleet.repo-rate.v1');
    expect(await cmdFleetRepoRate(['--json', '--all', '--target', '5'], { read, now: () => now })).toBe(1);
    expect(await cmdFleetRepoRate([], { read, now: () => now })).toBe(1);
    expect(log.mock.calls.at(-1)![0]).toContain('RED');
  });

  it.each([['--hours', '0'], ['--hours', 'Infinity'], ['--target', '-1'], ['--target', '1.5'],
    ['--target'], ['--hours', ' '], ['--all', '--all'], ['--json', '--json'], ['--wat']])('rejects invalid flags %j before reading', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdFleetRepoRate(args, { read, now: () => now })).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('offers help without reading and handles read failures without leaking errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn().mockRejectedValue(new Error('private detail'));
    expect(await cmdFleetRepoRate(['--help'], { read, now: () => now })).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(await cmdFleetRepoRate(['--json'], { read, now: () => now })).toBe(1);
    expect(error).toHaveBeenCalledWith('Unable to read jobs ledger.');
  });
});
