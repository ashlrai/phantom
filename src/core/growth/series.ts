/**
 * growth.series.v1 — the series the Growth charts and `phm growth --json` share.
 *
 * Every point is counted from a reading the caller already holds. A missing
 * file stays `no-data-source` with an empty point list. A ledger that was
 * read and contained no merges is a real zero. A null y is a gap, never a
 * fabricated zero. Daily scorecard snapshots are not stretched into an hour.
 */
import { stableFieldId } from '../world/types.js';

export const GROWTH_SCHEMA = 'growth.series.v1' as const;

export const GROWTH_RANGES = ['1H', '1D', '1W', '1M'] as const;
export type GrowthRange = (typeof GROWTH_RANGES)[number];

export const GROWTH_SERIES_IDS = [
  'mergesPerHour',
  'pullsOpened',
  'pullsMerged',
  'releases',
  'laneUtilization',
  'costPerMergedPr',
  'bottleneckTrends',
] as const;
export type GrowthSeriesId = (typeof GROWTH_SERIES_IDS)[number];

export type GrowthUnit = 'merges_per_hour' | 'count' | 'percent' | 'usd';

const RANGE_MS: Record<GrowthRange, number> = {
  '1H': 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000,
};

const BUCKET_MS: Record<GrowthRange, number> = {
  '1H': 5 * 60 * 1000,
  '1D': 60 * 60 * 1000,
  '1W': 24 * 60 * 60 * 1000,
  '1M': 24 * 60 * 60 * 1000,
};

export const GROWTH_FIELD_NEEDS: Record<string, string> = {
  'growth.mergesPerHour': 'metrics/jobs.jsonl rows with event outcome, state MERGED, job, and ts. A missing or oversized file stays unknown.',
  'growth.pullsOpened': 'metrics/growth-pulls-1d.json, or metrics/growth-pulls-hourly.jsonl for 1W and 1M. A complete pull export with createdAt. Fleet proposals are not opened pull requests.',
  'growth.pullsMerged': 'That same pull export, or metrics/jobs.jsonl MERGED rows whose url is a GitHub pull request.',
  'growth.releases': 'metrics/growth-releases.jsonl rows with publishedAt. gh is not called. releases.updateCheck is a phase, not a series.',
  'growth.laneUtilization': 'usage-readings.log rows with pool, pctUsed, and observedAt. A sensor snapshot is not a trend.',
  'growth.costPerMergedPr': 'metrics/growth-cost-hourly.jsonl costPerMergedPrUsd for metered lanes. Hours without a reading stay gaps. scorecard-history is only the daily fallback.',
  'growth.bottleneckTrends': 'bottlenecks.v1 items need a points series of timestamps and values. before/after is not a time series.',
};

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/;

export interface GrowthPull {
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt: string | null;
}

export interface GrowthScorecard {
  sourceState: 'healthy' | 'degraded';
  points: { ts: string; costPerMergedChangeUsd: number | null }[];
}

export const GROWTH_EXPORT_STALE_MS = 30 * 60 * 1000;

export interface GrowthHourCount {
  at: number;
  opened: number | null;
  merged: number | null;
}

export interface GrowthCostPoint {
  at: number;
  /** Null is a measured gap, not zero. */
  usd: number | null;
}

/** ISO times from growth-exports-status.json, else each file's mtime. */
export interface GrowthExportClock {
  pulls: string | null;
  releases: string | null;
  cost: string | null;
}

export type GrowthFreshness = 'fresh' | 'stale' | 'unknown';

export interface GrowthFacts {
  nowMs: number;
  /** null when metrics/jobs.jsonl is missing, unreadable, or over the size cap. */
  jobsText: string | null;
  /** null when no usage-readings.log could be read. */
  usageText: string | null;
  /** Complete pull export, usually growth-pulls-1d.json. */
  pulls: readonly GrowthPull[] | null;
  pullsComplete: boolean;
  /** Set when the daily rows came from the metrics export. */
  pullsSource?: string;
  /** Pull rows from growth-pulls-hourly.jsonl. Null when that file is not a pull list. */
  hourlyPulls?: readonly GrowthPull[] | null;
  hourlyPullsComplete?: boolean;
  /** Hourly opened/merged counts from growth-pulls-hourly.jsonl. */
  hourlyPullCounts?: readonly GrowthHourCount[] | null;
  /** publishedAt instants from growth-releases.jsonl. Null when the file was not read. */
  releases?: readonly { at: number }[] | null;
  /** Hourly metered cost. Null when growth-cost-hourly.jsonl was not read. */
  costHourly?: readonly GrowthCostPoint[] | null;
  exportClock?: GrowthExportClock | null;
  scorecard7d: GrowthScorecard | null;
  scorecard30d: GrowthScorecard | null;
}

export interface GrowthPoint {
  /** Bucket start, ISO-8601. */
  t: string;
  y: number | null;
}

export interface GrowthSeries {
  id: GrowthSeriesId;
  label: string;
  unit: GrowthUnit;
  source: string | null;
  status: 'ready' | 'no-data-source';
  /** Fresh when the export clock is within 30 minutes. Stale data is still drawn. */
  freshness: GrowthFreshness;
  /** `no data source` when this range cannot be drawn. Null when ready. */
  reason: 'no data source' | null;
  /** What would make a missing series visible. */
  need: string | null;
  caveat: string | null;
  points: GrowthPoint[];
}

export interface GrowthBlindSpot {
  id: string;
  path: string;
  freshness: 'unknown' | 'stale';
  need: string;
}

export interface GrowthReport {
  schema: typeof GROWTH_SCHEMA;
  generatedAt: string;
  readOnly: true;
  range: GrowthRange;
  ranges: readonly GrowthRange[];
  primaryId: GrowthSeriesId;
  series: GrowthSeries[];
  blindSpots: GrowthBlindSpot[];
}

export interface GrowthSnapshot {
  mergesPerHour: number | null;
  pullsOpened: number | null;
  pullsMerged: number | null;
  releases: number | null;
  laneUtilization: number | null;
  costPerMergedPr: number | null;
  bottleneckTrends: number | null;
  observedAt: string;
  freshness: Record<GrowthSeriesId, GrowthFreshness>;
}

interface Bucket { start: number; end: number }

export function isGrowthRange(value: string): value is GrowthRange {
  return (GROWTH_RANGES as readonly string[]).includes(value);
}

function bucketsFor(nowMs: number, range: GrowthRange): Bucket[] {
  const size = BUCKET_MS[range];
  const windowStart = nowMs - RANGE_MS[range];
  const first = Math.floor(windowStart / size) * size;
  const buckets: Bucket[] = [];
  for (let t = first; t < nowMs; t += size) {
    const start = Math.max(t, windowStart);
    const end = Math.min(t + size, nowMs);
    if (end > start) buckets.push({ start, end });
  }
  return buckets;
}

function contains(at: number, bucket: Bucket, nowMs: number): boolean {
  if (at < bucket.start || at > nowMs) return false;
  return bucket.end === nowMs ? at <= bucket.end : at < bucket.end;
}

function pointsFrom(buckets: Bucket[], value: (bucket: Bucket) => number | null): GrowthPoint[] {
  return buckets.map((bucket) => ({ t: new Date(bucket.start).toISOString(), y: value(bucket) }));
}

function unavailable(id: GrowthSeriesId, label: string, unit: GrowthUnit, source: string | null, need: string): GrowthSeries {
  return { id, label, unit, source, status: 'no-data-source', freshness: 'unknown', reason: 'no data source', need, caveat: null, points: [] };
}

function ready(id: GrowthSeriesId, label: string, unit: GrowthUnit, source: string, points: GrowthPoint[], caveat: string | null = null): GrowthSeries {
  return { id, label, unit, source, status: 'ready', freshness: 'fresh', reason: null, need: null, caveat, points };
}

interface MergeEvent { at: number; pr: boolean }

function mergeEvents(text: string, nowMs: number): { events: MergeEvent[]; dropped: number } {
  const jobs = new Map<string, MergeEvent>();
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { dropped += 1; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row['event'] !== 'outcome' || row['state'] !== 'MERGED' || typeof row['job'] !== 'string' || !row['job'].trim()) continue;
    const at = typeof row['ts'] === 'string' ? Date.parse(row['ts']) : NaN;
    if (!Number.isFinite(at) || at > nowMs) continue;
    const job = row['job'];
    if ((jobs.get(job)?.at ?? -Infinity) > at) continue;
    const url = typeof row['url'] === 'string' ? row['url'] : '';
    jobs.set(job, { at, pr: PR_URL.test(url) });
  }
  return { events: [...jobs.values()], dropped };
}

function usageReadings(text: string): { at: number; pct: number }[] {
  const readings: { at: number; pct: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (typeof row['pool'] !== 'string') continue;
    const observed = row['writtenAt'] ?? row['fetchedAt'] ?? row['observedAt'];
    const at = typeof observed === 'string' ? Date.parse(observed) : NaN;
    const pct = row['pctUsed'];
    if (!Number.isFinite(at) || typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    readings.push({ at, pct });
  }
  return readings;
}

function mergesPerHour(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'mergesPerHour';
  const label = 'Merges per hour';
  if (facts.jobsText === null) return unavailable(id, label, 'merges_per_hour', null, GROWTH_FIELD_NEEDS['growth.mergesPerHour']!);
  const { events, dropped } = mergeEvents(facts.jobsText, facts.nowMs);
  const buckets = bucketsFor(facts.nowMs, range);
  const caveat = dropped > 0 ? 'Some ledger rows could not be read; counts are a lower bound.' : null;
  const hours = BUCKET_MS[range] / 3_600_000;
  return ready(id, label, 'merges_per_hour', 'metrics/jobs.jsonl', pointsFrom(buckets, (bucket) => {
    const count = events.filter((event) => contains(event.at, bucket, facts.nowMs)).length;
    return hours > 0 ? count / hours : 0;
  }), caveat);
}

type PullKind = 'hourly-counts' | 'hourly-pulls' | 'daily' | 'none';

function longRange(range: GrowthRange): boolean {
  return range === '1W' || range === '1M';
}

function pullKind(facts: GrowthFacts, range: GrowthRange): PullKind {
  const hourlyCounts = facts.hourlyPullCounts ?? null;
  const hourlyPulls = facts.hourlyPullsComplete ? facts.hourlyPulls ?? null : null;
  if (longRange(range) && hourlyCounts) return 'hourly-counts';
  if (longRange(range) && hourlyPulls) return 'hourly-pulls';
  if (facts.pulls && facts.pullsComplete) return 'daily';
  if (hourlyCounts) return 'hourly-counts';
  if (hourlyPulls) return 'hourly-pulls';
  return 'none';
}

function pullRows(facts: GrowthFacts, kind: PullKind): readonly GrowthPull[] {
  if (kind === 'hourly-pulls') return facts.hourlyPulls ?? [];
  if (kind === 'daily') return facts.pulls ?? [];
  return [];
}

function pullsOpened(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'pullsOpened';
  const label = 'PRs opened';
  const kind = pullKind(facts, range);
  const buckets = bucketsFor(facts.nowMs, range);
  if (kind === 'hourly-counts') {
    const rows = facts.hourlyPullCounts ?? [];
    return ready(id, label, 'count', 'metrics/growth-pulls-hourly.jsonl', pointsFrom(buckets, (bucket) => {
      let total = 0;
      let seen = false;
      for (const row of rows) {
        if (row.opened === null || !contains(row.at, bucket, facts.nowMs)) continue;
        seen = true;
        total += row.opened;
      }
      return seen ? total : null;
    }));
  }
  if (kind === 'none') return unavailable(id, label, 'count', null, GROWTH_FIELD_NEEDS['growth.pullsOpened']!);
  const source = kind === 'hourly-pulls' ? 'metrics/growth-pulls-hourly.jsonl' : (facts.pullsSource ?? 'pull-export');
  const times = pullRows(facts, kind).flatMap((pull) => {
    const at = Date.parse(pull.createdAt);
    return Number.isFinite(at) && at <= facts.nowMs ? [at] : [];
  });
  return ready(id, label, 'count', source, pointsFrom(buckets, (bucket) => times.filter((at) => contains(at, bucket, facts.nowMs)).length));
}

function pullsMerged(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'pullsMerged';
  const label = 'PRs merged';
  const kind = pullKind(facts, range);
  const buckets = bucketsFor(facts.nowMs, range);
  if (kind === 'hourly-counts') {
    const rows = facts.hourlyPullCounts ?? [];
    return ready(id, label, 'count', 'metrics/growth-pulls-hourly.jsonl', pointsFrom(buckets, (bucket) => {
      let total = 0;
      let seen = false;
      for (const row of rows) {
        if (row.merged === null || !contains(row.at, bucket, facts.nowMs)) continue;
        seen = true;
        total += row.merged;
      }
      return seen ? total : null;
    }));
  }
  if (kind === 'hourly-pulls' || kind === 'daily') {
    const source = kind === 'hourly-pulls' ? 'metrics/growth-pulls-hourly.jsonl' : (facts.pullsSource ?? 'pull-export');
    const times = pullRows(facts, kind).flatMap((pull) => {
      if (pull.state !== 'merged' || !pull.mergedAt) return [];
      const at = Date.parse(pull.mergedAt);
      return Number.isFinite(at) && at <= facts.nowMs ? [at] : [];
    });
    return ready(id, label, 'count', source, pointsFrom(buckets, (bucket) => times.filter((at) => contains(at, bucket, facts.nowMs)).length));
  }
  if (facts.jobsText === null) return unavailable(id, label, 'count', null, GROWTH_FIELD_NEEDS['growth.pullsMerged']!);
  const { events, dropped } = mergeEvents(facts.jobsText, facts.nowMs);
  const caveat = dropped > 0 ? 'Some ledger rows could not be read; counts are a lower bound.' : null;
  return ready(id, label, 'count', 'metrics/jobs.jsonl', pointsFrom(buckets, (bucket) => events.filter((event) => event.pr && contains(event.at, bucket, facts.nowMs)).length), caveat);
}

function releases(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'releases';
  const label = 'Releases';
  const events = facts.releases;
  if (!events) return unavailable(id, label, 'count', null, GROWTH_FIELD_NEEDS['growth.releases']!);
  const buckets = bucketsFor(facts.nowMs, range);
  return ready(id, label, 'count', 'metrics/growth-releases.jsonl', pointsFrom(buckets, (bucket) => events.filter((event) => contains(event.at, bucket, facts.nowMs)).length));
}

function laneUtilization(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'laneUtilization';
  const label = 'Lane utilization';
  if (facts.usageText === null) return unavailable(id, label, 'percent', null, GROWTH_FIELD_NEEDS['growth.laneUtilization']!);
  const readings = usageReadings(facts.usageText).filter((reading) => reading.at <= facts.nowMs);
  if (readings.length === 0) return unavailable(id, label, 'percent', 'usage-readings.log', GROWTH_FIELD_NEEDS['growth.laneUtilization']!);
  const buckets = bucketsFor(facts.nowMs, range);
  const points = pointsFrom(buckets, (bucket) => {
    const hit = readings.filter((reading) => contains(reading.at, bucket, facts.nowMs));
    if (hit.length === 0) return null;
    return hit.reduce((sum, reading) => sum + reading.pct, 0) / hit.length;
  });
  if (points.every((point) => point.y === null)) return unavailable(id, label, 'percent', 'usage-readings.log', GROWTH_FIELD_NEEDS['growth.laneUtilization']!);
  return ready(id, label, 'percent', 'usage-readings.log', points);
}

function costCard(facts: GrowthFacts, range: GrowthRange): GrowthScorecard | null {
  if (range === '1W') return facts.scorecard7d;
  if (range === '1M') return facts.scorecard30d;
  return null;
}

function costPerMergedPr(facts: GrowthFacts, range: GrowthRange): GrowthSeries {
  const id = 'costPerMergedPr';
  const hourly = facts.costHourly;
  if (hourly) {
    const buckets = bucketsFor(facts.nowMs, range);
    const points = pointsFrom(buckets, (bucket) => {
      let latest: { at: number; usd: number } | null = null;
      for (const point of hourly) {
        if (point.usd === null || !contains(point.at, bucket, facts.nowMs)) continue;
        if (!latest || point.at >= latest.at) latest = { at: point.at, usd: point.usd };
      }
      return latest ? latest.usd : null;
    });
    if (points.every((point) => point.y === null)) {
      return unavailable(id, 'Cost · metered lanes', 'usd', 'metrics/growth-cost-hourly.jsonl', GROWTH_FIELD_NEEDS['growth.costPerMergedPr']!);
    }
    return ready(id, 'Cost · metered lanes', 'usd', 'metrics/growth-cost-hourly.jsonl', points, 'Metered lanes. Hours without a reading stay gaps.');
  }
  const label = 'Cost per merged PR';
  const have = facts.scorecard7d ?? facts.scorecard30d;
  if (range === '1H' || range === '1D') {
    return unavailable(id, label, 'usd', have ? 'scorecard-history' : null, GROWTH_FIELD_NEEDS['growth.costPerMergedPr']!);
  }
  const card = costCard(facts, range);
  if (!card) return unavailable(id, label, 'usd', null, GROWTH_FIELD_NEEDS['growth.costPerMergedPr']!);
  const buckets = bucketsFor(facts.nowMs, range);
  const points = pointsFrom(buckets, (bucket) => {
    let latest: { at: number; cost: number | null } | null = null;
    for (const point of card.points) {
      const at = Date.parse(point.ts);
      if (!Number.isFinite(at) || !contains(at, bucket, facts.nowMs)) continue;
      if (!latest || at >= latest.at) latest = { at, cost: point.costPerMergedChangeUsd };
    }
    return latest ? latest.cost : null;
  });
  if (points.every((point) => point.y === null)) return unavailable(id, label, 'usd', 'scorecard-history', GROWTH_FIELD_NEEDS['growth.costPerMergedPr']!);
  const caveat = card.sourceState === 'degraded' ? 'Scorecard history is partial; days without a snapshot are gaps.' : null;
  return ready(id, label, 'usd', 'scorecard-history', points, caveat);
}

function bottleneckTrends(): GrowthSeries {
  return unavailable('bottleneckTrends', 'Bottleneck trend', 'count', null, GROWTH_FIELD_NEEDS['growth.bottleneckTrends']!);
}

function seriesFor(facts: GrowthFacts, range: GrowthRange): GrowthSeries[] {
  return [
    mergesPerHour(facts, range),
    pullsOpened(facts, range),
    pullsMerged(facts, range),
    releases(facts, range),
    laneUtilization(facts, range),
    costPerMergedPr(facts, range),
    bottleneckTrends(),
  ];
}

const EXPORT_CLOCK: Partial<Record<GrowthSeriesId, keyof GrowthExportClock>> = {
  pullsOpened: 'pulls',
  pullsMerged: 'pulls',
  releases: 'releases',
  costPerMergedPr: 'cost',
};

export function exportFreshness(observedAt: string | null, nowMs: number): GrowthFreshness {
  if (!observedAt) return 'unknown';
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return 'unknown';
  const age = nowMs - at;
  if (age < -5 * 60 * 1000) return 'unknown';
  return age > GROWTH_EXPORT_STALE_MS ? 'stale' : 'fresh';
}

function stampFreshness(series: GrowthSeries, facts: GrowthFacts): GrowthSeries {
  if (series.status !== 'ready') return series;
  const clockKey = EXPORT_CLOCK[series.id];
  if (!clockKey || series.source === 'scorecard-history' || series.source === 'metrics/jobs.jsonl') return series;
  const freshness = exportFreshness(facts.exportClock?.[clockKey] ?? null, facts.nowMs);
  if (freshness !== 'stale') return { ...series, freshness };
  const caveat = [series.caveat, 'Export is more than 30 minutes old.'].filter(Boolean).join(' ');
  return { ...series, freshness, caveat };
}

function stampedSeries(facts: GrowthFacts, range: GrowthRange): GrowthSeries[] {
  return seriesFor(facts, range).map((series) => stampFreshness(series, facts));
}

function latestReady(series: GrowthSeries): number | null {
  if (series.status !== 'ready') return null;
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const y = series.points[i]!.y;
    if (y !== null) return y;
  }
  return null;
}

export function growthSnapshot(facts: GrowthFacts): GrowthSnapshot {
  const reports = (['1M', '1W', '1D'] as const).map((range) => stampedSeries(facts, range));
  const latest = (id: GrowthSeriesId): { value: number | null; freshness: GrowthFreshness } => {
    for (const series of reports) {
      const row = series.find((item) => item.id === id);
      if (!row) continue;
      const value = latestReady(row);
      if (value !== null) return { value, freshness: row.freshness };
    }
    return { value: null, freshness: 'unknown' };
  };
  const freshness = {} as Record<GrowthSeriesId, GrowthFreshness>;
  const values = {} as Record<GrowthSeriesId, number | null>;
  for (const id of GROWTH_SERIES_IDS) {
    const reading = latest(id);
    values[id] = reading.freshness === 'fresh' ? reading.value : null;
    freshness[id] = reading.value === null ? 'unknown' : reading.freshness;
  }
  return {
    mergesPerHour: values.mergesPerHour,
    pullsOpened: values.pullsOpened,
    pullsMerged: values.pullsMerged,
    releases: values.releases,
    laneUtilization: values.laneUtilization,
    costPerMergedPr: values.costPerMergedPr,
    bottleneckTrends: values.bottleneckTrends,
    observedAt: new Date(facts.nowMs).toISOString(),
    freshness,
  };
}

export function growthBlindSpots(facts: GrowthFacts): GrowthBlindSpot[] {
  const snap = growthSnapshot(facts);
  const spots: GrowthBlindSpot[] = [];
  for (const id of GROWTH_SERIES_IDS) {
    const freshness = snap.freshness[id];
    if (freshness === 'fresh' && snap[id] !== null) continue;
    const path = `growth.${id}`;
    spots.push({
      id: stableFieldId(path),
      path,
      freshness: freshness === 'stale' ? 'stale' : 'unknown',
      need: GROWTH_FIELD_NEEDS[path] ?? `A fresh reading for ${path}.`,
    });
  }
  spots.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return spots;
}

export function projectGrowthSeries(facts: GrowthFacts, range: GrowthRange): GrowthReport {
  const series = stampedSeries(facts, range);
  const primary = series.find((item) => item.status === 'ready')?.id ?? 'mergesPerHour';
  return {
    schema: GROWTH_SCHEMA,
    generatedAt: new Date(facts.nowMs).toISOString(),
    readOnly: true,
    range,
    ranges: GROWTH_RANGES,
    primaryId: primary,
    series,
    blindSpots: growthBlindSpots(facts),
  };
}
