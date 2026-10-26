/**
 * Spend order for coding pools. This sits beside the resource assignment
 * planner and does not change its manifest. Unknown balance and unknown
 * expiry are valid. An unknown balance stays spendable until a conservative
 * per-day soft cap. A known expiry that has passed is not spendable.
 *
 * Order: soon-to-expire credits, then credits whose expiry is unknown, then
 * subscriptions, then local models that meet the tier floor, then metered APIs.
 * Headroom breaks ties inside a class. Unknown headroom ranks after a known one.
 */

export const POOL_BILLINGS = ['credit', 'subscription', 'metered', 'local'] as const;
export type PoolBilling = (typeof POOL_BILLINGS)[number];

export const TIER_FLOORS = ['local', 'cheap', 'workhorse', 'frontier'] as const;
export type TierFloor = (typeof TIER_FLOORS)[number];

/** One session or unit per day while the live balance is unknown. */
export const UNKNOWN_BALANCE_SOFT_CAP_PER_DAY = 1;

const TIER_RANK: Readonly<Record<TierFloor, number>> = { local: 0, cheap: 1, workhorse: 2, frontier: 3 };

export interface SpendPool {
  id: string;
  billing: PoolBilling;
  /** Null means the live balance was not read. */
  balance: number | null;
  /** Null means the expiry was not read. */
  expiresAt: string | null;
  usedToday: number;
  softCapPerDay: number;
  tier: TierFloor;
  /** Remaining headroom, 0-100. Null is unknown, not full. */
  headroomPercent: number | null;
  cooledUntilMs?: number | null;
  meteredOptIn?: boolean;
}

export interface RankSpendInput {
  nowMs: number;
  floor: TierFloor;
  meteredEnabled: boolean;
}

export function poolNeedsFigures(pool: Pick<SpendPool, 'balance' | 'expiresAt' | 'billing'>): boolean {
  if (pool.balance === null) return true;
  return pool.billing === 'credit' && pool.expiresAt === null;
}

function groupOf(pool: SpendPool, nowMs: number): number {
  if (pool.billing === 'credit') {
    const expiry = pool.expiresAt === null ? NaN : Date.parse(pool.expiresAt);
    if (Number.isFinite(expiry) && expiry > nowMs) return 0;
    return 1;
  }
  if (pool.billing === 'subscription') return 2;
  if (pool.billing === 'local') return 3;
  return 4;
}

export function spendablePool(pool: SpendPool, input: RankSpendInput): boolean {
  if (TIER_RANK[pool.tier] < TIER_RANK[input.floor]) return false;
  if (pool.billing === 'metered' && input.meteredEnabled !== true && pool.meteredOptIn !== true) return false;
  const cooled = pool.cooledUntilMs ?? null;
  if (cooled !== null && cooled > input.nowMs) return false;
  if (pool.expiresAt !== null) {
    const expiry = Date.parse(pool.expiresAt);
    if (Number.isFinite(expiry) && expiry <= input.nowMs) return false;
  }
  if (pool.balance !== null && pool.balance <= 0) return false;
  if (pool.balance === null && pool.usedToday >= pool.softCapPerDay) return false;
  return true;
}

/** Lower group first. Inside a group, more headroom, then an earlier known credit expiry, then id. */
export function rankSpendPools(pools: readonly SpendPool[], input: RankSpendInput): SpendPool[] {
  return pools.filter((pool) => spendablePool(pool, input)).sort((a, b) => {
    const group = groupOf(a, input.nowMs) - groupOf(b, input.nowMs);
    if (group !== 0) return group;
    if (groupOf(a, input.nowMs) === 0 && a.expiresAt && b.expiresAt && a.expiresAt !== b.expiresAt) {
      return Date.parse(a.expiresAt) - Date.parse(b.expiresAt);
    }
    const ah = a.headroomPercent === null ? -1 : a.headroomPercent;
    const bh = b.headroomPercent === null ? -1 : b.headroomPercent;
    if (ah !== bh) return bh - ah;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
