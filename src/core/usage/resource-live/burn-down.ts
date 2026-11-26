/**
 * Burn-down plan. Per allowance: target rate = remaining / time to its
 * deadline, so each one reaches about zero as it resets or expires.
 *
 * Spend order: free and expiring allowances, then included subscriptions,
 * then the included credit on a metered lane, then reserve lanes.
 *
 * The plan orders and paces. It does not set slots. Lane targets, floors and
 * ceilings stay with their owners, so an existing steady-load rule keeps its
 * share: an allowance with no verified reading is `steady`, which means "do
 * not change what you were doing". Only two cases hold a lane: an allowance
 * that is used up until its reset, and a metered lane whose included credit
 * is spent or cannot be verified, because past that point every call is new
 * spend.
 */
import type {
  BurnDownPace, BurnDownPlan, BurnDownRow, HistorySample, ResourceLiveId, ResourceLiveReading,
} from './types.js';
import { RESOURCE_LIVE_STALE_MS } from './types.js';

/** Observed rate within this share of the target is on pace. */
export const PACE_TOLERANCE = 0.15;
/** Samples the observed rate may span. */
export const BURN_SAMPLES = 6;

const TIER: Record<ResourceLiveReading['class'], 0 | 1 | 2 | 3> = {
  free: 0, expiring: 0, included: 1, 'metered-included': 2, reserve: 3,
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function future(iso: string | null, nowMs: number): number | null {
  const at = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(at) && at > nowMs ? at : null;
}

/** Units per hour across samples of the current window. Null until two samples agree. */
export function observedRate(samples: readonly HistorySample[] | undefined, resetAt: string | null): number | null {
  const points = (samples ?? [])
    .filter(sample => sample.reset_at === resetAt && Number.isFinite(Date.parse(sample.observed_at)))
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
    .slice(-BURN_SAMPLES);
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const hours = (Date.parse(last.observed_at) - Date.parse(first.observed_at)) / 3_600_000;
  if (!(hours > 0) || last.used < first.used) return null;
  return (last.used - first.used) / hours;
}

function current(reading: ResourceLiveReading, nowMs: number): boolean {
  if (!reading.verified || reading.observed_at === null) return false;
  const observed = Date.parse(reading.observed_at);
  const deadline = reading.stale_after === null ? observed + RESOURCE_LIVE_STALE_MS : Date.parse(reading.stale_after);
  return Number.isFinite(observed) && observed <= nowMs && Number.isFinite(deadline) && nowMs < deadline;
}

function planRow(reading: ResourceLiveReading, samples: readonly HistorySample[] | undefined, nowMs: number): Omit<BurnDownRow, 'rank'> {
  const expiry = future(reading.expires_at, nowMs);
  const expired = reading.expires_at !== null && expiry === null;
  // An expiring allowance past its end date is an ordinary included lane with nothing special to spend.
  const tier = expired ? 1 : TIER[reading.class];
  const base = {
    id: reading.id, lane: reading.lane, tier, remaining: null, unit: reading.unit, deadline_at: null,
    hours_to_deadline: null, target_rate_per_hour: null, observed_rate_per_hour: null,
    pace: 'unknown' as BurnDownPace, projected_unused: null,
  };
  const metered = reading.class === 'metered-included';
  if (reading.custom?.kind === 'metered' && !reading.custom.metered_opt_in) {
    return { ...base, action: 'hold', reason: 'Metered use requires explicit opt-in.' };
  }
  if (reading.custom && expired) return { ...base, action: 'hold', reason: 'The registered allowance expired.' };
  if (metered && expired) return { ...base, action: 'hold', reason: 'Included credit expired. Past it every call is new spend.' };
  if (!current(reading, nowMs)) {
    if (metered) return { ...base, action: 'hold', reason: 'Included credit is not verified. Past it every call is new spend.' };
    if (reading.class === 'reserve') return { ...base, action: 'reserve', reason: 'Reserve lane. No verified reading.' };
    return { ...base, action: 'steady', reason: 'No verified reading. Existing lane rules apply unchanged.' };
  }
  const reset = future(reading.reset_at, nowMs);
  const deadlineMs = reset !== null && expiry !== null ? Math.min(reset, expiry) : reset ?? expiry;
  const deadline = deadlineMs === null ? null : new Date(deadlineMs).toISOString();
  const hours = deadlineMs === null ? null : (deadlineMs - nowMs) / 3_600_000;
  const measured = { ...base, remaining: reading.remaining, deadline_at: deadline, hours_to_deadline: hours === null ? null : round(hours) };
  // Local capacity has no allowance: nothing to pace, always worth using first.
  if (reading.remaining === null) {
    if (metered) return { ...measured, action: 'hold', reason: 'Included balance is unknown. Past it every call is new spend.' };
    if (reading.class === 'free') return { ...measured, action: 'burn', reason: 'Free capacity with no allowance. Use it first.' };
    if (reading.class === 'expiring' && !expired) return { ...measured, action: 'burn', reason: 'Zero-cost until it expires. Use it first.' };
    return { ...measured, action: 'steady', reason: 'Reading carries no remaining amount.' };
  }
  if (reading.remaining <= 0) {
    return { ...measured, action: 'hold', target_rate_per_hour: 0,
      reason: metered ? 'Included credit is spent. Past it every call is new spend.' : 'Used up until the reset. Other lanes keep running.' };
  }
  const rate = deadline === null ? null : observedRate(samples, deadline);
  const target = hours === null ? null : reading.remaining / hours;
  let pace: BurnDownPace = 'unknown';
  if (target !== null && rate !== null) {
    pace = rate < target * (1 - PACE_TOLERANCE) ? 'behind' : rate > target * (1 + PACE_TOLERANCE) ? 'ahead' : 'on-pace';
  }
  const paced = {
    ...measured,
    target_rate_per_hour: target === null ? null : round(target),
    observed_rate_per_hour: rate === null ? null : round(rate),
    pace,
    projected_unused: rate === null || hours === null ? null : round(Math.max(0, reading.remaining - rate * hours)),
  };
  if (reading.class === 'reserve') return { ...paced, action: 'reserve', reason: 'Reserve lane. Used after every other allowance.' };
  if (metered) return { ...paced, action: 'burn', reason: 'Spend only the included credit. Stop at zero.' };
  if (tier === 0) return { ...paced, action: 'burn', reason: expiry !== null ? 'Expires for good. Spend it before the end date.' : 'Free. Use it first.' };
  return { ...paced, action: 'burn', reason: target === null ? 'Included allowance with no known reset.' : 'Pace to about zero at the reset.' };
}

/** Share of the allowance that must be spent per hour. Higher is more urgent. Null sorts last. */
function urgency(row: Omit<BurnDownRow, 'rank'>, reading: ResourceLiveReading): number | null {
  if (row.action !== 'burn') return null;
  if (row.remaining === null) return Number.POSITIVE_INFINITY;
  if (row.target_rate_per_hour === null || reading.limit === null || !(reading.limit > 0)) return null;
  return row.target_rate_per_hour / reading.limit;
}

const ACTION_ORDER: Record<BurnDownRow['action'], number> = { burn: 0, steady: 1, reserve: 2, hold: 3 };

export function planBurnDown(
  readings: readonly ResourceLiveReading[],
  history: Partial<Record<ResourceLiveId, HistorySample[]>>,
  nowMs: number,
): BurnDownPlan {
  const rows = readings.map((reading, index) => {
    const row = planRow(reading, history[reading.id], nowMs);
    const wasteDeadline = row.action === 'burn' && row.deadline_at !== null &&
      ((row.projected_unused ?? 0) > 0 || (row.projected_unused === null && row.remaining !== null && row.remaining > 0
        && (reading.id === 'antigravity' || reading.class === 'metered-included' && reading.expires_at !== null)))
      ? Date.parse(row.deadline_at) : Infinity;
    return { row, index, wasteDeadline, urgency: urgency(row, reading) };
  });
  rows.sort((a, b) => a.wasteDeadline - b.wasteDeadline || a.row.tier - b.row.tier
    || ACTION_ORDER[a.row.action] - ACTION_ORDER[b.row.action]
    || (b.urgency ?? -1) - (a.urgency ?? -1)
    || a.index - b.index);
  const allowances: BurnDownRow[] = rows.map((entry, index) => ({ ...entry.row, rank: index + 1 }));
  // A lane is held when any of its allowances holds it (Claude weekly spent stops Fable too).
  const held = new Set(allowances.filter(row => row.action === 'hold' && row.lane !== null).map(row => row.lane!));
  const laneOrder: string[] = [];
  for (const row of allowances) {
    if (row.lane === null || held.has(row.lane) || laneOrder.includes(row.lane)) continue;
    laneOrder.push(row.lane);
  }
  return { generated_at: new Date(nowMs).toISOString(), lane_order: laneOrder, allowances };
}
