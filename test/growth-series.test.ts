import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdGrowth } from '../src/cli/growth.js';
import { handleGrowthApi } from '../src/core/verse/growth-api.js';
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
