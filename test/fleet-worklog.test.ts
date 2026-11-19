import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWorklog } from '../src/cli/fleet-worklog.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { buildFleetWorklog, fleetWorklogText, readFleetWorklog, worklogOptions, type FleetWorklogReport } from '../src/core/fleet/worklog-numbers.js';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';

const NOW = Date.parse('2026-11-18T15:20:00Z');
const pull = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const ledger = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
const ROWS = [
  { event: 'launch', job: 'old', lane: 'fast', repo: 'locus', ts: '2026-11-17T23:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', url: 'https://github.com/ashlrai/locus/pull/3', ttm_s: 120, ts: '2026-11-17T23:59:59.999Z' },
  { event: 'outcome', state: 'MERGED', job: 'midnight', url: pull(5), ttm_s: 300, ts: '2026-11-18T00:00:00Z' },
  { event: 'launch', job: 'beta', lane: 'fast', repo: 'phantom', ts: '2026-11-18T13:59:59.999Z' },
  // alpha is launched twice: the first run changes nothing, the second opens the PR that merges.
  { event: 'launch', job: 'alpha', lane: 'work', repo: 'phantom', ts: '2026-11-18T14:00:00Z' },
  { event: 'finish', job: 'alpha', empty: true, exit_code: 0, ts: '2026-11-18T14:10:00Z' },
  { event: 'launch', job: 'alpha', lane: 'work', repo: 'phantom', ts: '2026-11-18T14:20:00Z' },
  { event: 'finish', job: 'alpha', empty: false, exit_code: 0, ts: '2026-11-18T14:30:00Z' },
  { event: 'publish', job: 'alpha', url: pull(7), ts: '2026-11-18T14:30:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'alpha', url: pull(7), ts: '2026-11-18T14:40:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'alpha', url: pull(7), ts: '2026-11-18T14:50:00Z' },
  // A merge with no publish row and no recorded time to merge.
  { event: 'outcome', state: 'MERGED', job: 'gamma', url: pull(8), ts: '2026-11-18T15:05:00Z' },
];
const build = (text: string | null, more: { hours?: number; by?: 'hour' | 'day'; utcOffsetMinutes?: number } = {}) =>
  buildFleetWorklog({ ledger: text, now: NOW, hours: 4, utcOffsetMinutes: 0, ...more });
const hour = (report: FleetWorklogReport, start: string) => report.hourly.find(row => row.start === `2026-11-18T${start}:00.000Z`)!;
const ZERO = { launches: 0, finished: 0, empty: 0, prs: 0, merged: 0, median_ttm_s: null, merged_per_launch: null };
const NONE = { launches: null, finished: null, empty: null, prs: null, merged: null, median_ttm_s: null, merged_per_launch: null };

describe('fleet work log numbers', () => {
  const report = build(ledger(...ROWS));
  it('puts an event on the hour in the hour it starts, and one a millisecond earlier in the hour before', () => {
    expect(report.hourly.map(row => row.start.slice(11, 16))).toEqual(['12:00', '13:00', '14:00', '15:00']);
    expect(hour(report, '13:00')).toMatchObject({ launches: 1, merged: 0, by_lane: { fast: { launches: 1 } } });
    expect(hour(report, '14:00').launches).toBe(2);
  });
  it('puts midnight in the new day and follows the clock offset it is given', () => {
    expect(report.daily.map(day => [day.start, day.merged])).toEqual([['2026-11-17T00:00:00.000Z', 1], ['2026-11-18T00:00:00.000Z', 3]]);
    expect(report.daily[0]).toMatchObject({ median_ttm_s: 120, by_repo: { locus: { merged: 1, launches: 1, merged_per_launch: 1 } } });
    // Five hours west of UTC the day starts at 05:00Z, so the midnight merge belongs to the day before.
    expect(build(ledger(...ROWS), { utcOffsetMinutes: -300 }).daily.map(day => [day.start, day.merged])).toEqual([['2026-11-17T05:00:00.000Z', 2], ['2026-11-18T05:00:00.000Z', 2]]);
  });
  it('counts a job launched twice as two launches, two endings and one merged PR', () => {
    expect(hour(report, '14:00')).toMatchObject({ launches: 2, finished: 2, empty: 1, prs: 1, merged: 1, median_ttm_s: 600, merged_per_launch: 0.5 });
    expect(hour(report, '14:00').by_lane).toEqual({ work: { launches: 2, finished: 2, empty: 1, prs: 1, merged: 1, median_ttm_s: 600, merged_per_launch: 0.5 } });
    expect(hour(report, '14:00').by_repo.phantom).toMatchObject({ merged: 1 });
  });
  it('counts a merge with no time to merge and leaves its time, lane and rate unknown', () => {
    const last = hour(report, '15:00');
    expect(last).toMatchObject({ launches: 0, merged: 1, median_ttm_s: null, merged_per_launch: null });
    expect(last.by_lane).toEqual({ unknown: { ...ZERO, merged: 1 } });
    expect(report.totals).toMatchObject({ start: '2026-11-18T12:00:00.000Z', launches: 3, merged: 2, median_ttm_s: 600 });
  });
  it('reports an hour with no events as counted zeros with an unknown median', () => {
    expect(hour(report, '12:00')).toEqual({ start: '2026-11-18T12:00:00.000Z', ...ZERO, by_lane: {}, by_repo: {} });
  });
  it('says today against yesterday in plain words', () => {
    expect(report.compare.map(row => row.text)).toEqual([
      '3 merged today, 1 yesterday',
      'Median time from PR opened to merged: 7m 30s today, 2m 0s yesterday',
      'Merged PRs per 100 launches: 100 today, 100 yesterday',
      'Launches that ended with no change: 1 today, 0 yesterday',
      '3 launches today, 1 yesterday',
    ]);
    expect(report.compare[0]).toMatchObject({ number: 'merged', label: 'PRs merged', today: 3, yesterday: 1 });
    const text = fleetWorklogText(report);
    expect(text[0]).toBe('3 merged today, 1 yesterday.');
    expect(text).toContain('  work: 1 merged, 2 launches, 1 no change, 1 PRs opened, median 10m 0s, 50 merged per 100 launches');
    expect(fleetWorklogText({ ...report, by: 'day' })).toContain('By day (UTC start):');
  });
  it('keeps an empty window as zeros, hours before the first record as unknown, and an unreadable file as unknown', () => {
    const quiet = build(ledger({ event: 'launch', job: 'past', lane: 'work', ts: '2026-11-10T10:00:00Z' }));
    expect(quiet.known).toBe(true);
    expect(quiet.totals).toEqual({ start: '2026-11-18T12:00:00.000Z', ...ZERO, by_lane: {}, by_repo: {} });
    expect(quiet.compare[0]!.text).toBe('0 merged today, 0 yesterday');
    expect(build('').daily.at(-1)).toMatchObject(ZERO);
    // The file starts at 14:00 today, so yesterday and the earlier hours were never recorded.
    const young = build(ledger(...ROWS.slice(4)));
    expect(hour(young, '13:00')).toMatchObject(NONE);
    expect(hour(young, '14:00').launches).toBe(2);
    expect(young.compare[0]!.text).toBe('2 merged today, unknown yesterday');
    expect(fleetWorklogText(young)).toContain('  2026-11-18 13:00: unknown (not recorded)');
    const unreadable = build(null);
    expect(unreadable).toMatchObject({ known: false, malformed_lines: null, totals: NONE });
    expect(unreadable.hourly.every(row => row.merged === null)).toBe(true);
    expect(fleetWorklogText(unreadable)).toEqual(['Work log: unknown (cannot read the job metrics file).']);
    expect(build('not json\n' + ledger(...ROWS)).malformed_lines).toBe(1);
  });

});

describe('phm fleet worklog', () => {
  const dirs: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function runsDir(text: string | null) {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-worklog-'));
    dirs.push(dir); await mkdir(join(dir, 'metrics'));
    if (text !== null) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), text);
    return dir;
  }
  it('prints the typed JSON shape and passes the options to the reader', async () => {
    const out: string[] = [];
    const read = vi.fn(async (opts: { hours?: number; by?: 'hour' | 'day' } = {}) => build(ledger(...ROWS), opts));
    expect(await cmdFleetWorklog(['--json', '--hours', '2', '--by', 'day'], read, line => out.push(line))).toBe(0);
    expect(read).toHaveBeenCalledWith({ hours: 2, by: 'day' });
    const report = JSON.parse(out[0]!) as FleetWorklogReport;
    expect(Object.keys(report)).toEqual(['schema', 'as_of', 'hours', 'by', 'known', 'malformed_lines', 'hourly', 'daily', 'totals', 'compare']);
    expect(report).toMatchObject({ schema: 'fleet.worklog.v1', as_of: '2026-11-18T15:20:00.000Z', hours: 2, by: 'day', known: true, malformed_lines: 0 });
    expect(report.hourly).toHaveLength(2);
    expect(Object.keys(report.hourly[0]!)).toEqual(['start', 'launches', 'finished', 'empty', 'prs', 'merged', 'median_ttm_s', 'merged_per_launch', 'by_lane', 'by_repo']);
    expect(Object.keys(report.compare[0]!)).toEqual(['number', 'label', 'today', 'yesterday', 'text']);
  });
  it('prints plain words by default, exits 1 when the file is unreadable and 2 on a bad option', async () => {
    const out: string[] = [];
    expect(await cmdFleetWorklog([], async () => build(ledger(...ROWS)), line => out.push(line))).toBe(0);
    expect(out[0]).toMatch(/^3 merged today, 1 yesterday\.\n/);
    expect(await cmdFleetWorklog(['--json'], async () => build(null), () => {})).toBe(1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn();
    for (const args of [['--hours', '0'], ['--hours', '169'], ['--hours', '6h'], ['--by', 'week'], ['--hours'], ['--lane', 'work']]) expect(await cmdFleetWorklog(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(6);
    expect(worklogOptions('168', 'day')).toEqual({ hours: 168, by: 'day' });
    expect(await cmdFleetWorklog(['--help'], read, line => out.push(line))).toBe(0);
    expect(out.at(-1)).toContain('Usage: phm fleet worklog [--hours 24] [--by hour|day] [--json]');
  });
  it('is registered as a fleet verb and reads the job metrics file from the runs directory', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['worklog']!()).cmdFleetWorklog).toBe(cmdFleetWorklog);
    expect((await readFleetWorklog({ runsDir: await runsDir(ledger(...ROWS)), now: NOW, hours: 4 })).totals.merged).toBe(2);
    expect((await readFleetWorklog({ runsDir: await runsDir(null), now: NOW })).known).toBe(false);
  });
  it('serves the same report from GET /api/fleet/worklog and rejects bad options', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', await runsDir(ledger(...ROWS)));
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const request = async (query: string) => {
      const result = { status: 0, body: '' };
      const res = { writeHead: (status: number) => { result.status = status; }, end: (body: string) => { result.body = body; } } as unknown as ServerResponse;
      expect(await handleApi({ method: 'GET', url: `/api/fleet/worklog${query}`, headers: {} } as IncomingMessage, res, { roots: [], tools: {} } as unknown as AshlrConfig, { token: 'unused', allowDispatch: false })).toBe(true);
      return { status: result.status, body: JSON.parse(result.body) as FleetWorklogReport };
    };
    try {
      expect(await request('?hours=4&by=day')).toMatchObject({ status: 200, body: { schema: 'fleet.worklog.v1', hours: 4, by: 'day', known: true, totals: { merged: 2, launches: 3 } } });
      expect([(await request('?hours=0')).status, (await request('?by=week')).status]).toEqual([400, 400]);
    } finally { vi.useRealTimers(); }
  });
});
