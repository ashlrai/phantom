import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdGrowth } from '../src/cli/growth.js';
import { GROWTH_METRICS_MAX_BYTES, readGrowthJsonl, readGrowthReport } from '../src/core/growth/read.js';
import { handleGrowthApi } from '../src/core/verse/growth-api.js';
import { readJsonFile } from '../src/core/observe/read.js';
import { projectWorldModel } from '../src/core/world/project.js';
import {
  growthSnapshot,
  projectGrowthSeries,
  type GrowthFacts,
  type GrowthPull,
  type GrowthSeries,
} from '../src/core/growth/series.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function facts(over: Partial<GrowthFacts> = {}): GrowthFacts {
  return {
    nowMs: NOW,
    jobsText: null,
    usageText: null,
    pulls: null,
    pullsComplete: false,
    scorecard7d: null,
    scorecard30d: null,
    ...over,
  };
}

function pull(over: Partial<GrowthPull> = {}): GrowthPull {
  return {
    state: 'merged',
    createdAt: '2026-11-09T11:07:00.000Z',
    mergedAt: '2026-11-09T11:20:00.000Z',
    ...over,
  };
}

function merged(job: string, ts: string, url?: string): string {
  return JSON.stringify({ event: 'outcome', state: 'MERGED', job, ts, ...(url ? { url } : {}) });
}

function series(report: ReturnType<typeof projectGrowthSeries>, id: string): GrowthSeries {
  const row = report.series.find((item) => item.id === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
}

describe('growth.series.v1', () => {
  it('keeps a missing ledger as no data source and a world-model blind spot', () => {
    const report = projectGrowthSeries(facts(), '1H');
    expect(report.schema).toBe('growth.series.v1');
    expect(report.readOnly).toBe(true);
    const merges = series(report, 'mergesPerHour');
    expect(merges.status).toBe('no-data-source');
    expect(merges.reason).toBe('no data source');
    expect(merges.points).toEqual([]);
    expect(report.blindSpots.map((spot) => spot.path)).toEqual([
      'growth.bottleneckTrends',
      'growth.costPerMergedPr',
      'growth.laneUtilization',
      'growth.mergesPerHour',
      'growth.pullsMerged',
      'growth.pullsOpened',
      'growth.releases',
    ]);
    expect(report.blindSpots.find((spot) => spot.path === 'growth.releases')?.need).toContain('gh is not called');
    expect(report.blindSpots.find((spot) => spot.path === 'growth.bottleneckTrends')?.need).toContain('not a time series');
  });

  it('counts an empty jobs ledger as real zeros and one merge as an hourly rate', () => {
    const empty = series(projectGrowthSeries(facts({ jobsText: '' }), '1H'), 'mergesPerHour');
    expect(empty.status).toBe('ready');
    expect(empty.points).toHaveLength(12);
    expect(empty.points.every((point) => point.y === 0)).toBe(true);

    const job = 'sk-live-do-not-print';
    const text = [
      merged(job, '2026-11-09T11:02:00.000Z', 'https://github.com/ashlrai/phantom/pull/9'),
      merged(job, '2026-11-09T11:07:00.000Z', 'https://github.com/ashlrai/phantom/pull/9'),
      '{not json',
    ].join('\n');
    const report = projectGrowthSeries(facts({ jobsText: text }), '1H');
    const merges = series(report, 'mergesPerHour');
    expect(merges.caveat).toContain('lower bound');
    expect(merges.points.find((point) => point.t === '2026-11-09T11:05:00.000Z')?.y).toBe(12);
    expect(merges.points.find((point) => point.t === '2026-11-09T11:00:00.000Z')?.y).toBe(0);
    expect(JSON.stringify(report)).not.toContain(job);
    expect(report.blindSpots.some((spot) => spot.path === 'growth.mergesPerHour')).toBe(false);
    const mergedPulls = series(report, 'pullsMerged');
    expect(mergedPulls.status).toBe('ready');
    expect(mergedPulls.points.find((point) => point.t === '2026-11-09T11:05:00.000Z')?.y).toBe(1);
    expect(series(report, 'pullsOpened').status).toBe('no-data-source');
  });

  it('buckets a complete pull export and ignores a truncated one', () => {
    const complete = projectGrowthSeries(facts({ pulls: [pull()], pullsComplete: true }), '1H');
    expect(series(complete, 'pullsOpened').points.find((point) => point.t === '2026-11-09T11:05:00.000Z')?.y).toBe(1);
    expect(series(complete, 'pullsMerged').points.find((point) => point.t === '2026-11-09T11:20:00.000Z')?.y).toBe(1);
    expect(series(complete, 'pullsMerged').source).toBe('pull-export');
    const truncated = projectGrowthSeries(facts({ pulls: [pull()], pullsComplete: false }), '1H');
    expect(series(truncated, 'pullsOpened').status).toBe('no-data-source');
    expect(series(truncated, 'pullsMerged').status).toBe('no-data-source');
  });

  it('leaves utilization gaps null and refuses to stretch daily cost into an hour', () => {
    const usage = JSON.stringify({ pool: 'claude-max', pctUsed: 40, observedAt: '2026-11-09T11:07:00.000Z' });
    const report = projectGrowthSeries(facts({ usageText: usage }), '1H');
    const lane = series(report, 'laneUtilization');
    expect(lane.points.find((point) => point.t === '2026-11-09T11:05:00.000Z')?.y).toBe(40);
    expect(lane.points.find((point) => point.t === '2026-11-09T11:00:00.000Z')?.y).toBeNull();

    const cost = { sourceState: 'healthy' as const, points: [{ ts: '2026-11-08T15:00:00.000Z', costPerMergedChangeUsd: 4.5 }] };
    const week = projectGrowthSeries(facts({ scorecard7d: cost, scorecard30d: cost }), '1W');
    expect(series(week, 'costPerMergedPr').status).toBe('ready');
    expect(series(week, 'costPerMergedPr').points.some((point) => point.y === 4.5)).toBe(true);
    const hour = projectGrowthSeries(facts({ scorecard7d: cost, scorecard30d: cost }), '1H');
    expect(series(hour, 'costPerMergedPr').reason).toBe('no data source');
    expect(hour.blindSpots.some((spot) => spot.path === 'growth.costPerMergedPr')).toBe(false);
    expect(series(hour, 'releases').reason).toBe('no data source');
  });

  it('publishes fresh zeros and unknown growth fields onto the world model', () => {
    const snap = growthSnapshot(facts({ jobsText: '' }));
    expect(snap.mergesPerHour).toBe(0);
    expect(snap.releases).toBeNull();
    const model = projectWorldModel({
      nowMs: NOW,
      sensors: null,
      roster: null,
      claims: null,
      busReadable: null,
      queue: null,
      ci: null,
      updatePhase: null,
      bottlenecks: null,
      bottlenecksObservedAt: null,
      stepsRemaining: null,
      stepsObservedAt: null,
      outcomes: null,
      growth: snap,
    });
    expect(model.growth.mergesPerHour).toMatchObject({ value: 0, freshness: 'fresh', source: 'growth.series.v1' });
    expect(model.growth.releases).toMatchObject({ value: null, freshness: 'unknown' });
    expect(model.blindSpots.find((spot) => spot.path === 'growth.releases')?.id).toBe('growth-releases');
    expect(model.blindSpots.some((spot) => spot.path === 'growth.mergesPerHour')).toBe(false);
  });
});

describe('phm growth', () => {
  it('prints the series as json and rejects a bad range', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdGrowth(['--json', '--range', '1D'])).toBe(0);
      const body = JSON.parse(lines.join('\n')) as { schema: string; range: string; series: { id: string; status: string }[] };
      expect(body.schema).toBe('growth.series.v1');
      expect(body.range).toBe('1D');
      expect(body.series.find((item) => item.id === 'releases')?.status).toBe('no-data-source');
      expect(await cmdGrowth(['--range', '2Y'])).toBe(2);
      expect(await cmdGrowth(['--prs', 'relative.json'])).toBe(2);
      expect(await cmdGrowth(['--prs', '/tmp/phantom-growth-missing-prs.json', '--json'])).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('engineering ops growth exports', () => {
  const clock = '2026-11-09T11:50:00.000Z';
  const pulls = JSON.stringify({
    complete: true,
    pulls: [{ repo: 'ashlrai/phantom', number: 9, state: 'open', createdAt: '2026-11-09T11:07:00.000Z' }],
  });
  const hourly = JSON.stringify({ hour: '2026-11-09T08:00:00.000Z', opened: 4, merged: 2 });
  const releases = [
    JSON.stringify({ publishedAt: '2026-11-09T11:07:00.000Z', kind: 'github' }),
    JSON.stringify({ publishedAt: '2026-11-09T11:08:00.000Z', kind: 'npm' }),
  ].join('\n');
  const cost = [
    JSON.stringify({ t: '2026-11-09T11:07:00.000Z', costPerMergedPrUsd: 3.5 }),
    JSON.stringify({ t: '2026-11-09T11:00:00.000Z', costPerMergedPrUsd: null }),
  ].join('\n');

  async function withDir(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'growth-exports-'));
    try {
      for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads releases, metered hourly cost, and the 1d pull export', async () => {
    await withDir({
      'growth-pulls-1d.json': pulls,
      'growth-pulls-hourly.jsonl': hourly,
      'growth-releases.jsonl': releases,
      'growth-cost-hourly.jsonl': cost,
      'growth-exports-status.json': JSON.stringify({ generatedAt: clock }),
    }, async (dir) => {
      const day = await readGrowthReport({
        range: '1D', metricsDir: dir, nowMs: NOW, jobsText: '', usageText: null,
        scorecard7d: { sourceState: 'healthy', points: [{ ts: clock, costPerMergedChangeUsd: 99 }] },
        scorecard30d: null,
      });
      expect(day).not.toBeNull();
      const opened = series(day!, 'pullsOpened');
      expect(opened.source).toBe('metrics/growth-pulls-1d.json');
      expect(opened.points.find((point) => point.t === '2026-11-09T11:00:00.000Z')?.y).toBe(1);
      expect(opened.freshness).toBe('fresh');
      const week = await readGrowthReport({
        range: '1W', metricsDir: dir, nowMs: NOW, jobsText: '', usageText: null, scorecard7d: null, scorecard30d: null,
      });
      const weekOpened = series(week!, 'pullsOpened');
      expect(weekOpened.source).toBe('metrics/growth-pulls-hourly.jsonl');
      expect(weekOpened.points.some((point) => point.y === 4)).toBe(true);
      const released = series(day!, 'releases');
      expect(released.points.find((point) => point.t === '2026-11-09T11:00:00.000Z')?.y).toBe(2);
      expect(released.points.find((point) => point.t === '2026-11-09T10:00:00.000Z')?.y).toBe(0);
      const priced = series(day!, 'costPerMergedPr');
      expect(priced.label).toBe('Cost · metered lanes');
      expect(priced.caveat).toContain('Metered lanes');
      expect(priced.points.find((point) => point.t === '2026-11-09T11:00:00.000Z')?.y).toBe(3.5);
      expect(priced.points.find((point) => point.t === '2026-11-09T10:00:00.000Z')?.y ?? null).toBeNull();
      expect(day!.blindSpots.some((spot) => spot.path === 'growth.pullsOpened')).toBe(false);
      expect(day!.blindSpots.some((spot) => spot.path === 'growth.releases')).toBe(false);
    });
  });

  it('marks an export older than 30 minutes stale and still draws it', async () => {
    await withDir({
      'growth-releases.jsonl': releases,
      'growth-exports-status.json': JSON.stringify({ generatedAt: '2026-11-09T11:00:00.000Z' }),
    }, async (dir) => {
      const report = await readGrowthReport({
        range: '1H', metricsDir: dir, nowMs: NOW, jobsText: null, usageText: null, scorecard7d: null, scorecard30d: null,
      });
      const released = series(report!, 'releases');
      expect(released.status).toBe('ready');
      expect(released.freshness).toBe('stale');
      expect(released.caveat).toContain('30 minutes');
      expect(released.points.some((point) => point.y === 2)).toBe(true);
      expect(report!.blindSpots.find((spot) => spot.path === 'growth.releases')).toMatchObject({ freshness: 'stale' });
      const model = projectWorldModel({
        nowMs: NOW, sensors: null, roster: null, claims: null, busReadable: null, queue: null, ci: null,
        updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null,
        outcomes: null, growth: growthSnapshot({
          nowMs: NOW, jobsText: null, usageText: null, pulls: null, pullsComplete: false,
          releases: [{ at: Date.parse('2026-11-09T11:07:00.000Z') }],
          exportClock: { pulls: null, releases: '2026-11-09T11:00:00.000Z', cost: null },
          scorecard7d: null, scorecard30d: null,
        }),
      });
      expect(model.growth.releases).toMatchObject({ value: null, freshness: 'stale' });
    });
  });

  it('reads a pull export larger than the 256 KiB observe cap', async () => {
    expect(GROWTH_METRICS_MAX_BYTES).toBeGreaterThan(1.24 * 1024 * 1024);
    await withDir({}, async (dir) => {
      const path = join(dir, 'wide.json');
      const body = `${pulls}${' '.repeat(300 * 1024)}`;
      await writeFile(path, body);
      expect(await readJsonFile(path)).toBeNull();
      const report = await readGrowthReport({
        range: '1D', pullsFile: path, metricsDir: dir, nowMs: NOW, jobsText: null, usageText: null,
        scorecard7d: null, scorecard30d: null,
        exportClock: { pulls: clock, releases: null, cost: null },
      });
      expect(series(report!, 'pullsOpened').status).toBe('ready');
      const tiny = join(dir, 'tiny.jsonl');
      await writeFile(tiny, '{"publishedAt":"2026-11-09T11:07:00.000Z"}\n{"publishedAt":"2026-11-09T11:08:00.000Z"}\n');
      expect(await readGrowthJsonl(tiny, 20)).toBeNull();
      expect((await readGrowthJsonl(tiny))?.length).toBe(2);
    });
  });
});

describe('GET /api/verse/growth', () => {
  it('rejects an unknown range and returns the series for 1D', async () => {
    const sent: { status: number; body: string }[] = [];
    const res = {
      writeHead(status: number) { sent.push({ status, body: '' }); },
      end(body?: string) { sent[sent.length - 1]!.body = body ?? ''; },
      headersSent: false,
    } as unknown as ServerResponse;
    await handleGrowthApi({ url: '/api/verse/growth?range=nope' } as IncomingMessage, res, '/api/verse/growth', 'GET');
    expect(sent[0]?.status).toBe(400);
    await handleGrowthApi({ url: '/api/verse/growth?range=1D' } as IncomingMessage, res, '/api/verse/growth', 'GET');
    expect(sent[1]?.status).toBe(200);
    expect(JSON.parse(sent[1]!.body).schema).toBe('growth.series.v1');
  });
});
