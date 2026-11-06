/** Advisory only. Usage and cost must share units; no dispatch or reset purchase authority. */
export interface WasteRiskInput {
  lane: string;
  used: number | null;
  limit: number | null;
  window_start: string | null;
  reset_at: string | null;
  now: string;
  /** Observed six-hour EWMA usage/hour from jobs, supplied by the caller. */
  burn_per_hour: number | null;
  running: number;
  per_job_cost: number | null;
  ceiling: number;
  held?: boolean;
  /** Optional measured duration, needed to bootstrap a target without live burn. */
  job_duration_hours?: number;
  /** Remaining prepaid credit in usage units. Required for paid-overage lanes. */
  credit_guard?: number | null;
  overage_costs_money?: boolean;
}

export interface WasteRiskProjection {
  lane: string;
  reset_at: string | null;
  hours_to_reset: number | null;
  window_remaining_fraction: number | null;
  projected_used_at_reset: number | null;
  projected_unused_at_reset: number | null;
  waste_risk: 'unknown' | 'low' | 'medium' | 'high';
  recommended_target: number | null;
}

const nonnegative = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;
const timestamp = (s: string | null): number => s === null ? NaN : Date.parse(s);

/** Pure projection. Unknown/stale windows never imply a refill or invented throughput. */
export function projectWasteRisk(input: WasteRiskInput): WasteRiskProjection {
  const reset = timestamp(input.reset_at);
  const start = timestamp(input.window_start);
  const now = timestamp(input.now);
  const validWindow = Number.isFinite(now) && Number.isFinite(start) &&
    Number.isFinite(reset) && start <= now && now < reset && start < reset;
  const hours = validWindow ? (reset - now) / 3_600_000 : null;
  const fraction = validWindow ? (reset - now) / (reset - start) : null;
  const result: WasteRiskProjection = {
    lane: input.lane, reset_at: input.reset_at, hours_to_reset: hours,
    window_remaining_fraction: fraction, projected_used_at_reset: null,
    projected_unused_at_reset: null, waste_risk: 'unknown', recommended_target: null,
  };
  const ceiling = nonnegative(input.ceiling) ? Math.floor(input.ceiling) : 0;
  if (input.held) result.recommended_target = 0;
  if (hours === null || !nonnegative(input.used) || !nonnegative(input.limit) || input.limit === 0) return result;
  const remaining = Math.max(0, input.limit - input.used);
  if (remaining === 0) result.recommended_target = 0;
  if (!nonnegative(input.burn_per_hour)) return result;
  // Included usage is capped at its allowance, even when a lane can incur overage.
  const projected = Math.min(input.limit, input.used + input.burn_per_hour * hours);
  const unused = Math.max(0, input.limit - projected);
  result.projected_used_at_reset = projected;
  result.projected_unused_at_reset = unused;
  result.waste_risk = unused > input.limit * 0.15 && fraction! < 0.4
    ? 'high' : unused > input.limit * 0.05 ? 'medium' : 'low';
  if (input.held || remaining === 0) return result;
  const paid = input.lane === 'claude-api' || input.overage_costs_money === true;
  // Paid lanes fail closed without an explicit prepaid guard.
  const credit = paid ? (nonnegative(input.credit_guard) ? input.credit_guard : 0) : remaining;
  if (credit === 0 || ceiling === 0) { result.recommended_target = 0; return result; }
  if (!nonnegative(input.running) || !Number.isInteger(input.running) ||
      !nonnegative(input.per_job_cost) || input.per_job_cost === 0) return result;
  const duration = nonnegative(input.job_duration_hours) && input.job_duration_hours > 0
    ? input.job_duration_hours
    : input.running > 0 && input.burn_per_hour > 0
      ? input.running * input.per_job_cost / input.burn_per_hour : null;
  if (duration === null) return result;
  const desired = Math.max(0, input.limit * 0.97 - input.used);
  const ratePerWorker = input.per_job_cost / duration;
  const target = Math.ceil(Math.min(desired, credit) / (hours * ratePerWorker));
  // Total concurrency includes running jobs. No new job may consume guarded credit.
  const affordable = Math.floor(Math.min(remaining, credit) / input.per_job_cost);
  const guardedTarget = paid ? Math.floor(credit / (hours * ratePerWorker)) : ceiling;
  result.recommended_target = Math.min(ceiling, affordable, guardedTarget, target);
  return result;
}
