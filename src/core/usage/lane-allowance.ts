import { homedir } from 'node:os';
import { join } from 'node:path';
import { postureEvidence } from '../queue/route-explain.js';
import { readPublishedDevinWeekly, type DevinWeeklyCapacity } from '../devin/weekly-capacity.js';
import { parseResourceLiveSidecar, readResourceLiveFile, readResourceHistoryFile } from './resource-live/store.js';
import { projectLaneHistory } from './resource-live/history.js';
import { DEVIN_FLASH_EXPIRES_AT, RESOURCE_LIVE_ALLOWANCES, RESOURCE_LIVE_STALE_MS, type LaneHistory, type ResourceLiveUnit } from './resource-live/types.js';

type Posture = NonNullable<Awaited<ReturnType<typeof postureEvidence>>>;
export interface LaneAllowanceInputs {
  resourceLive?: unknown;
  history?: unknown;
  posture?: Posture | null;
  weekly?: DevinWeeklyCapacity | null;
}
export interface LaneAllowanceRow {
  lane: string; label: string; used: number | null; limit: number | null; left: number | null;
  unit: ResourceLiveUnit | null; usedPct: number | null; resetAt: string | null; resetsInHours: number | null;
  measuredAt: string | null; ageSeconds: number | null; freshness: 'live' | 'stale' | 'unknown';
  posture: 'burn' | 'balanced' | 'preserve' | 'unknown'; postureReason: string | null;
  costClass: 'included' | 'metered' | 'api-credit' | 'unknown'; projectedUnusedPct: number | null;
  history: LaneHistory | null; reason: string | null;
  devin: { weeklyUsedAcu: number | null; weeklyAllowanceAcu: number | null; inFlightReservations: number | null;
    preview: { models: string[]; expiresAt: string; expired: boolean; free: boolean | null } | null } | null;
}
export interface LaneAllowanceSnapshot { v: 1; asOf: string; lanes: LaneAllowanceRow[] }
const amount = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

export function projectLaneAllowance(inputs: LaneAllowanceInputs, nowMs: number): LaneAllowanceSnapshot {
  const readings = parseResourceLiveSidecar(inputs.resourceLive).readings;
  const histories = projectLaneHistory(inputs.history, nowMs);
  const names = new Set([...RESOURCE_LIVE_ALLOWANCES.map(a => a.lane).filter((n): n is NonNullable<typeof n> => n !== null), ...Object.keys(inputs.posture?.lanes ?? {})]);
  const lanes = [...names].map((lane): LaneAllowanceRow => {
    const allowance = RESOURCE_LIVE_ALLOWANCES.find(a => a.lane === lane);
    const reading = readings.find(r => r.id === allowance?.id);
    const weekly = lane === 'devin' ? inputs.weekly : null;
    const useWeekly = weekly != null && weekly.state !== 'unmeasured';
    const measuredAt = useWeekly ? weekly.observed_at : reading?.observed_at ?? null;
    const observed = measuredAt ? Date.parse(measuredAt) : NaN;
    const ageSeconds = Number.isFinite(observed) && observed <= nowMs ? (nowMs - observed) / 1000 : null;
    const measured = ageSeconds !== null && (useWeekly || reading?.verified === true);
    const stale = measured && (ageSeconds * 1000 > RESOURCE_LIVE_STALE_MS || weekly?.state === 'stale'
      || (reading?.stale_after != null && Date.parse(reading.stale_after) < nowMs));
    const used = measured ? amount(useWeekly ? weekly.used : reading?.used) : null;
    const limit = measured ? amount(useWeekly ? weekly.limit : reading?.limit) : null;
    const unit = useWeekly ? 'acu' : reading?.unit ?? null;
    const resetAt = useWeekly ? weekly.reset_at : reading?.reset_at ?? null;
    const reset = resetAt ? Date.parse(resetAt) : NaN;
    const p = inputs.posture?.lanes[lane];
    const posture = p && ['burn', 'balanced', 'preserve'].includes(p.posture) ? p.posture as LaneAllowanceRow['posture'] : 'unknown';
    const previewLane = lane === 'devin' || lane === 'devin-flash';
    const previewReading = readings.find(r => r.id === 'devin-flash');
    const expiresAt = p?.previewExpiresAt ?? DEVIN_FLASH_EXPIRES_AT;
    const expired = nowMs >= Date.parse(expiresAt);
    return { lane, label: allowance?.label ?? lane, used, limit, unit,
      left: used !== null && limit !== null ? Math.max(0, limit - used) : null,
      usedPct: used !== null && limit !== null && limit > 0 ? used / limit * 100 : null,
      resetAt, resetsInHours: Number.isFinite(reset) ? Math.max(0, (reset - nowMs) / 3_600_000) : null,
      measuredAt, ageSeconds, freshness: !measured ? 'unknown' : stale ? 'stale' : 'live', posture,
      postureReason: p?.postureReason ?? 'posture-unmeasured',
      costClass: unit === 'usd' || lane === 'claude-api' ? 'api-credit' : p?.costClass === 'included' || p?.costClass === 'metered' ? p.costClass : 'unknown',
      projectedUnusedPct: p?.projectedUnusedPct ?? null, history: histories[allowance?.sensor_lane ?? lane] ?? null,
      reason: !measured ? 'reading-missing' : stale ? 'reading-stale' : used === null || limit === null ? 'reading-incomplete' : !Number.isFinite(reset) ? 'reset-unknown' : reset <= nowMs ? 'reset-passed' : null,
      devin: previewLane ? { weeklyUsedAcu: amount(inputs.weekly?.used), weeklyAllowanceAcu: amount(inputs.weekly?.limit),
        inFlightReservations: amount(p?.allowance?.in_flight), preview: { models: ['SWE-2 Lightning', 'SWE-2 Flash'],
          expiresAt, expired, free: expired ? false : p?.freePreview ?? (previewReading?.verified && previewReading.unit === 'models' && previewReading.observed_at !== null && nowMs - Date.parse(previewReading.observed_at) <= RESOURCE_LIVE_STALE_MS ? true : null) } } : null };
  });
  return { v: 1, asOf: new Date(nowMs).toISOString(), lanes };
}

export async function readLaneAllowance(deps: { runsDir?: string; weeklyFile?: string; nowMs?: number } = {}): Promise<LaneAllowanceSnapshot> {
  const runs = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = deps.nowMs ?? Date.now();
  const [resourceLive, history, posture] = await Promise.all([readResourceLiveFile(runs), readResourceHistoryFile(runs), postureEvidence(runs)]);
  const weekly = readPublishedDevinWeekly(now, deps.weeklyFile);
  return projectLaneAllowance({ resourceLive, history, posture, weekly }, now);
}
