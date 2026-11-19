import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { buildScoreboard, scoreboardDays, SCORE_KEYS, SCOREBOARD_SCHEMA, trendOf } from '../src/core/fleet/scoreboard.js';
import { cmdFleetScore } from '../src/cli/fleet-score.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const H = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const row = (value: Record<string, unknown>) => JSON.stringify(value);
const launch = (job: string, ago: number, repo = 'phantom') => row({ event: 'launch', job, repo, lane: 'work', ts: at(ago) });
const finish = (job: string, ago: number, empty = false) => row({ event: 'finish', job, empty, ts: at(ago) });
const publish = (job: string, ago: number, pr: number, repo = 'ashlrai/phantom') =>
  row({ event: 'publish', job, url: `https://github.com/${repo}/pull/${pr}`, ts: at(ago) });
const merged = (job: string, ago: number, pr: number, repo = 'ashlrai/phantom', ttm?: number) =>
  row({ event: 'outcome', state: 'MERGED', job, url: `https://github.com/${repo}/pull/${pr}`, ts: at(ago), ...(ttm === undefined ? {} : { ttm_s: ttm }) });
const board = (rows: string[], days = 7) => buildScoreboard({ ledger: rows.join('\n'), now: NOW, days });

describe('buildScoreboard', () => {
  it('reads a steady day: merges, starts, empties, ratios and the phantom share', () => {
    // Four jobs a few hours apart: three merge (two in phantom), one finishes empty.
    const result = board([
      launch('a1', 10), finish('a1', 9.5), publish('a1', 9.4, 1), merged('a1', 9, 1, 'ashlrai/phantom', 600),
      launch('b1', 6), finish('b1', 5.5), publish('b1', 5.4, 2), merged('b1', 5, 2, 'ashlrai/phantom', 300),
      launch('c1', 3), finish('c1', 2.5), publish('c1', 2.4, 3, 'ashlrai/locus'), merged('c1', 2, 3, 'ashlrai/locus', 900),
      launch('d1', 1), finish('d1', 0.8, true),
    ]);
    expect(board([]).schema).toBe(SCOREBOARD_SCHEMA);
    const day = result.hourly.current;
    expect(day).toMatchObject({ merged: 3, starts: 4, finishes: 4, empty_finishes: 1, median_ttm_s: 600, merged_per_start: 0.75, empty_share: 0.25 });
    expect(day.self_improvement_share).toBeCloseTo(2 / 3);
    expect(result.hourly.points).toHaveLength(24);
    expect(result.hourly.points.reduce((sum, p) => sum + (p.merged ?? 0), 0)).toBe(3);
    // Nothing happened before the window, so there is nothing to compare against.
    expect(result.hourly.trend.merged).toBe('unknown');
  });

  it('gives an hour with starts and no merges a zero, not a null, and no median', () => {
    const result = board([launch('a1', 0.4), launch('a2', 0.3)]);
    const last = result.hourly.points[23]!;
    expect(last).toMatchObject({ merged: 0, starts: 2, merged_per_start: 0, median_ttm_s: null, self_improvement_share: null, empty_share: null });
  });

  it('keeps a window with no data null and its trend unknown', () => {
    const result = board([]);
    for (const series of [result.hourly, result.daily]) {
      for (const point of [...series.points, series.current, series.previous]) {
        for (const key of [...SCORE_KEYS, 'finishes'] as const) expect(point[key]).toBeNull();
      }
      for (const key of SCORE_KEYS) expect(series.trend[key]).toBe('unknown');
    }
    expect(result.metrics).toBe('ok');
    expect(buildScoreboard({ ledger: null, now: NOW, days: 7 }).metrics).toBe('unreadable');
  });

  it('counts a merged PR with no time to merge but leaves it out of the median', () => {
    const result = board([launch('a1', 3), merged('a1', 2, 1, 'ashlrai/phantom'), launch('b1', 3), merged('b1', 2, 2, 'ashlrai/phantom', 120)]);
    expect(result.hourly.current).toMatchObject({ merged: 2, median_ttm_s: 120 });
    const none = board([launch('a1', 3), merged('a1', 2, 1)]);
    expect(none.hourly.current).toMatchObject({ merged: 1, median_ttm_s: null });
  });

  it('counts a re-emitted merge once and takes the repo from the launch when the outcome has none', () => {
    const bare = row({ event: 'outcome', state: 'MERGED', job: 'a1', ts: at(2), ttm_s: 50 });
    const result = board([launch('a1', 3, 'phantom'), bare, bare, launch('b1', 3, 'locus'), row({ event: 'merged', job: 'b1', ts: at(1) })]);
    expect(result.hourly.current).toMatchObject({ merged: 2, self_improvement_share: 0.5 });
  });

  it('rolls seven days up across a day boundary and compares with the week before', () => {
    // 36 h ago and 12 h ago fall in different days; 8 days ago falls in the week before.
    const result = board([
      launch('a1', 36), merged('a1', 35, 1), launch('b1', 12), merged('b1', 11, 2, 'ashlrai/locus'), merged('b1', 10, 3, 'ashlrai/locus'),
      launch('p1', 8 * 24), merged('p1', 8 * 24 - 1, 9), launch('p2', 8 * 24), launch('p3', 8 * 24),
    ]);
    const { points, current, previous, trend } = result.daily;
    expect(points).toHaveLength(7);
    // Rolling days end now: day 6 is the last 24 h, day 5 the 24 h before it.
    expect(points[6]!.merged).toBe(2);
    expect(points[5]!.merged).toBe(1);
    expect(points.slice(0, 5).every(p => p.merged === null)).toBe(true);
    expect(current).toMatchObject({ merged: 3, starts: 2 });
    expect(previous).toMatchObject({ merged: 1, starts: 3 });
    expect(trend.merged).toBe('up');
    expect(trend.merged_per_start).toBe('up');
    expect(trend.starts).toBe('down');
  });
});

describe('trendOf and scoreboardDays', () => {
  it('reads up, down, flat and unknown', () => {
    expect(trendOf(3, 1)).toBe('up');
    expect(trendOf(1, 3)).toBe('down');
    expect(trendOf(100, 102)).toBe('flat');
    expect(trendOf(0, 0)).toBe('flat');
    expect(trendOf(2, 0)).toBe('up');
    expect(trendOf(null, 2)).toBe('unknown');
    expect(trendOf(2, null)).toBe('unknown');
  });
  it('takes 1 to 30 whole days, 7 by default', () => {
    expect(scoreboardDays()).toBe(7);
    expect(scoreboardDays('30')).toBe(30);
    for (const bad of ['0', '31', '1.5', '-1', 'x']) expect(scoreboardDays(bad)).toBeNull();
  });
});

describe('phm fleet score', () => {
  const run = async (args: string[], files?: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'score-'));
    if (files !== undefined) { await mkdir(join(dir, 'metrics')); await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files); }
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetScore([...args, '--runs-dir', dir], { now: () => NOW, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('prints the fleet.scoreboard.v1 JSON shape', async () => {
    const { code, out } = await run(['--json', '--days', '3'], [launch('a1', 2), merged('a1', 1, 1, 'ashlrai/phantom', 60)].join('\n'));
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(Object.keys(json)).toEqual(['schema', 'as_of', 'days', 'metrics', 'hourly', 'daily']);
    expect(json).toMatchObject({ schema: 'fleet.scoreboard.v1', days: 3, metrics: 'ok' });
    expect(json.hourly.points).toHaveLength(24);
    expect(json.daily.points).toHaveLength(3);
    expect(Object.keys(json.hourly)).toEqual(['span', 'points', 'current', 'previous', 'trend']);
    expect(Object.keys(json.hourly.current)).toEqual(['start', 'end', 'merged', 'median_ttm_s', 'starts', 'finishes', 'empty_finishes', 'merged_per_start', 'empty_share', 'self_improvement_share']);
    expect(Object.keys(json.hourly.trend)).toEqual([...SCORE_KEYS]);
    expect(json.hourly.current.merged).toBe(1);
  });
  it('prints plain words with unknown for missing numbers, and fails on bad input or no file', async () => {
    const text = await run([], launch('a1', 2));
    expect(text.out).toContain('merged PRs: 0 (unknown)');
    expect(text.out).toContain('median time to merge: unknown');
    expect((await run([])).code).toBe(1);
    expect((await run(['--days', '99'], '')).code).toBe(2);
    expect((await run(['--nope'], '')).code).toBe(2);
    expect((await run(['--help'])).out).toContain('Usage: phm fleet score');
  });
  it('is registered as a fleet verb', async () => {
    expect(resolveFleetSubcommand('score')).toEqual({ module: './fleet-score.js', exportName: 'cmdFleetScore' });
    expect(Object.keys((await FLEET_SUBCOMMAND_LOADERS.score!())).includes('cmdFleetScore')).toBe(true);
  });
});

describe('GET /api/verse/fleet/runs/scoreboard', () => {
  it('serves the same report as the CLI, rejects a bad days value and non-GET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'score-api-'));
    await mkdir(join(dir, 'metrics'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), [launch('a1', 2), merged('a1', 1, 1)].join('\n'));
    const api = createFleetRunsApi({ runsDir: dir, now: () => NOW });
    const path = '/api/verse/fleet/runs/scoreboard';
    const call = async (query: string, method = 'GET') => {
      const req = Readable.from([]) as unknown as IncomingMessage;
      req.url = path + query; req.method = method; req.headers = {};
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    const out: string[] = [];
    await cmdFleetScore(['--json', '--days', '3', '--runs-dir', dir], { now: () => NOW, out: l => out.push(l) });
    expect(await call('?days=3')).toEqual({ status: 200, body: JSON.parse(out[0]!) });
    expect((await call('')).body).toMatchObject({ days: 7 });
    expect((await call('?days=99')).status).toBe(400);
    expect((await call('', 'POST')).status).toBe(405);
  });
});
