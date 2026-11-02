import type { GrokUltraReading, GrokUltraRunway } from './grok-ultra-types.js';

// Nov 1 is EST (UTC-05), after the autumn clock change that morning.
export const GROK_ULTRA_TARGET = '2026-11-02T01:21:00.000Z';
export const GROK_ULTRA_SAMPLE_MS = 10 * 60_000;
export const GROK_ULTRA_MAX_READINGS = 10_000;
const HOUR = 3_600_000;

export function validGrokUltraReading(value: unknown): value is GrokUltraReading {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 4 && (r.source === 'manual' || r.source === 'app-local') &&
    typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) &&
    new Date(r.timestamp).toISOString() === r.timestamp &&
    typeof r.totalPoints === 'number' && Number.isFinite(r.totalPoints) && r.totalPoints > 0 &&
    typeof r.remainingPoints === 'number' && Number.isFinite(r.remainingPoints) &&
    r.remainingPoints >= 0 && r.remainingPoints <= r.totalPoints;
}

/** Full-window averages with linear interpolation at the left boundary.
 * No extrapolation backwards, across a replenishment, or from stale readings.
 */
export function buildGrokUltraRunway(readings: readonly GrokUltraReading[], now = Date.now()): GrokUltraRunway {
  const result: GrokUltraRunway = {
    v: 1, state: 'manual-required', checkedAt: new Date(now).toISOString(), targetAt: GROK_ULTRA_TARGET,
    collection: { mode: 'manual', reason: 'safe-local-source-unavailable' }, latest: null,
    burnPointsPerHour: { h1: null, h6: null, h24: null },
    projectedRemainingPoints: { h1: null, h6: null, h24: null }, idealPointsPerHour: null,
  };
  if (readings.length === 0) return result;
  // Reject malformed, future, duplicate or unordered evidence as a whole.
  if (readings.length > GROK_ULTRA_MAX_READINGS || readings.some((r, i) =>
    !validGrokUltraReading(r) || Date.parse(r.timestamp) > now ||
    i > 0 && Date.parse(r.timestamp) <= Date.parse(readings[i - 1]!.timestamp))) {
    result.state = 'unavailable'; return result;
  }
  const latest = readings.at(-1)!;
  result.latest = { ...latest };
  const latestAt = Date.parse(latest.timestamp);
  if (now - latestAt > 2 * GROK_ULTRA_SAMPLE_MS) { result.state = 'stale'; return result; }
  result.state = 'current';
  const hoursLeft = (Date.parse(GROK_ULTRA_TARGET) - latestAt) / HOUR;
  const ideal = latest.remainingPoints / hoursLeft;
  if (Date.parse(GROK_ULTRA_TARGET) > now && Number.isFinite(ideal)) result.idealPointsPerHour = ideal;

  // A balance increase or capacity change starts a new accounting segment.
  // Without a provider cycle identifier it would be unsafe to join the two.
  let start = readings.length - 1;
  while (start > 0 && readings[start - 1]!.totalPoints === latest.totalPoints &&
    readings[start - 1]!.source === latest.source &&
    readings[start - 1]!.remainingPoints >= readings[start]!.remainingPoints) start--;
  const segment = readings.slice(start);
  for (const [key, hours] of [['h1', 1], ['h6', 6], ['h24', 24]] as const) {
    const boundary = latestAt - hours * HOUR;
    let before = segment.length - 1;
    while (before >= 0 && Date.parse(segment[before]!.timestamp) > boundary) before--;
    if (before < 0) continue;
    const left = segment[before]!;
    let balance = left.remainingPoints;
    if (Date.parse(left.timestamp) !== boundary) {
      const right = segment[before + 1]!;
      const fraction = (boundary - Date.parse(left.timestamp)) /
        (Date.parse(right.timestamp) - Date.parse(left.timestamp));
      balance += (right.remainingPoints - balance) * fraction;
    }
    const rate = (balance - latest.remainingPoints) / hours;
    if (!Number.isFinite(rate)) continue;
    result.burnPointsPerHour[key] = rate;
    // Negative landing values deliberately retain the predicted shortfall.
    const projection = latest.remainingPoints - rate * hoursLeft;
    if (Date.parse(GROK_ULTRA_TARGET) > now && Number.isFinite(projection)) {
      result.projectedRemainingPoints[key] = projection;
    }
  }
  return result;
}
