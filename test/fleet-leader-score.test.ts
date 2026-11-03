import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetLeaderScore, fleetLeaderScore } from '../src/cli/fleet-leader-score.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const row = (job: string, event: string, extra = {}, age = 1) =>
  ({ job, event, ts: new Date(now - age * 3_600_000).toISOString(), ...extra });
const read = (...rows: unknown[]) => async () => rows.map(r => JSON.stringify(r)).join('\n');
afterEach(() => vi.restoreAllMocks());

it('joins unordered rows, deduplicates jobs and computes an even median', async () => {
  const report = await fleetLeaderScore(read(
    row('RQ-XQ8', 'outcome', { state: 'MERGED', ttm_s: 20, url: 'https://github.com/ashlrai/phantom/pull/1' }),
    row('RQ-XQ8', 'outcome', { state: 'OPEN', ttm_s: 99 }, 2),
    row('RQ-XQ8', 'launch'), row('RQ-XQ8', 'launch'),
    row('RQ-YQ8', 'outcome', { state: 'MERGED', ttm_s: 40 }),
    row('RQ-ZQ8', 'precheck_skip', { code: 10 }, 2),
    row('RQ-ZQ8', 'precheck_skip', { code: 11 }),
    row('RQ-ZQ8', 'publish', { url: 'https://github.com/ashlrai/phantom/pull/2' }),
  ), now);
  expect(report.totals).toEqual({ jobs: 3, launched: 1, precheck: 1, prs: 2, merged: 2 });
  expect(report.median_ttm_s).toBe(30);
  expect(report.jobs[0]).toEqual({ job: 'RQ-XQ8', launched: true, precheck_code: null,
    pr_url: 'https://github.com/ashlrai/phantom/pull/1', merged: true, ttm_s: 20 });
  expect(report.jobs[2]?.precheck_code).toBe(11);
});

it('filters exact suffix, auto-generated IDs, times and irrelevant events', async () => {
  const report = await fleetLeaderScore(read(
    row('RQ-A123456Q8', 'launch'), row('RQ-A123456-XQ8', 'launch'),
    row('RQ-XQ80', 'launch'), row('RQ-OLDQ8', 'launch', {}, 6.01),
    row('RQ-FUTUREQ8', 'launch', {}, -1), row('RQ-BADQ8', 'launch', { ts: 'bad' }),
    row('RQ-IGNOREQ8', 'finish'), null, [], 'bad',
    row('RQ-A12345Q8', 'launch', {}, 6), row('RQ-NOWQ8', 'launch', {}, 0),
  ), now);
  expect(report.jobs.map(j => j.job)).toEqual(['RQ-A12345Q8', 'RQ-NOWQ8']);
});

it('excludes invalid and unmerged times; handles odd medians and partial lines', async () => {
  const text = await read(row('XQ8', 'outcome', { state: 'MERGED', ttm_s: 0 }),
    row('YQ8', 'outcome', { state: 'MERGED', ttm_s: -1 }),
    row('ZQ8', 'outcome', { state: 'OPEN', ttm_s: 10 }),
    row('WQ8', 'outcome', { state: 'MERGED', ttm_s: '20', url: 'javascript:bad' }))();
  const result = await fleetLeaderScore(async () => text + '\n{partial', now);
  expect(result.median_ttm_s).toBe(0);
  expect(result.jobs.find(j => j.job === 'WQ8')).toMatchObject({ pr_url: null, ttm_s: null });
});

it('distinguishes unreadable from empty metrics', async () => {
  for (const reader of [async () => null, async (): Promise<string> => { throw Error('private'); }]) {
    expect(await fleetLeaderScore(reader, now)).toMatchObject({ known: false, totals: null, median_ttm_s: null });
  }
  expect(await fleetLeaderScore(read(), now)).toMatchObject({ known: true, totals: { jobs: 0 }, median_ttm_s: null });
});

it('routes the verb, prints JSON and plain words, and validates before reading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const reader = vi.fn(read(row('XQ8', 'launch')));
  expect((await FLEET_SUBCOMMAND_LOADERS['leader-score']!()).cmdFleetLeaderScore).toBe(cmdFleetLeaderScore);
  expect(await cmdFleetLeaderScore(['--help'], reader, now)).toBe(0);
  expect(await cmdFleetLeaderScore(['--write'], reader, now)).toBe(2);
  expect(await cmdFleetLeaderScore(['--json', '--json'], reader, now)).toBe(2);
  expect(reader).not.toHaveBeenCalled();
  expect(await cmdFleetLeaderScore(['--json'], reader, now)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ known: true, totals: { launched: 1 } });
  await cmdFleetLeaderScore([], reader, now);
  expect(log.mock.calls.at(-1)![0]).toContain('1 jobs, 1 launched');
  await cmdFleetLeaderScore([], async () => null, now);
  expect(log.mock.calls.at(-1)![0]).toContain('unknown');
});
