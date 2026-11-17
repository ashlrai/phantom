import { parseResourceHistory, readResourceHistoryFile } from './store.js';
import { RESOURCE_LIVE_ALLOWANCES, RESOURCE_HISTORY_SCHEMA, type LaneHistory, type ResourceHistoryPoint } from './types.js';

export function summarizeHistory(points: readonly ResourceHistoryPoint[], nowMs: number): LaneHistory {
  const latest = points.at(-1);
  const buckets = new Map<number, LaneHistory['points'][number]>();
  points.forEach((p, i) => {
    const bucket = Math.floor(Date.parse(p.observed_at) / 3_600_000);
    buckets.set(bucket, {
      observedAt: p.observed_at, used: p.used, left: p.left, limit: p.limit, unit: p.unit, source: p.source,
      confidence: p.confidence, gapBefore: buckets.get(bucket)?.gapBefore === true
        || (i > 0 && Date.parse(p.observed_at) - Date.parse(points[i - 1]!.observed_at) > 1_800_000),
    });
  });
  const window: ResourceHistoryPoint[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    const next = points[i + 1];
    if (Date.parse(p.observed_at) < nowMs - 6 * 3_600_000 || p.reset_at !== latest?.reset_at
      || (next && (p.used > next.used || Date.parse(next.observed_at) - Date.parse(p.observed_at) > 1_800_000))) break;
    window.unshift(p);
  }
  const first = window[0];
  const hours = first && latest ? (Date.parse(latest.observed_at) - Date.parse(first.observed_at)) / 3_600_000 : 0;
  const burn = latest && first && window.length >= 2 && hours >= 0.25
    ? { perHour: (latest.used - first.used) / hours, from: first.observed_at, to: latest.observed_at } : null;
  const exhaustMs = latest && burn && burn.perHour > 0 && latest.left !== null
    ? Date.parse(latest.observed_at) + latest.left / burn.perHour * 3_600_000 : NaN;
  return { points: [...buckets.values()].map((p, i) => i === 0 ? { ...p, gapBefore: false } : p), burn, exhaustAt: Number.isFinite(exhaustMs) && Math.abs(exhaustMs) <= 8.64e15
    ? new Date(exhaustMs).toISOString() : null, resetAt: latest?.reset_at ?? null };
}

export function projectLaneHistory(raw: unknown, nowMs: number): Record<string, LaneHistory> {
  const file = parseResourceHistory(raw, nowMs);
  const seen = new Set<string>();
  return Object.fromEntries(RESOURCE_LIVE_ALLOWANCES.flatMap(a => {
    if (!a.sensor_lane || seen.has(a.sensor_lane)) return [];
    seen.add(a.sensor_lane);
    const points = file.allowances[a.id];
    return a.sensor_lane && points?.length ? [[a.sensor_lane, summarizeHistory(points, nowMs)]] : [];
  }));
}

export async function readLaneHistory(id: string, runsDir: string, nowMs = Date.now()) {
  const allowance = RESOURCE_LIVE_ALLOWANCES.find(a => a.id === id || a.lane === id || a.sensor_lane === id);
  if (!allowance) return null;
  const points = parseResourceHistory(await readResourceHistoryFile(runsDir), nowMs).allowances[allowance.id] ?? [];
  const { burn, exhaustAt, resetAt } = summarizeHistory(points, nowMs);
  return { schema: RESOURCE_HISTORY_SCHEMA, lane: allowance.sensor_lane ?? allowance.lane, id: allowance.id, points, burn, exhaustAt, resetAt };
}
