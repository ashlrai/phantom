/**
 * Read side of state/resource-live.json for the world model (which the
 * desktop resource bar renders) and the fleet scheduler's pace input.
 *
 * Readings become usage.sensors.v1 rows, so every consumer applies the same
 * staleness rule: a row past its bound is unknown, not room. This module only
 * reads. It never writes the sidecar.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  USAGE_SENSOR_STALE_MS, usageSensorReadingSchema, type UsageSensorReading,
} from '../sensor-reading.js';
import { parseResourceLiveSidecar, readResourceLiveFile } from './store.js';
import { RESOURCE_LIVE_ALLOWANCES, type ResourceLiveReading } from './types.js';
import { projectLaneHistory } from './history.js';
import { readResourceHistoryFile } from './store.js';
import type { LaneHistory } from './types.js';

/** Pacing keys the world model reads from a sensor row. */
export interface ResourceLivePaceRow {
  lane: string;
  pacePerHour: number | null;
  requiredPacePerHour: number | null;
  runwayHours: number | null;
}

export interface ResourceLiveFeed {
  history?: Record<string, LaneHistory>;
  readings: UsageSensorReading[];
  pace: ResourceLivePaceRow[];
}

const SENSOR_SOURCE: Readonly<Record<string, string>> = { 'grok-ultra-manual': 'manual' };

function sensorLane(id: string): string | null {
  return RESOURCE_LIVE_ALLOWANCES.find(row => row.id === id)?.sensor_lane ?? null;
}

/** ACU stays ACU. Every other unit is carried as percent of the allowance. */
function scale(reading: ResourceLiveReading): number | null {
  if (reading.unit === 'acu') return 1;
  return reading.limit !== null && reading.limit > 0 ? 100 / reading.limit : null;
}

function sensorRow(reading: ResourceLiveReading): UsageSensorReading | null {
  const lane = sensorLane(reading.id);
  const factor = scale(reading);
  if (!lane || !reading.verified || reading.observed_at === null || reading.source === null
    || reading.used === null || reading.limit === null || factor === null) return null;
  const parsed = usageSensorReadingSchema.safeParse({
    lane,
    observedAt: reading.observed_at,
    source: SENSOR_SOURCE[reading.source] ?? reading.source,
    staleAfter: reading.stale_after ?? new Date(Date.parse(reading.observed_at) + USAGE_SENSOR_STALE_MS).toISOString(),
    used: Math.round(reading.used * factor * 1000) / 1000,
    limit: Math.round(reading.limit * factor * 1000) / 1000,
    unit: reading.unit === 'acu' ? 'acu' : 'percent',
    resetAt: reading.reset_at,
  });
  return parsed.success ? parsed.data : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Project a stored sidecar. A missing or malformed file yields nothing. */
export function projectResourceLiveFeed(raw: unknown, nowMs: number): ResourceLiveFeed {
  const sidecar = parseResourceLiveSidecar(raw);
  const readings = sidecar.readings.flatMap(reading => { const row = sensorRow(reading); return row ? [row] : []; });
  const pace: ResourceLivePaceRow[] = [];
  // The plan was computed at generated_at. Past the staleness bound its rates describe an older moment.
  const planAt = sidecar.generated_at === null ? NaN : Date.parse(sidecar.generated_at);
  const plan = raw !== null && typeof raw === 'object' ? (raw as { burn_down?: { allowances?: unknown } }).burn_down?.allowances : null;
  if (Number.isFinite(planAt) && planAt <= nowMs && nowMs - planAt < USAGE_SENSOR_STALE_MS && Array.isArray(plan)) {
    for (const entry of plan) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const reading = sidecar.readings.find(item => item.id === row['id']);
      const lane = reading ? sensorLane(reading.id) : null;
      const factor = reading ? scale(reading) : null;
      if (!reading || !lane || factor === null) continue;
      const required = finite(row['target_rate_per_hour']);
      const observed = finite(row['observed_rate_per_hour']);
      const remaining = finite(row['remaining']);
      pace.push({
        lane,
        pacePerHour: observed === null ? null : observed * factor,
        requiredPacePerHour: required === null ? null : required * factor,
        runwayHours: observed !== null && observed > 0 && remaining !== null ? remaining / observed : null,
      });
    }
  }
  return { readings, pace };
}

export function defaultResourceLiveRunsDir(): string {
  const configured = process.env['ASHLR_RUNS_DIR'];
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.ashlr-runs');
}

/** Live sensor rows and pacing from the sidecar. Never throws. */
export async function loadResourceLiveFeed(nowMs: number, runsDir = defaultResourceLiveRunsDir()): Promise<ResourceLiveFeed> {
  try { return { ...projectResourceLiveFeed(await readResourceLiveFile(runsDir), nowMs),
    history: projectLaneHistory(await readResourceHistoryFile(runsDir), nowMs) }; }
  catch { return { readings: [], pace: [] }; }
}
