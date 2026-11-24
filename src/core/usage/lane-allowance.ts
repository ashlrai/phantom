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
  /** When the measured window began, as its reading reports it; null when the reading names no start or is not usable. */
  windowStart: string | null;
  measuredAt: string | null; ageSeconds: number | null; freshness: 'live' | 'stale' | 'unknown' | 'invalid-future';
  posture: 'burn' | 'balanced' | 'preserve' | 'unknown'; postureReason: string | null;
  costClass: 'included' | 'metered' | 'api-credit' | 'unknown'; projectedUnusedPct: number | null;
  history: LaneHistory | null; reason: string | null;
  devin: { weeklyUsedAcu: number | null; weeklyAllowanceAcu: number | null; inFlightReservations: number | null;
    preview: { models: string[]; expiresAt: string; expired: boolean; free: boolean | null;
      evidence?: { observedAt: string; accountId: string; model: string } } | null } | null;
}
export interface LaneAllowanceSnapshot { v: 1; asOf: string; lanes: LaneAllowanceRow[] }
const amount = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const named = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fresh = (at: string | null | undefined, now: number): boolean => {
  const observed = at ? Date.parse(at) : NaN;
  return Number.isFinite(observed) && observed <= now && now - observed <= RESOURCE_LIVE_STALE_MS;
};

export function projectLaneAllowance(inputs: LaneAllowanceInputs, nowMs: number): LaneAllowanceSnapshot {
  const readings = parseResourceLiveSidecar(inputs.resourceLive).readings;
  const histories = projectLaneHistory(inputs.history, nowMs);
  const names = new Set([...RESOURCE_LIVE_ALLOWANCES.map(a => a.lane).filter((n): n is NonNullable<typeof n> => n !== null), ...Object.keys(inputs.posture?.lanes ?? {})]);
  const lanes = [...names].map((lane): LaneAllowanceRow => {
    const allowance = RESOURCE_LIVE_ALLOWANCES.find(a => a.lane === lane);
    const reading = readings.find(r => r.id === allowance?.id);
    const weekly = lane === 'devin' ? inputs.weekly : null;
    const useWeekly = weekly != null && weekly.state !== 'unmeasured';
    const scope = useWeekly ? weekly : reading;
    const windowStart = scope?.window_start ?? undefined;
    const measuredAt = useWeekly ? weekly.observed_at : reading?.observed_at ?? null;
    const observed = measuredAt ? Date.parse(measuredAt) : NaN;
    const future = Number.isFinite(observed) && observed > nowMs;
    const ageSeconds = Number.isFinite(observed) && observed <= nowMs ? (nowMs - observed) / 1000 : null;
    const measured = ageSeconds !== null && (useWeekly || reading?.verified === true);
    const stale = measured && (ageSeconds * 1000 > RESOURCE_LIVE_STALE_MS || weekly?.state === 'stale'
      || (!useWeekly && reading?.stale_after != null && Date.parse(reading.stale_after) < nowMs));
    const used = measured ? amount(useWeekly ? weekly.used : reading?.used) : null;
    const limit = measured ? amount(useWeekly ? weekly.limit : reading?.limit) : null;
    const unit = useWeekly ? 'acu' : reading?.unit ?? null;
    const resetAt = useWeekly ? weekly.reset_at : reading?.reset_at ?? null;
    const reset = resetAt ? Date.parse(resetAt) : NaN;
    const candidate = inputs.posture?.lanes[lane];
    const windowEnd = resetAt ?? reading?.expires_at;
    const p = candidate && named(scope?.account_id) && named(scope?.model)
      && !future && !stale
      && fresh(scope.observed_at, nowMs) && fresh(candidate.observedAt, nowMs)
      && (candidate.lane === undefined || candidate.lane === lane)
      && candidate.accountId === scope.account_id && candidate.model === scope.model
      && candidate.windowStart === windowStart && candidate.resetAt === windowEnd
      && windowEnd != null && Date.parse(windowEnd) > nowMs
      && (!windowStart || (Date.parse(windowStart) <= Date.parse(candidate.observedAt!)
        && Date.parse(windowStart) <= Date.parse(scope.observed_at!)))
      && Date.parse(candidate.observedAt!) < Date.parse(windowEnd) ? candidate : undefined;
    const posture = p && !stale && used !== null && limit !== null && ['burn', 'balanced', 'preserve'].includes(p.posture)
      ? p.posture as LaneAllowanceRow['posture'] : 'unknown';
    const previewLane = lane === 'devin' || lane === 'devin-flash';
    const previewReading = readings.find(r => r.id === 'devin-flash');
    const previewEnd = p?.previewExpiresAt ? Date.parse(p.previewExpiresAt) : NaN;
    const expiresAt = new Date(Math.min(Date.parse(DEVIN_FLASH_EXPIRES_AT),
      Number.isFinite(previewEnd) ? previewEnd : Infinity)).toISOString();
    const expired = nowMs >= Date.parse(expiresAt);
    const previewEvidence = !future && previewReading?.verified && previewReading.unit === 'models'
      && previewReading.source === 'devin-cli-models-list' && previewReading.account_id && previewReading.model
      && /^swe-2[\w.-]*(?:lightning|flash)[\w.-]*$/i.test(previewReading.model)
      && amount(previewReading.limit) !== null && previewReading.limit! > 0
      && previewReading.account_id === scope?.account_id && fresh(scope?.observed_at, nowMs) && !stale
      && fresh(previewReading.observed_at, nowMs)
      && (!previewReading.window_start || Date.parse(previewReading.window_start) <= Date.parse(previewReading.observed_at!))
      && (!previewReading.stale_after || Date.parse(previewReading.stale_after) >= nowMs)
      ? { observedAt: previewReading.observed_at!, accountId: previewReading.account_id, model: previewReading.model } : undefined;
    const free = expired ? false : previewEvidence && p?.freePreview !== false ? true : null;
    return { lane, label: allowance?.label ?? lane, used, limit, unit,
      left: used !== null && limit !== null ? Math.max(0, limit - used) : null,
      usedPct: used !== null && limit !== null && limit > 0 ? used / limit * 100 : null,
      resetAt, resetsInHours: Number.isFinite(reset) ? Math.max(0, (reset - nowMs) / 3_600_000) : null,
      windowStart: measured && windowStart !== undefined && Number.isFinite(reset) && Date.parse(windowStart) < reset ? windowStart : null,
      measuredAt, ageSeconds, freshness: future ? 'invalid-future' : !measured ? 'unknown' : stale ? 'stale' : 'live', posture,
      postureReason: posture === 'unknown' ? 'posture-unmeasured' : p?.postureReason ?? 'posture-unmeasured',
      costClass: measured && !stale && unit === 'usd' ? 'api-credit'
        : p?.costClass === 'included' || p?.costClass === 'metered' ? p.costClass : 'unknown',
      projectedUnusedPct: posture === 'unknown' ? null : p?.projectedUnusedPct ?? null, history: histories[allowance?.sensor_lane ?? lane] ?? null,
      reason: future ? 'invalid-future' : !measured ? 'reading-missing' : stale ? 'reading-stale' : used === null || limit === null ? 'reading-incomplete' : !Number.isFinite(reset) ? 'reset-unknown' : reset <= nowMs ? 'reset-passed' : null,
      devin: previewLane ? { weeklyUsedAcu: fresh(inputs.weekly?.observed_at, nowMs) ? amount(inputs.weekly?.used) : null,
        weeklyAllowanceAcu: fresh(inputs.weekly?.observed_at, nowMs) ? amount(inputs.weekly?.limit) : null,
        inFlightReservations: amount(p?.allowance?.in_flight), preview: { models: ['SWE-2 Lightning', 'SWE-2 Flash'],
          expiresAt, expired, free, ...(previewEvidence ? { evidence: previewEvidence } : {}) } } : null };
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
