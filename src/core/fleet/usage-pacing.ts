import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

export interface UsageReading { pct: number; at: string }
export interface UsagePool { resetAt: string; readings: UsageReading[] }
export interface FleetUsageConfig { usage: Record<string, UsagePool>; [key: string]: unknown }
const HOUR = 3_600_000;
const timestamp = (value: string): number => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Timestamp must be ISO 8601 with a timezone');
  }
  return Date.parse(value);
};
function validate(pool: UsagePool): void {
  timestamp(pool.resetAt);
  if (!Array.isArray(pool.readings)) throw new Error('Pool readings must be an array');
  for (const reading of pool.readings) {
    if (!Number.isFinite(reading.pct) || reading.pct < 0 || reading.pct > 100) throw new Error('Percentage must be between 0 and 100');
    timestamp(reading.at);
  }
}

/** Shared offline contract for routing and RQ-PARITY-TOP consumers. */
export function usagePacing(pool: UsagePool, now = Date.now()) {
  validate(pool);
  const reset = timestamp(pool.resetAt);
  const readings = pool.readings.filter(r => timestamp(r.at) <= now && timestamp(r.at) < reset)
    .sort((a, b) => timestamp(a.at) - timestamp(b.at));
  // A decrease starts a new observed quota window; never measure across it.
  let start = 0;
  for (let i = 1; i < readings.length; i++) if (readings[i].pct < readings[i - 1].pct) start = i;
  const current = readings.slice(start);
  const latest = current.at(-1);
  const rate = (first: UsageReading | undefined) => first && latest && timestamp(latest.at) > timestamp(first.at)
    ? (latest.pct - first.pct) * HOUR / (timestamp(latest.at) - timestamp(first.at)) : null;
  const pointsPerHour = rate(current.at(-2));
  // Observed endpoints within the trailing 12h, without inventing samples.
  const pointsPerHour12h = rate(current.find(r => timestamp(r.at) >= now - 12 * HOUR));
  const active = reset > now;
  const paceNeeded = latest && active ? Math.max(0, 98 - latest.pct) * HOUR / (reset - now) : null;
  const throttle = active && latest !== undefined && (latest.pct >= 98 || (pointsPerHour !== null && paceNeeded !== null && pointsPerHour > paceNeeded));
  const runOut = latest && pointsPerHour !== null && pointsPerHour > 0
    ? timestamp(latest.at) + (100 - latest.pct) * HOUR / pointsPerHour : null;
  return {
    latest: latest ?? null, resetAt: pool.resetAt, pointsPerHour, pointsPerHour12h, paceNeeded,
    projectedRunOutAt: active && runOut !== null ? new Date(runOut).toISOString() : null,
    throttle, preferMacPools: throttle, boxAgentTurnMultiplier: throttle ? 0.5 : 1,
    status: !active ? 'reset-expired' : !latest ? 'no-readings' : pointsPerHour === null ? 'insufficient-readings' : 'ready',
  };
}

export const fleetUsagePath = () => join(homedir(), '.ashlr', 'fleet.json');
export function readFleetUsage(path = fleetUsagePath()): FleetUsageConfig {
  const value = JSON.parse(readFileSync(path, 'utf8')) as FleetUsageConfig;
  if (!value || typeof value !== 'object' || !value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)) throw new Error('fleet.json must contain a usage pool map');
  for (const pool of Object.values(value.usage)) validate(pool);
  return value;
}
export function fleetUsageReport(config: FleetUsageConfig, now = Date.now()) {
  return { schemaVersion: 1, at: new Date(now).toISOString(), pools: Object.fromEntries(Object.entries(config.usage).map(([id, pool]) => [id, usagePacing(pool, now)])) };
}
export function addFleetUsage(id: string, pct: number, at: string, path = fleetUsagePath(), now = Date.now()): void {
  validate({ resetAt: at, readings: [{ pct, at }] });
  if (timestamp(at) > now) throw new Error('Reading cannot be in the future');
  const lock = acquireLocalStoreLock(`${path}.lock`);
  if (!lock) throw new Error('Fleet usage store is busy or unavailable');
  try {
    const config = readFleetUsage(path);
    if (!Object.hasOwn(config.usage, id)) throw new Error('Unknown usage pool');
    const pool = config.usage[id];
    if (timestamp(at) >= timestamp(pool.resetAt)) throw new Error('Update the pool resetAt before recording a new window');
    if (pool.readings.some(r => timestamp(r.at) >= timestamp(at))) throw new Error('Readings must have strictly increasing timestamps');
    pool.readings.push({ pct, at: new Date(timestamp(at)).toISOString() });
    writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, `${JSON.stringify(config, null, 2)}\n`, { anchorPath: dirname(path), label: 'Fleet usage' });
  } finally { releaseLocalStoreLock(lock); }
}
