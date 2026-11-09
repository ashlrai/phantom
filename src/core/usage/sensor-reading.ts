/**
 * Fleet usage sensors. Every lane reading carries observedAt, source and
 * staleAfter. A clock at or after staleAfter is unknown: the numbers may
 * still be shown, and headroom is null so a stale reading is never room.
 *
 * Pre-change timestamp coverage, counted 2026-11-09 across the twelve
 * usage and credit readings this report replaces as a headroom input:
 * usageReadingV1, UsageResourceReading, CodexUsageReading, DevinUsage,
 * GrokUsageReading, DevinConsumptionSnapshot, ResourceObservation,
 * CreditPoolObservation and ResourceQuotaRefreshRow had a timestamp (9).
 * DevinDailyConsumption, CodexCredits and Claude quota windows did not (3).
 * None of the twelve carried observedAt, source and staleAfter together.
 */
import { z } from 'zod';

export const USAGE_SENSOR_SCHEMA = 'usage.sensors.v1' as const;
/** Same bound routing headroom uses. A reading this old is not room. */
export const USAGE_SENSOR_STALE_MS = 15 * 60_000;
export const SENSOR_TIMESTAMP_BASELINE = { timestamped: 9, total: 12 } as const;
/** How many prior points the burn slope may use. */
export const SENSOR_BURN_SAMPLES = 4;
/** Included-usage forecast is on pace when exhaustion lands within this share of the time left. */
export const FORECAST_ON_PACE_FRACTION = 0.15;

export type ForecastVsReset = 'early' | 'on-pace' | 'underuse' | 'unknown';

export const USAGE_SENSOR_LANES = [
  'devin',
  'devin-swe-flash',
  'devin-weekly',
  'codex-cmp',
  'codex-personal',
  'dot',
  'claude-max',
  'claude-api',
  'cursor-cloud',
  'grok-ultra',
  'grok-bot',
  'local',
  'terra',
] as const;
export type UsageSensorLane = (typeof USAGE_SENSOR_LANES)[number];

export const USAGE_SENSOR_SOURCES = [
  'devin-api-v3-daily',
  'devin-api-v3-org-cycle',
  'devin-included-allowance',
  'codex-app-server',
  'dot-status',
  'claude-usage',
  'claude-rate-limit-event',
  'claude-api-balance',
  'cursor-status',
  'grok-status',
  'manual',
  'local-throughput',
  'unmeasured',
] as const;
export type UsageSensorSource = (typeof USAGE_SENSOR_SOURCES)[number];
export type UsageSensorUnit = 'percent' | 'acu';

const timestamp = z.string().refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});

export const usageSensorReadingSchema = z.object({
  lane: z.enum(USAGE_SENSOR_LANES),
  observedAt: timestamp,
  source: z.enum(USAGE_SENSOR_SOURCES),
  staleAfter: timestamp,
  used: z.number().finite().nonnegative().nullable(),
  limit: z.number().finite().nonnegative().nullable(),
  unit: z.enum(['percent', 'acu']).nullable(),
  resetAt: timestamp.nullable(),
}).strict();

export type UsageSensorReading = z.infer<typeof usageSensorReadingSchema>;

export interface UsageSensorLaneView {
  lane: UsageSensorLane;
  observedAt: string | null;
  source: UsageSensorSource | null;
  staleAfter: string | null;
  ageMs: number | null;
  stale: boolean;
  status: 'fresh' | 'unknown';
  used: number | null;
  limit: number | null;
  unit: UsageSensorUnit | null;
  resetAt: string | null;
  /** Remaining room. Null when the reading is unknown, including when it is stale. */
  headroom: number | null;
  /** Allowance left. Null when used or limit was not measured. Never a stand-in zero. */
  remaining: number | null;
  remainingUnit: UsageSensorUnit | null;
  /** Usage units per hour from the last samples. Null until two points agree. */
  burnRate: number | null;
  forecastExhaustAt: string | null;
  forecastVsReset: ForecastVsReset;
  /** Included allowance projected to expire unused, scaled to a week. Null when unknown. */
  idleIncludedWastedPerWeek: number | null;
  /**
   * Reset time while the allowance is used up, else null. Usage never falls
   * inside a window, so this holds past staleAfter: a lane at zero stays at
   * zero until the reset, however old the reading is.
   */
  zeroCapacityUntil: string | null;
}

export interface UsageSensorReport {
  schema: typeof USAGE_SENSOR_SCHEMA;
  generatedAt: string;
  lanes: UsageSensorLaneView[];
}

export function unmeasuredSensor(lane: UsageSensorLane, nowMs: number): UsageSensorReading {
  const observedAt = new Date(nowMs).toISOString();
  return {
    lane, observedAt, source: 'unmeasured', staleAfter: observedAt,
    used: null, limit: null, unit: null, resetAt: null,
  };
}

/**
 * True only inside the open interval [observedAt, staleAfter). A missing
 * staleAfter uses the 15 minute bound. Future, invalid or due readings are
 * not fresh.
 */
export function readingIsFresh(input: {
  observedAt: string | null;
  staleAfter?: string | null;
  nowMs: number;
}): boolean {
  if (!Number.isFinite(input.nowMs) || input.observedAt === null) return false;
  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(observed) || observed > input.nowMs) return false;
  const explicit = input.staleAfter == null ? NaN : Date.parse(input.staleAfter);
  if (input.staleAfter != null && !Number.isFinite(explicit)) return false;
  const deadline = Number.isFinite(explicit) ? explicit : observed + USAGE_SENSOR_STALE_MS;
  return Number.isFinite(deadline) && input.nowMs < deadline;
}

const PAY_PER_USE = new Set<UsageSensorLane>(['claude-api']);

function burnFrom(samples: readonly UsageSensorReading[], latest: UsageSensorReading): number | null {
  const resetAt = latest.resetAt;
  const points = samples
    .filter((sample) => sample.source !== 'unmeasured' && sample.used !== null && sample.resetAt === resetAt)
    .filter((sample) => {
      const at = Date.parse(sample.observedAt);
      return Number.isFinite(at) && at <= Date.parse(latest.observedAt);
    })
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .slice(-SENSOR_BURN_SAMPLES);
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const hours = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3_600_000;
  if (!(hours > 0) || first.used === null || last.used === null || last.used < first.used) return null;
  return (last.used - first.used) / hours;
}

function weeklyWaste(unusedAtReset: number, hoursLeft: number): number | null {
  if (!Number.isFinite(unusedAtReset) || !(hoursLeft > 0)) return null;
  return hoursLeft >= 168 ? unusedAtReset : unusedAtReset * (168 / hoursLeft);
}

function viewLane(samples: readonly UsageSensorReading[], nowMs: number): UsageSensorLaneView {
  const latest = [...samples].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)).at(-1)!;
  const observedMs = Date.parse(latest.observedAt);
  const deadline = Date.parse(latest.staleAfter);
  const fresh = readingIsFresh({ observedAt: latest.observedAt, staleAfter: latest.staleAfter, nowMs });
  const throughput = latest.lane === 'local' && latest.source === 'local-throughput';
  const measured = fresh && latest.source !== 'unmeasured' && latest.used !== null && latest.limit !== null;
  const room = measured ? latest.limit! - latest.used! : null;
  const headroom = room === null || !Number.isFinite(room) ? null : Math.max(0, room);
  const burn = fresh ? burnFrom(samples, latest) : null;
  const remaining = measured ? Math.max(0, latest.limit! - latest.used!) : null;
  const resetMs = latest.resetAt ? Date.parse(latest.resetAt) : NaN;
  const hoursLeft = Number.isFinite(resetMs) ? (resetMs - nowMs) / 3_600_000 : NaN;
  let forecastExhaustAt: string | null = null;
  let forecastVsReset: ForecastVsReset = 'unknown';
  let idleIncludedWastedPerWeek: number | null = null;
  const included = !PAY_PER_USE.has(latest.lane) && latest.lane !== 'local';
  if (measured && remaining !== null && burn !== null && hoursLeft > 0 && included) {
    if (burn > 0) forecastExhaustAt = new Date(nowMs + (remaining / burn) * 3_600_000).toISOString();
    const marginMs = Math.max(30 * 60_000, (resetMs - nowMs) * FORECAST_ON_PACE_FRACTION);
    const exhaustMs = forecastExhaustAt ? Date.parse(forecastExhaustAt) : null;
    if (burn === 0) forecastVsReset = remaining > 0 ? 'underuse' : 'on-pace';
    else if (exhaustMs !== null && exhaustMs < resetMs - marginMs) forecastVsReset = 'early';
    else if (exhaustMs !== null && exhaustMs > resetMs + marginMs) forecastVsReset = 'underuse';
    else if (exhaustMs !== null) forecastVsReset = 'on-pace';
    const usedAtReset = latest.used! + burn * hoursLeft;
    idleIncludedWastedPerWeek = weeklyWaste(Math.max(0, latest.limit! - usedAtReset), hoursLeft);
  }
  const spent = latest.source !== 'unmeasured' && latest.used !== null && latest.limit !== null && latest.used >= latest.limit;
  const zeroCapacityUntil = spent && Number.isFinite(resetMs) && resetMs > nowMs ? latest.resetAt : null;
  return {
    lane: latest.lane,
    observedAt: latest.observedAt,
    source: latest.source,
    staleAfter: latest.staleAfter,
    ageMs: Number.isFinite(observedMs) && observedMs <= nowMs ? nowMs - observedMs : null,
    stale: Number.isFinite(deadline) && nowMs >= deadline,
    status: measured || (fresh && throughput && latest.used !== null) ? 'fresh' : 'unknown',
    used: latest.used,
    limit: latest.limit,
    unit: latest.unit,
    resetAt: latest.resetAt,
    headroom,
    remaining: throughput ? null : remaining,
    remainingUnit: remaining === null || throughput ? null : latest.unit,
    burnRate: burn,
    forecastExhaustAt,
    forecastVsReset,
    idleIncludedWastedPerWeek,
    zeroCapacityUntil,
  };
}

/**
 * Included waste across lanes. A lane with no burn or no reset contributes
 * nothing and does not become zero. The total is null when every lane is unknown.
 */
export function includedWastePerWeek(report: UsageSensorReport): number | null {
  const values = report.lanes.flatMap((lane) => lane.idleIncludedWastedPerWeek === null ? [] : [lane.idleIncludedWastedPerWeek]);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/** One row per lane. Invalid rows are dropped. Missing lanes are unmeasured. */
export function presentUsageSensors(readings: readonly unknown[], nowMs: number): UsageSensorReport {
  const groups = new Map<UsageSensorLane, UsageSensorReading[]>();
  for (const reading of readings) {
    const parsed = usageSensorReadingSchema.safeParse(reading);
    if (!parsed.success) continue;
    const list = groups.get(parsed.data.lane) ?? [];
    list.push(parsed.data);
    groups.set(parsed.data.lane, list);
  }
  return {
    schema: USAGE_SENSOR_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    lanes: USAGE_SENSOR_LANES.map((lane) => viewLane(groups.get(lane) ?? [unmeasuredSensor(lane, nowMs)], nowMs)),
  };
}

/** Snapshot file: `{ schema, readings }`. Bad rows are omitted, never echoed. */
export function parseUsageSensorSnapshot(raw: unknown): UsageSensorReading[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const readings = (raw as { readings?: unknown }).readings;
  if (!Array.isArray(readings)) return [];
  const parsed: UsageSensorReading[] = [];
  for (const row of readings) {
    const result = usageSensorReadingSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}
