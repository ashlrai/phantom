/** Pure advisory projections. No slot, hold, reader or dispatch mutations. */
import type { SubscriptionUsage } from './subscription-usage.js';

export interface ResetWindowResource {
  resource: string;
  usedPercent: SubscriptionUsage['usedPercent'] | null;
  /** ISO reset instant, as supplied by the resource ledger. */
  resetAt: string | null;
  burnPctPerHour: number | null;
  running: number | null;
  target: number | null;
  expiresUnused: boolean;
}
export interface ResetWindowPlanRow extends ResetWindowResource {
  projectedPercentLeftAtReset: number | null;
  /** null means unknown or no finite exhaustion at zero burn. */
  hoursToEmpty: number | null;
  verdict: 'wasting' | 'on-pace' | 'overspending' | 'unknown';
  reason: string;
}

/** Rank expiring unused capacity first, then by nearest reset; never mutate input. */
export function resetWindowPlan(resources: readonly ResetWindowResource[], nowMs: number): ResetWindowPlanRow[] {
  const resetOrder = (value: string | null): number => {
    const parsed = value === null ? NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  return resources.map((resource): ResetWindowPlanRow => {
    const used = resource.usedPercent;
    const burn = resource.burnPctPerHour;
    const usageKnown = used !== null && Number.isFinite(used) && used >= 0 && used <= 100;
    const burnKnown = burn !== null && Number.isFinite(burn) && burn >= 0;
    const left = usageKnown ? 100 - used! : null;
    const hoursToEmpty = left === 0 ? 0 : left !== null && burnKnown && burn! > 0 ? left / burn! : null;
    const reset = resource.resetAt === null ? NaN : Date.parse(resource.resetAt);
    const hours = (reset - nowMs) / 3_600_000;
    const base = { ...resource, hoursToEmpty, projectedPercentLeftAtReset: null };
    if (!Number.isFinite(hours) || hours <= 0 || !usageKnown || !burnKnown) {
      return { ...base, verdict: 'unknown', reason: 'Usage, burn or a future reset is missing or invalid; refresh evidence.' };
    }
    const projectedPercentLeftAtReset = Math.max(0, left! - burn! * hours);
    const verdict = hoursToEmpty !== null && hoursToEmpty < hours ? 'overspending'
      : resource.expiresUnused && projectedPercentLeftAtReset > 0 ? 'wasting' : 'on-pace';
    const reason = verdict === 'overspending' ? `Empty in ${hoursToEmpty!.toFixed(1)}h, before reset in ${hours.toFixed(1)}h.`
      : verdict === 'wasting' ? `${projectedPercentLeftAtReset.toFixed(1)}% will expire unused in ${hours.toFixed(1)}h at current burn.`
      : `${projectedPercentLeftAtReset.toFixed(1)}% remains at reset in ${hours.toFixed(1)}h; current burn fits the window.`;
    return { ...base, projectedPercentLeftAtReset, verdict, reason };
  }).sort((a, b) => Number(b.verdict === 'wasting') - Number(a.verdict === 'wasting') ||
    resetOrder(a.resetAt) - resetOrder(b.resetAt));
}
