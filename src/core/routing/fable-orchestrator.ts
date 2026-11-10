/** Fable is a subscription planning resource, never a coding lottery arm.
 * Percentages below are points of the SAME overall Claude weekly allowance.
 * A model-specific usage-window percentage is not interchangeable with them. */
export const FABLE_ORCHESTRATOR_MODEL = 'claude-fable-5-2';
export type FableRole = 'leader' | 'intent-triage' | 'architecture' | 'bottlenecks' | 'review' | 'decomposition' | 'coding';
export interface FableWork {
  role: FableRole;
  tier?: string;
  failures?: number;
  securitySensitive?: boolean;
}
export function fableRoleEligible(work: FableWork): boolean {
  if (work.role === 'coding') return false;
  if (['leader', 'intent-triage', 'architecture', 'bottlenecks'].includes(work.role)) return true;
  return work.tier === 'frontier' || work.tier === 'top' || (work.failures ?? 0) >= 2 || work.securitySensitive === true;
}
export function clampFableShare(value: number): number {
  return Number.isFinite(value) ? Math.min(50, Math.max(0, value)) : 0;
}
export interface FableWeeklyReading {
  observedAtMs: number;
  resetAtMs: number;
  claudeWeeklyUsedPercent: number;
  fableOverallWeeklyUsedPercent: number;
  codingBurnPercentPerHour: number;
  nextPlanPercent: number;
}
export interface FablePlan {
  allowed: boolean;
  reason: 'ready' | 'role' | 'billing-stop' | 'unknown' | 'reserve' | 'allowance' | 'pace';
  sharePercent: number;
  observedAtMs: number | null;
  reservePercent: number | null;
  targetPercent: number | null;
  claudeWeeklyUsedPercent: number | null;
  fableOverallWeeklyUsedPercent: number | null;
}
export function planFable(work: FableWork, reading: FableWeeklyReading | null, share: number, disabled: boolean, nowMs: number): FablePlan {
  const result: FablePlan = { allowed: false, reason: 'unknown', sharePercent: clampFableShare(share), observedAtMs: null, reservePercent: null,
    targetPercent: null, claudeWeeklyUsedPercent: null, fableOverallWeeklyUsedPercent: null };
  if (disabled) result.reason = 'billing-stop';
  else if (!fableRoleEligible(work)) result.reason = 'role';
  if (!reading || !(['observedAtMs', 'resetAtMs', 'claudeWeeklyUsedPercent', 'fableOverallWeeklyUsedPercent', 'codingBurnPercentPerHour', 'nextPlanPercent'] as const).every(key => Number.isFinite(reading[key])) || reading.observedAtMs > nowMs ||
    nowMs - reading.observedAtMs >= 15 * 60_000 || reading.resetAtMs <= nowMs || reading.resetAtMs - nowMs > 7 * 86400_000 ||
    reading.codingBurnPercentPerHour < 0 || reading.nextPlanPercent <= 0 ||
    reading.claudeWeeklyUsedPercent < 0 || reading.claudeWeeklyUsedPercent > 100 ||
    reading.fableOverallWeeklyUsedPercent < 0 || reading.fableOverallWeeklyUsedPercent > reading.claudeWeeklyUsedPercent) return result;
  const hours = (reading.resetAtMs - nowMs) / 3600_000;
  const reserve = Math.min(100, reading.codingBurnPercentPerHour * hours);
  // Linear weekly target drains the allowance toward reset, while one measured
  // planning invocation of slack avoids starving work at the start of a week.
  const target = result.sharePercent * (1 - hours / 168);
  Object.assign(result, { observedAtMs: reading.observedAtMs, reservePercent: reserve, targetPercent: target,
    claudeWeeklyUsedPercent: reading.claudeWeeklyUsedPercent, fableOverallWeeklyUsedPercent: reading.fableOverallWeeklyUsedPercent });
  if (disabled || !fableRoleEligible(work)) return result;
  if (reading.fableOverallWeeklyUsedPercent + reading.nextPlanPercent > result.sharePercent) return { ...result, reason: 'allowance' };
  if (reading.claudeWeeklyUsedPercent + reading.nextPlanPercent + reserve > 100) return { ...result, reason: 'reserve' };
  if (reading.fableOverallWeeklyUsedPercent > target) return { ...result, reason: 'pace' };
  return { ...result, allowed: true, reason: 'ready' };
}
export type FableBillingReason = 'fallback-credit' | 'billing-error' | 'http-402' | 'credit-balance-low';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Inspect upstream protocol fields only; never log the payload or monetary value. */
export function fableBillingReason(response: unknown): FableBillingReason | null {
  if (!record(response)) return null;
  if (response.type === 'stream_event' && record(response.event)) return fableBillingReason(response.event);
  if (response.type === 'assistant' && record(response.message)) return fableBillingReason(response.message);
  if (record(response.usage) && response.usage.fallback_credit !== undefined && response.usage.fallback_credit !== null) return 'fallback-credit';
  if (response.status === 402 || response.status_code === 402) return 'http-402';
  const error = record(response.error) ? response.error : response;
  if (error.status === 402 || error.status_code === 402) return 'http-402';
  if (error.type === 'billing_error') return 'billing-error';
  const message = typeof response.error === 'string' ? response.error :
    response.is_error === true && typeof response.result === 'string' ? response.result : error.message;
  if (typeof message === 'string' && /Credit balance is too low/i.test(message)) return 'credit-balance-low';
  return null;
}
