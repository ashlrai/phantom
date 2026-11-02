/** Read-only account pool projection for phm top. */
import { loadBudgetPolicy, readCapacitySnapshot } from './routing/budget-store.js';
import type { SeatCapacity } from './routing/headroom.js';
import { effectiveSeatPolicy } from './routing/policy.js';
import { assessResetOpportunity } from './routing/reset-pressure.js';
import type { AccountSchedulingView } from './routing/scheduling-types.js';
import type { BudgetPolicy } from './routing/types.js';
import { subscriptionUsage, type SubscriptionUsage } from './fleet/subscription-usage.js';

export interface TopPoolsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  source: 'capacity-snapshot' | 'missing';
  pools: Array<{ poolId: string; engine: string; scheduling: AccountSchedulingView | null }>;
  /** Local engine signal only, never evidence for a specific account. */
  localSubscriptionUsage: { claude: SubscriptionUsage | null; codex: SubscriptionUsage | null };
}

export function projectTopPools(seats: SeatCapacity[] | null, policy: BudgetPolicy, nowMs: number,
  localSubscriptionUsage: TopPoolsSnapshot['localSubscriptionUsage']): TopPoolsSnapshot {
  const pools: TopPoolsSnapshot['pools'] = (seats ?? []).map(seat => ({
    poolId: seat.seatId, engine: seat.engine,
    scheduling: assessResetOpportunity(seat, effectiveSeatPolicy(policy, seat.seatId, seat.engine), nowMs),
  }));
  if (!pools.some(row => row.poolId === 'codex-personal')) {
    pools.push({ poolId: 'codex-personal', engine: 'codex', scheduling: null });
  }
  pools.sort((a, b) => a.poolId.localeCompare(b.poolId, 'en'));
  return { schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(),
    source: seats === null ? 'missing' : 'capacity-snapshot', pools, localSubscriptionUsage };
}

export function collectTopPools(): TopPoolsSnapshot {
  return projectTopPools(readCapacitySnapshot()?.seats ?? null, loadBudgetPolicy(), Date.now(), {
    claude: subscriptionUsage('claude'), codex: subscriptionUsage('codex'),
  });
}
