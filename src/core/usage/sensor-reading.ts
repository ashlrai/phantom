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

export const USAGE_SENSOR_LANES = [
  'devin',
  'codex-cmp',
  'codex-personal',
  'claude-max',
  'grok-ultra',
  'terra',
] as const;
export type UsageSensorLane = (typeof USAGE_SENSOR_LANES)[number];

export const USAGE_SENSOR_SOURCES = [
  'devin-api-v3-daily',
  'devin-api-v3-org-cycle',
  'codex-app-server',
  'claude-usage',
  'claude-rate-limit-event',
  'grok-status',
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

function viewLane(reading: UsageSensorReading, nowMs: number): UsageSensorLaneView {
  const observedMs = Date.parse(reading.observedAt);
  const deadline = Date.parse(reading.staleAfter);
  const fresh = readingIsFresh({ observedAt: reading.observedAt, staleAfter: reading.staleAfter, nowMs });
  const measured = fresh && reading.source !== 'unmeasured' && reading.used !== null && reading.limit !== null;
  const room = measured ? reading.limit! - reading.used! : null;
  return {
    lane: reading.lane,
    observedAt: reading.observedAt,
    source: reading.source,
    staleAfter: reading.staleAfter,
    ageMs: Number.isFinite(observedMs) && observedMs <= nowMs ? nowMs - observedMs : null,
    stale: Number.isFinite(deadline) && nowMs >= deadline,
    status: measured ? 'fresh' : 'unknown',
    used: reading.used,
    limit: reading.limit,
    unit: reading.unit,
    resetAt: reading.resetAt,
    headroom: room === null || !Number.isFinite(room) ? null : Math.max(0, room),
  };
}

/** One row per lane. Invalid rows are dropped. Missing lanes are unmeasured. */
export function presentUsageSensors(readings: readonly unknown[], nowMs: number): UsageSensorReport {
  const byLane = new Map<UsageSensorLane, UsageSensorReading>();
  for (const reading of readings) {
    const parsed = usageSensorReadingSchema.safeParse(reading);
    if (!parsed.success) continue;
    const prior = byLane.get(parsed.data.lane);
    if (!prior || Date.parse(parsed.data.observedAt) >= Date.parse(prior.observedAt)) byLane.set(parsed.data.lane, parsed.data);
  }
  return {
    schema: USAGE_SENSOR_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    lanes: USAGE_SENSOR_LANES.map(lane => viewLane(byLane.get(lane) ?? unmeasuredSensor(lane, nowMs), nowMs)),
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
