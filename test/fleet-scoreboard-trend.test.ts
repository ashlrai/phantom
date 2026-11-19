import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { cmdFleetScore } from '../src/cli/fleet-score.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { trendJobsFromLedger } from '../src/core/fleet/scoreboard.js';
import { buildTrend, sparkText, trendSentence, trendWindow, TREND_SCHEMA, type TrendJob, type TrendReading } from '../src/core/fleet/scoreboard-trend.js';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * H).toISOString();
const job = (over: Partial<TrendJob> & { job: string }): TrendJob =>
  ({ lane: 'work', tier: 'work', started: null, finished: null, empty: null, merged: false, published_at: null, merged_at: null, ...over });
const reading = (pool: string, used_pct: number, hours: number): TrendReading => ({ pool, used_pct, observed_at: ago(hours) });
const series = (report: ReturnType<typeof buildTrend>, key: string) => [...report.metrics, ...report.pools].find(s => s.key === key)!;
const run = (jobs: TrendJob[], usage: TrendReading[] = [], window: '24h' | '7d' = '24h') => buildTrend({ jobs, usage, window, now: NOW });

describe('buildTrend', () => {
  it('gives 24 hourly and 28 six-hourly buckets', () => {
    expect(run([]).bucket_starts).toHaveLength(24);
    expect(run([], [], '7d').bucket_starts).toHaveLength(28);
    expect(run([]).schema).toBe(TREND_SCHEMA);
  });

  it('reads normal data: counts, shares, median minutes and a plain change', () => {
    const report = run([
      job({ job: 'a1', started: ago(20), finished: ago(19.5), published_at: ago(19.4), merged: true, merged_at: ago(19), empty: false }),
      job({ job: 'b1', started: ago(2.8), finished: ago(2.5), empty: true }),
      job({ job: 'c1', started: ago(2.6), finished: ago(2.4), published_at: ago(2.3), merged: true, merged_at: ago(2.1), empty: false }),
      job({ job: 'd1', started: ago(2.7), published_at: ago(2.2), merged: true, merged_at: ago(1.2) }),
    ]);
    const merged = series(report, 'merged');
    expect(merged.values.reduce((sum, v) => sum + (v ?? 0), 0)).toBe(3);
    expect(series(report, 'starts').values[21]).toBe(3);
    expect(series(report, 'merge_share').values[21]).toBeCloseTo(2 / 3);
    expect(series(report, 'empty_share').values[21]).toBeCloseTo(1 / 2);
    expect(series(report, 'median_minutes_to_merge').values[5]).toBe(24);
    expect(merged.latest).toBe(1);
    expect(merged.change).toMatchObject({ from: 0, to: 1, delta: 1, direction: 'up', words: 'up 1 from yesterday' });
    expect(series(run([], [reading('x', 5, 9), reading('x', 5, 2)]), 'pool:x').change).toMatchObject({ direction: 'flat', words: 'no change from yesterday' });
    expect(series(report, 'starts').change.words).toBe('down 1 from yesterday');
    expect(series(report, 'merge_share').change.words).toBe('down 33.3 points from yesterday');
    expect(series(report, 'merge_share').summary).toContain('latest 66.7%');
  });

  it('says so for an empty window: every value null, no pools, no claim', () => {
    const report = run([], []);
    for (const s of report.metrics) { expect(s.values.every(v => v === null)).toBe(true); expect(s.latest).toBeNull(); expect(s.change.direction).toBeNull(); expect(s.summary).toContain('no data'); }
    expect(report.pools).toEqual([]);
    expect(report.sentence).toContain('not enough data');
  });

  it('keeps a bucket with no jobs null, never zero and never carried forward', () => {
    const report = run([job({ job: 'a1', started: ago(10.5) }), job({ job: 'b1', started: ago(4.5) })]);
    const starts = series(report, 'starts').values;
    expect(starts[13]).toBe(1);
    expect(starts.slice(14, 19)).toEqual([null, null, null, null, null]);
    expect(starts[19]).toBe(1);
    // A bucket with starts and no merges is a real zero; its share of empties has nothing finished, so null.
    expect(series(report, 'merged').values[13]).toBe(0);
    expect(series(report, 'empty_share').values[13]).toBeNull();
    expect(series(report, 'median_minutes_to_merge').values[13]).toBeNull();
  });

  it('marks a pool reset mid-window and compares only from the reset on', () => {
    const report = run([], [reading('claude', 40, 20), reading('claude', 70, 12), reading('claude', 5, 6), reading('claude', 9, 1)]);
    const pool = series(report, 'pool:claude');
    expect(pool.values[4]).toBe(40);
    expect(pool.values[18]).toBe(5);
    expect(pool.values.filter(v => v !== null)).toHaveLength(4);
    expect(pool.values[5]).toBeNull();
    expect(pool.resets).toEqual([18]);
    expect(pool.change).toMatchObject({ from: 5, to: 9, delta: 4, words: 'up 4 points from yesterday' });
    expect(pool.summary).toContain('reset at');
    expect(sparkText(pool)).toContain('↺');
  });

  it('marks a reset against a reading from before the window', () => {
    const pool = series(run([], [reading('codex', 90, 30), reading('codex', 3, 5)]), 'pool:codex');
    expect(pool.resets).toEqual([19]);
  });

  it('shows one reading as one value with nothing to compare', () => {
    const pool = series(run([], [reading('grok', 12, 3)]), 'pool:grok');
    expect(pool.values.filter(v => v !== null)).toEqual([12]);
    expect(pool.latest).toBe(12);
    expect(pool.change).toMatchObject({ delta: null, direction: null, words: 'nothing earlier to compare with' });
  });

  it('counts a job that spans a bucket edge once, where it started, and its merge where it merged', () => {
    const edge = Date.parse('2026-11-18T11:00:00Z');
    const report = run([job({ job: 'a1', started: new Date(edge - 5 * 60_000).toISOString(), finished: new Date(edge + 5 * 60_000).toISOString(),
      empty: false, published_at: new Date(edge + 6 * 60_000).toISOString(), merged: true, merged_at: new Date(edge + 36 * 60_000).toISOString() })]);
    const startsAt = series(report, 'starts').values, mergedAt = series(report, 'merged').values;
    expect(startsAt.reduce((sum, v) => sum + (v ?? 0), 0)).toBe(1);
    expect(startsAt[22]).toBe(1);
    expect(mergedAt[23]).toBe(1);
    expect(mergedAt[22]).toBe(0);
    expect(series(report, 'merge_share').values[22]).toBe(1);
    expect(series(report, 'median_minutes_to_merge').values[23]).toBe(30);
    expect(series(report, 'merge_share').values[23]).toBeNull();
  });

  it('names what improved most and what worsened most', () => {
    const jobs = [job({ job: 'a1', started: ago(23.5), finished: ago(23), empty: false }), job({ job: 'b1', started: ago(0.5), finished: ago(0.2), empty: true }),
      job({ job: 'c1', started: ago(0.4), finished: ago(0.3), empty: true })];
    const report = run(jobs);
    expect(report.sentence).toMatch(/^.+ improved most and starts that ended empty \(up 100 points from yesterday\) worsened most\.$/);
    expect(trendSentence([])).toContain('not enough data');
  });
});

describe('trendWindow and the ledger reader', () => {
  it('accepts only 24h and 7d', () => {
    expect([trendWindow('24h'), trendWindow('7d'), trendWindow('30d'), trendWindow(''), trendWindow(null)]).toEqual(['24h', '7d', null, null, null]);
  });
  it('folds ledger rows into one record per job', () => {
    const row = (value: Record<string, unknown>) => JSON.stringify(value);
    const url = 'https://github.com/ashlrai/phantom/pull/9';
    const jobs = trendJobsFromLedger([
      row({ event: 'launch', job: 'a1', lane: 'work', tier: 'work', ts: ago(5) }), row({ event: 'launch', job: 'a1', ts: ago(5) }),
      row({ event: 'publish', job: 'a1', url, ts: ago(4) }), row({ event: 'finish', job: 'a1', empty: false, ts: ago(4.5) }),
      row({ event: 'outcome', state: 'MERGED', url, ts: ago(3) }),
    ].join('\n'), NOW, 24);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job: 'a1', lane: 'work', tier: 'work', empty: false, merged: true, started: ago(5), published_at: ago(4), merged_at: ago(3) });
  });
});

describe('phm fleet score --trend and the scoreboard route', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trend-'));
    await mkdir(join(dir, 'metrics'));
    const rows = [{ event: 'launch', job: 'a1', lane: 'work', ts: ago(3) }, { event: 'publish', job: 'a1', url: 'https://github.com/ashlrai/phantom/pull/1', ts: ago(2) },
      { event: 'outcome', state: 'MERGED', job: 'a1', url: 'https://github.com/ashlrai/phantom/pull/1', ts: ago(1) }];
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
    await writeFile(join(dir, 'metrics', 'usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', v: 1, rows: [
      { pool: 'claude', used_pct: 30, observed_at: ago(5), reset_at: null, source: null }, { pool: 'claude', used_pct: 35, observed_at: ago(1), reset_at: null, source: null }] }));
    return dir;
  };
  const cli = async (dir: string, args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetScore([...args, '--runs-dir', dir], { now: () => NOW, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('adds the trend to the JSON for both windows, with the same shape', async () => {
    const dir = await setup();
    for (const [window, buckets, hours] of [['24h', 24, 1], ['7d', 28, 6]] as const) {
      const { code, out } = await cli(dir, ['--json', '--trend', window]);
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(Object.keys(json)).toEqual(['schema', 'as_of', 'days', 'metrics', 'hourly', 'daily', 'trend']);
      expect(Object.keys(json.trend)).toEqual(['schema', 'window', 'bucket_hours', 'from', 'to', 'bucket_starts', 'metrics', 'pools', 'sentence']);
      expect(json.trend).toMatchObject({ schema: TREND_SCHEMA, window, bucket_hours: hours });
      expect(json.trend.metrics.map((m: { key: string }) => m.key)).toEqual(['merged', 'starts', 'merge_share', 'empty_share', 'median_minutes_to_merge', ]);
      expect(Object.keys(json.trend.metrics[0])).toEqual(['key', 'label', 'unit', 'better', 'values', 'resets', 'latest', 'change', 'summary']);
      expect(Object.keys(json.trend.metrics[0].change)).toEqual(['from', 'to', 'delta', 'direction', 'words']);
      expect(json.trend.metrics[0].values).toHaveLength(buckets);
      expect(json.trend.pools.map((p: { key: string }) => p.key)).toEqual(['pool:claude']);
    }
  });
  it('leaves the trend out of the JSON unless asked, and opens the text with the sentence', async () => {
    const dir = await setup();
    expect(JSON.parse((await cli(dir, ['--json'])).out).trend).toBeUndefined();
    const text = (await cli(dir, [])).out.split('\n');
    expect(text[0]).toMatch(/^(Nothing has clearly moved|.+ (improved|worsened) most)/);
    expect(text.some(line => line.startsWith('Trends: Last 24 hours'))).toBe(true);
    expect(text.some(line => line.includes('PRs merged: 1'))).toBe(true);
  });
  it('rejects a bad window', async () => {
    const dir = await setup();
    const bad = await cli(dir, ['--trend', '30d']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--trend takes 24h or 7d');
  });
  it('serves the same trend over the route and rejects a bad window', async () => {
    const dir = await setup();
    const api = createFleetRunsApi({ runsDir: dir, now: () => NOW });
    const path = '/api/verse/fleet/runs/scoreboard';
    const call = async (query: string) => {
      const req = Readable.from([]) as unknown as IncomingMessage;
      req.url = path + query; req.method = 'GET'; req.headers = {};
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, 'GET');
      return { status, body };
    };
    const { out } = await cli(dir, ['--json', '--trend', '7d']);
    expect(await call('?trend=7d')).toEqual({ status: 200, body: JSON.parse(out) });
    expect((await call('?trend=1y')).status).toBe(400);
    expect(((await call('')).body as { trend?: unknown }).trend).toBeUndefined();
  });
});
