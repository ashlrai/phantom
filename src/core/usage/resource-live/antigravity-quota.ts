import { z } from 'zod';
import { IDLE_POLL_MS, nextResetCheck } from './cadence.js';
import type { AntigravityUsageGroup, PollState, ResourceLiveReading } from './types.js';

export const antigravityResetTime = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString());
export const antigravityGroupName = z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N} .&()+/'-]+$/u);
export const antigravityBucketIdentity = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i),
  window: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i),
};
export const antigravityGroupsSchema = z.array(z.object({
  name: antigravityGroupName,
  buckets: z.array(z.object({ ...antigravityBucketIdentity, remaining: z.number().min(0).max(1),
    reset_at: antigravityResetTime })).min(1).max(32),
})).min(1).max(32);

export const ANTIGRAVITY_SOURCE = 'antigravity-cli-status';
export const ANTIGRAVITY_EXHAUSTION = 'quota_exhausted_until_reset';
export const antigravityExecutionContext = z.enum(['gui-resident', 'ssh', 'unknown']);

export function antigravityPollState(reading: ResourceLiveReading, prior: PollState | undefined, poll: PollState, now: number): PollState {
  if (reading.execution_context === undefined && !prior?.reset_checks) return poll;
  const groups = reading.source === ANTIGRAVITY_SOURCE && reading.verified && reading.execution_context === 'gui-resident'
    ? reading.groups : undefined;
  const resets = groups ? groups.flatMap(group => group.buckets.map(bucket => bucket.reset_at))
    : reading.reason === 'identity_mismatch' || reading.reason === 'non_gui_context' ? [] : prior?.reset_checks ?? [];
  const reset_checks = [...new Set(resets)].filter(at => Date.parse(at) > now).sort();
  const interval = Math.min(groups ? IDLE_POLL_MS : 5 * 60_000,
    ...reset_checks.map(at => nextResetCheck(now, Date.parse(at)) - now));
  return { ...poll, reset_checks, interval_s: interval / 1000, next_poll_at: new Date(now + interval).toISOString() };
}

function antigravityExhaustedUntil(groups: AntigravityUsageGroup[], now: number): string | null {
  const groupResets = groups.map(group => {
    const exhausted = group.buckets.filter(bucket => bucket.remaining === 0 && Date.parse(bucket.reset_at) > now);
    return exhausted.map(bucket => bucket.reset_at).sort().at(-1);
  });
  return groupResets.length && groupResets.every(at => at !== undefined) ? groupResets.sort()[0]! : null;
}

export function antigravityQuota(reading: ResourceLiveReading | undefined, now: number) {
  const current = reading?.source === ANTIGRAVITY_SOURCE && reading.execution_context === 'gui-resident' && reading.verified && reading.observed_at &&
    Date.parse(reading.observed_at) <= now && reading.stale_after && now < Date.parse(reading.stale_after);
  const groups = current && reading.groups ? reading.groups.map(group => ({
    name: group.name,
    buckets: group.buckets.map(bucket => ({ ...bucket, remaining: Date.parse(bucket.reset_at) > now ? bucket.remaining : null })),
  })) : null;
  const exhaustedUntil = groups ? antigravityExhaustedUntil(reading!.groups!, now) : null;
  return { source: ANTIGRAVITY_SOURCE, execution_context: reading?.execution_context ?? 'unknown', groups, reset_at: exhaustedUntil,
    reason: exhaustedUntil ? ANTIGRAVITY_EXHAUSTION : groups ? null : reading?.reason ?? 'source-returned-nothing' };
}

export function formatAntigravityQuota(quota: ReturnType<typeof antigravityQuota>): string[] {
  const status = quota.groups ? quota.reason ?? 'official CLI quota' : `unknown (${quota.reason})`;
  return [`Antigravity (${quota.execution_context}): ${status}`, ...(quota.groups ?? []).flatMap(group => group.buckets.map(bucket => {
    const remaining = bucket.remaining === null ? 'unknown' : `${+(bucket.remaining * 100).toFixed(3)}% remaining`;
    return `  ${group.name} · ${bucket.id}: ${remaining} · resets ${bucket.reset_at}`;
  }))];
}
