/**
 * Manual fleet readings. There is no quota API for these pools. A projection
 * that uses a reading is marked derived and carries the reading's age. A
 * derived number is never reported as a reading.
 */

import { readFileSync } from 'node:fs';

export const FLEET_READINGS_ENV = 'PHANTOM_FLEET_FILE';

export interface ManualReading {
  poolId: string;
  /** Used fraction in [0, 1]. */
  value: number;
  timestamp: string;
  source: 'manual';
}

export interface DerivedReading {
  poolId: string;
  used: number;
  projection: 'derived';
  isReading: false;
  source: 'manual';
  readingAtMs: number;
  ageMs: number;
  stale: boolean;
  uncertainty: number;
}

export function fleetReadingsPath(env: NodeJS.ProcessEnv): string | null {
  const value = env[FLEET_READINGS_ENV];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asReading(value: unknown): ManualReading | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['source'] !== 'manual') return null;
  if (typeof row['poolId'] !== 'string' || row['poolId'].trim() === '') return null;
  if (typeof row['value'] !== 'number' || !Number.isFinite(row['value']) || row['value'] < 0 || row['value'] > 1) return null;
  if (typeof row['timestamp'] !== 'string' || !Number.isFinite(Date.parse(row['timestamp']))) return null;
  return { poolId: row['poolId'], value: row['value'], timestamp: row['timestamp'], source: 'manual' };
}

export function parseFleetReadings(text: string): ManualReading[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const readings = (raw as Record<string, unknown>)['readings'];
  if (!Array.isArray(readings)) return [];
  return readings.flatMap((row) => {
    const reading = asReading(row);
    return reading ? [reading] : [];
  });
}

export function deriveReading(reading: ManualReading, nowMs: number, staleAfterMs: number): DerivedReading {
  const readingAtMs = Date.parse(reading.timestamp);
  const ageMs = Math.max(0, nowMs - readingAtMs);
  const window = Math.max(1, staleAfterMs);
  return {
    poolId: reading.poolId,
    used: reading.value,
    projection: 'derived',
    isReading: false,
    source: 'manual',
    readingAtMs,
    ageMs,
    stale: ageMs > staleAfterMs,
    uncertainty: Math.max(0, Math.min(1, ageMs / window)),
  };
}

/** Latest manual row per pool. Missing files and bad JSON yield no readings. */
export function loadFleetReadings(options: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  nowMs: number;
  staleAfterMs?: number;
}): DerivedReading[] {
  const path = options.path ?? fleetReadingsPath(options.env ?? {});
  if (!path) return [];
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const staleAfterMs = options.staleAfterMs ?? 86_400_000;
  const latest = new Map<string, DerivedReading>();
  for (const reading of parseFleetReadings(text)) {
    const derived = deriveReading(reading, options.nowMs, staleAfterMs);
    const current = latest.get(derived.poolId);
    if (!current || derived.readingAtMs >= current.readingAtMs) latest.set(derived.poolId, derived);
  }
  return [...latest.values()];
}
