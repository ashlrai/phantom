/**
 * ashlr.world-model/v1. One snapshot for the scheduler, the leaders, and the
 * desktop. A missing or stale measurement is null. It is never stored as 0.
 */

export const WORLD_SCHEMA = 'ashlr.world-model/v1' as const;
export const WORLD_CACHE_TTL_MS = 15_000;

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface Field<T> {
  value: T | null;
  source: string | null;
  observedAt: string | null;
  freshness: Freshness;
}

/** Stable across runs for the same path. Dots and other separators become hyphens. */
export function stableFieldId(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface BlindSpot {
  id: string;
  path: string;
  freshness: 'unknown' | 'stale';
  /** What would make this signal visible. */
  need: string;
}

export interface WorldModel {
  schema: typeof WORLD_SCHEMA;
  generatedAt: string;
  readOnly: true;
  cache: { hit: boolean; ageMs: number; ttlMs: number };
  sensors: {
    lanes: Array<{
      lane: string;
      headroom: Field<number>;
      used: Field<number>;
      limit: Field<number>;
      remaining: Field<number>;
      burnRate: Field<number>;
      idleIncludedWastedPerWeek: Field<number>;
      pacePerHour: Field<number>;
      requiredPacePerHour: Field<number>;
      runwayHours: Field<number>;
    }>;
  };
  roster: {
    sessions: Field<number>;
    sources: Array<{ source: string; availability: Field<'known' | 'unknown'>; sessions: Field<number> }>;
  };
  claims: { live: Field<number> };
  bus: { readable: Field<boolean> };
  queue: { ready: Field<number>; claimed: Field<number> };
  ci: { repos: Field<number>; medianDailyTtgSeconds: Field<number> };
  releases: { updateCheck: Field<string>; train: Field<string> };
  bottlenecks: { count: Field<number> };
  humanSteps: { remaining: Field<number> };
  outcomes: {
    repos: Array<{ repo: string; mergedPerDay: Field<number>; changeFailureRate: Field<number> }>;
  };
  blindSpots: BlindSpot[];
}
