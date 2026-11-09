/**
 * Pure world-model projection. Callers pass readings they already have.
 * This file does not open files, spawn processes, or call the network.
 */
import type { BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import type { AgentRoster } from '../fleet/agent-roster.js';
import type { UsageSensorReport } from '../usage/sensor-reading.js';
import type { RepoHeadline } from '../observe/types.js';
import { GROWTH_FIELD_NEEDS, type GrowthSeriesId, type GrowthSnapshot } from '../growth/series.js';
import { stableFieldId, WORLD_CACHE_TTL_MS, WORLD_SCHEMA, type BlindSpot, type Field, type Freshness, type WorldModel } from './types.js';

const PACE_NEED = 'RQ-SENSORS-PACE-1 adds pacePerHour, requiredPacePerHour, and runwayHours on usage.sensors.v1. Those keys are absent, so pace stays unknown.';

export interface WorldProjectInput {
  nowMs: number;
  sensors: UsageSensorReport | null;
  /** Raw lane rows, used only for pacing keys the current schema does not require. */
  sensorRows?: readonly unknown[];
  roster: AgentRoster | null;
  claims: BusWorkClaimsInspection | null;
  /** coordinationSummary. When set, it is the claims.live source. */
  claimStore?: { source: 'available' | 'missing' | 'unavailable'; live: number | null } | null;
  busReadable: boolean | null;
  queue: { ready: number; claimed: number } | null;
  ci: { repos: number; medianDailyTtgSeconds: number | null; observedAt: string | null } | null;
  updatePhase: 'failed' | 'ok' | 'unknown' | null;
  bottlenecks: number | null;
  bottlenecksObservedAt: string | null;
  stepsRemaining: number | null;
  stepsObservedAt: string | null;
  outcomes: readonly RepoHeadline[] | null;
  /** Latest growth-series readings. Null leaves every growth field unknown. */
  growth?: GrowthSnapshot | null;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function reading<T>(value: T | null, source: string | null, observedAt: string | null, freshness: Freshness): Field<T> {
  if (freshness !== 'fresh') return { value: null, source, observedAt, freshness };
  return { value, source, observedAt, freshness };
}

function unknown<T>(source: string | null = null): Field<T> {
  return { value: null, source, observedAt: null, freshness: 'unknown' };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pace(rows: readonly unknown[] | undefined, lane: string, key: string): number | null {
  if (!rows) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (record['lane'] !== lane) continue;
    return finite(record[key]);
  }
  return null;
}

function needFor(path: string): string {
  if (path.endsWith('pacePerHour') || path.endsWith('requiredPacePerHour') || path.endsWith('runwayHours')) return PACE_NEED;
  if (path.startsWith('sensors.lanes.') && (path.endsWith('.headroom') || path.endsWith('.used') || path.endsWith('.limit'))) {
    return 'A fresh usage.sensors.v1 reading with used and limit for this lane.';
  }
  if (path === 'sensors.lanes') return 'phm usage sensors --json with a snapshot file or a fresh refresh.';
  if (path === 'roster.sessions' || path === 'roster') return 'phm agents roster --json with at least one probe whose availability is known.';
  if (path.startsWith('roster.sources.')) return 'That roster probe needs a machine-readable session list. Devin Desktop, Cursor, and Grok stay unknown until desktopSessions() can read them.';
  if (path === 'claims.live') return 'coordinationSummary from the claim store. A missing store is unknown, not zero. The older bus claims file is not used as a stand-in.';
  if (path.endsWith('.burnRate')) return 'Two fresh usage samples in the same reset window. burnRate stays unknown until they agree.';
  if (path.endsWith('.remaining')) return 'A fresh usage.sensors.v1 reading with used and limit.';
  if (path.endsWith('.idleIncludedWastedPerWeek')) return 'A fresh burn rate, a reset time, and included allowance. Pay-per-use lanes stay unknown.';
  if (path === 'bus.readable') return 'A readable local bus inbox. Message totals are not estimated from one page.';
  if (path.startsWith('queue.')) return 'A regular queue.v1.json under ~/.ashlr-runs/queue. A missing file is unknown, not zero.';
  if (path === 'ci.repos') return 'A local ~/.ashlr/ci-metrics.json. The tick does not call gh.';
  if (path === 'ci.medianDailyTtgSeconds') return 'At least one finite daily_ttg_s in ci-metrics.json. Null pairs stay unknown.';
  if (path === 'releases.updateCheck') return 'The desktop update phase is published into the world model. The tick does not invent it.';
  if (path === 'releases.train') return 'A local release-train snapshot. gh is not called on the tick.';
  if (path === 'bottlenecks.count') return 'Eng Ops writes ~/.ashlr-runs/export/bottlenecks.json (bottlenecks.v1).';
  if (path === 'humanSteps.remaining') return 'Eng Ops writes ~/.ashlr-runs/export/human-steps.json (ashlr.human-steps/v1).';
  if (path.startsWith('outcomes.')) return 'A complete pull export. Merged-per-day needs mergedAt. Change-failure rate needs reverted, fixForward, and failedRelease on every merged pull.';
  if (path.startsWith('growth.')) return GROWTH_FIELD_NEEDS[path] ?? `A fresh reading for ${path}.`;
  return `A fresh reading for ${path}.`;
}

function isField(value: unknown): value is Field<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record['freshness'] === 'fresh' || record['freshness'] === 'stale' || record['freshness'] === 'unknown')
    && 'value' in record && 'source' in record && 'observedAt' in record;
}

/** One blind spot per unknown or stale field. Ids are derived from the path. */
export function blindSpotsFrom(model: Omit<WorldModel, 'blindSpots'>): { spots: BlindSpot[]; fresh: number } {
  const spots: BlindSpot[] = [];
  let fresh = 0;
  const walk = (node: unknown, path: string): void => {
    if (isField(node)) {
      if (node.freshness === 'fresh') fresh += 1;
      else spots.push({ id: stableFieldId(path), path, freshness: node.freshness, need: needFor(path) });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== 'object') continue;
        const named = item as { lane?: string; source?: string; repo?: string };
        const key = named.lane ?? named.source ?? named.repo;
        if (typeof key === 'string') walk(item, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'blindSpots' || key === 'cache') continue;
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(model, '');
  if (model.sensors.lanes.length === 0) spots.push({ id: 'sensors-lanes', path: 'sensors.lanes', freshness: 'unknown', need: needFor('sensors.lanes') });
  if (model.outcomes.repos.length === 0) spots.push({ id: 'outcomes-repos', path: 'outcomes.repos', freshness: 'unknown', need: needFor('outcomes.repos') });
  spots.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { spots, fresh };
}

export function projectWorldModel(input: WorldProjectInput): WorldModel {
  const now = iso(input.nowMs);
  const lanes = (input.sensors?.lanes ?? []).map((lane) => {
    const source = lane.source;
    const observedAt = lane.observedAt;
    const fresh = lane.status === 'fresh';
    const headroom = reading(fresh ? lane.headroom : null, source, observedAt, fresh ? 'fresh' : lane.stale ? 'stale' : 'unknown');
    const used = reading(fresh ? lane.used : null, source, observedAt, headroom.freshness);
    const limit = reading(fresh ? lane.limit : null, source, observedAt, headroom.freshness);
    const laneNumber = (value: number | null): Field<number> => {
      if (headroom.freshness !== 'fresh' || value === null) {
        return { value: null, source: source ?? 'usage.sensors.v1', observedAt, freshness: headroom.freshness === 'fresh' ? 'unknown' : headroom.freshness };
      }
      return reading(value, source ?? 'usage.sensors.v1', observedAt, 'fresh');
    };
    const remaining = laneNumber(lane.remaining);
    const burnRate = laneNumber(lane.burnRate);
    const idleIncludedWastedPerWeek = laneNumber(lane.idleIncludedWastedPerWeek);
    const paceFreshness: Freshness = fresh ? 'fresh' : 'unknown';
    const pacePerHour = pace(input.sensorRows, lane.lane, 'pacePerHour');
    const requiredPacePerHour = pace(input.sensorRows, lane.lane, 'requiredPacePerHour');
    const runwayHours = pace(input.sensorRows, lane.lane, 'runwayHours');
    const paceField = (value: number | null): Field<number> => {
      if (value === null) return unknown<number>('usage.sensors.v1');
      return reading(value, source ?? 'usage.sensors.v1', observedAt, paceFreshness === 'fresh' ? 'fresh' : 'unknown');
    };
    const paceHour = paceField(pacePerHour);
    const required = paceField(requiredPacePerHour);
    const runway = paceField(runwayHours);
    return { lane: lane.lane, headroom, used, limit, remaining, burnRate, idleIncludedWastedPerWeek, pacePerHour: paceHour, requiredPacePerHour: required, runwayHours: runway };
  });

  const knownSources = input.roster?.sources.filter((source) => source.availability === 'known') ?? [];
  const sessionCount = input.roster === null ? unknown<number>('agent-roster.v1')
    : knownSources.length === 0 ? unknown<number>('agent-roster.v1')
    : reading(knownSources.reduce((sum, source) => sum + source.sessions.length, 0), 'agent-roster.v1', input.roster.observedAt, 'fresh');
  const sources = (input.roster?.sources ?? []).map((source) => {
    const availability = reading(source.availability, 'agent-roster.v1', source.observedAt, source.availability === 'known' ? 'fresh' as const : 'unknown' as const);
    const sessions = source.availability === 'known'
      ? reading(source.sessions.length, 'agent-roster.v1', source.observedAt, 'fresh' as const)
      : unknown<number>('agent-roster.v1');
    return { source: source.source, availability, sessions };
  });
  const liveClaims = input.claimStore?.source === 'available' && typeof input.claimStore.live === 'number'
    ? reading(input.claimStore.live, 'claim-store', now, 'fresh')
    : input.claimStore
      ? unknown<number>('claim-store')
      : input.claims?.source === 'available'
        ? reading(input.claims.claims.length, 'inspectBusWorkClaims', now, 'fresh')
        : unknown<number>('claim-store');
  const bus = input.busReadable === null ? unknown<boolean>('bus-inbox')
    : reading(input.busReadable, 'listBusInboxAfter', now, 'fresh');
  const ready = input.queue ? reading(input.queue.ready, 'queue.v1', now, 'fresh') : unknown<number>('queue.v1');
  const claimed = input.queue ? reading(input.queue.claimed, 'queue.v1', now, 'fresh') : unknown<number>('queue.v1');
  const ciRepos = input.ci ? reading(input.ci.repos, 'ci-metrics.json', input.ci.observedAt, 'fresh') : unknown<number>('ci-metrics.json');
  const ciMedian = input.ci && input.ci.medianDailyTtgSeconds !== null
    ? reading(input.ci.medianDailyTtgSeconds, 'ci-metrics.json', input.ci.observedAt, 'fresh')
    : unknown<number>('ci-metrics.json');
  const update = input.updatePhase && input.updatePhase !== 'unknown'
    ? reading(input.updatePhase, 'desktop-update', now, 'fresh')
    : unknown<string>('desktop-update');
  const train = unknown<string>('ops-releases');
  const bottleneckCount = input.bottlenecks === null ? unknown<number>('bottlenecks.v1')
    : reading(input.bottlenecks, 'bottlenecks.v1', input.bottlenecksObservedAt, 'fresh');
  const steps = input.stepsRemaining === null ? unknown<number>('ashlr.human-steps/v1')
    : reading(input.stepsRemaining, 'ashlr.human-steps/v1', input.stepsObservedAt, 'fresh');
  const growth = input.growth;
  const growthField = (id: GrowthSeriesId): Field<number> => {
    const value = growth?.[id] ?? null;
    const freshness = growth?.freshness?.[id] ?? 'unknown';
    const observedAt = growth?.observedAt ?? null;
    if (freshness === 'fresh' && value !== null && observedAt) return reading(value, 'growth.series.v1', observedAt, 'fresh');
    if (freshness === 'stale') return { value: null, source: 'growth.series.v1', observedAt, freshness: 'stale' };
    return unknown<number>('growth.series.v1');
  };
  const outcomeRepos = (input.outcomes ?? []).filter((repo) => repo.state === 'live').map((repo) => {
    const merged = repo.mergedPerDay === null ? unknown<number>('pull-export') : reading(repo.mergedPerDay, 'pull-export', now, 'fresh');
    const cfr = repo.changeFailureRate === null ? unknown<number>('pull-export') : reading(repo.changeFailureRate, 'pull-export', now, 'fresh');
    return { repo: repo.repo, mergedPerDay: merged, changeFailureRate: cfr };
  });
  const draft = {
    schema: WORLD_SCHEMA,
    generatedAt: now,
    readOnly: true as const,
    cache: { hit: false, ageMs: 0, ttlMs: WORLD_CACHE_TTL_MS },
    sensors: { lanes },
    roster: { sessions: sessionCount, sources },
    claims: { live: liveClaims },
    bus: { readable: bus },
    queue: { ready, claimed },
    ci: { repos: ciRepos, medianDailyTtgSeconds: ciMedian },
    releases: { updateCheck: update, train },
    bottlenecks: { count: bottleneckCount },
    humanSteps: { remaining: steps },
    outcomes: { repos: outcomeRepos },
    growth: {
      mergesPerHour: growthField('mergesPerHour'),
      pullsOpened: growthField('pullsOpened'),
      pullsMerged: growthField('pullsMerged'),
      releases: growthField('releases'),
      laneUtilization: growthField('laneUtilization'),
      costPerMergedPr: growthField('costPerMergedPr'),
      bottleneckTrends: growthField('bottleneckTrends'),
    },
  };
  return { ...draft, blindSpots: blindSpotsFrom(draft).spots };
}
