/**
 * RQ-V4ASKFANOUT2Q7. Bounds an ask fan-out breadth by the pool budget the
 * fleet ledger has actually observed (fleet/pool-budget.ts). Every sibling job
 * a fanned-out ask emits is estimated to consume `perJobUnits` of each bucket
 * the pool meters, so the granted breadth is the largest one every observed
 * balance affords.
 *
 * Advisory, narrowing only — the same standing the ledger itself holds. An
 * unobserved balance (never read, or reset-pending past its window) is
 * UNKNOWN: the ledger never assumes a refill, and this cap never assumes a
 * balance either, so a missing or stale observation cannot fabricate a limit
 * or wedge a pool behind one stale file. A `held` pool is a policy hold, not
 * telemetry — its fan-out is always 0. Pool names outside the ledger's
 * whitelist are untracked and pass through whole.
 *
 * `capAskFanoutByBudget` is a pure projection over a caller-supplied snapshot;
 * `capAskFanoutFromLedger` is the one-line read path for real callers.
 */
import {
  BUDGET_POOLS,
  type BudgetBucket,
  type BudgetBucketView,
  type BudgetPool,
  type PoolBudgetSnapshot,
} from '../fleet/pool-budget.js';
import { readPoolBudgets } from '../fleet/pool-budget-store.js';

/** Default estimate: one fanned-out job consumes one unit of each metered bucket. */
export const ASK_FANOUT_PER_JOB_UNITS = 1;

export interface AskFanoutBudgetCap {
  /** Pool name from the ask record (free-form; untracked pools never cap). */
  pool: string;
  /** Breadth the fan-out asked for. */
  requested: number;
  /** Breadth the observed budget affords; 0 ≤ granted ≤ requested. */
  granted: number;
  /** What bound the cap: the tightest bucket, 'held' for a policy hold, else null. */
  limiting: BudgetBucket | 'held' | null;
  /** One sentence an operator can read. */
  reason: string;
}

function isBudgetPool(pool: string): pool is BudgetPool {
  return (BUDGET_POOLS as readonly string[]).includes(pool);
}

/**
 * min(requested, floor(remaining / perJobUnits)) over the pool's observed
 * metered buckets. Throws on a non-integer or negative breadth and on a
 * non-positive per-job estimate — a malformed caller fails loud, never clamps
 * silently.
 */
export function capAskFanoutByBudget(
  requested: number,
  pool: string,
  snapshot: PoolBudgetSnapshot,
  perJobUnits: number = ASK_FANOUT_PER_JOB_UNITS,
): AskFanoutBudgetCap {
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('Invalid ask fan-out breadth');
  if (typeof perJobUnits !== 'number' || !Number.isFinite(perJobUnits) || perJobUnits <= 0) {
    throw new Error('Invalid per-job budget estimate');
  }
  const pass = (reason: string): AskFanoutBudgetCap => ({ pool, requested, granted: requested, limiting: null, reason });
  if (!isBudgetPool(pool)) return pass(`pool ${pool} is not budget-tracked; fan-out is unconstrained`);
  const view = snapshot.pools[pool];
  if (view.mode === 'held') {
    return { pool, requested, granted: 0, limiting: 'held', reason: `pool ${pool} is held; fan-out is 0` };
  }
  let minFits = Number.POSITIVE_INFINITY;
  let limiting: BudgetBucket | null = null;
  let observed = 0;
  let stale = 0;
  for (const [bucket, bucketView] of Object.entries(view.buckets) as [BudgetBucket, BudgetBucketView][]) {
    if (bucketView.state === 'reset-pending') stale++;
    if (bucketView.state !== 'observed' || bucketView.remaining === null) continue;
    observed++;
    const fits = Math.floor(bucketView.remaining / perJobUnits);
    if (fits < minFits) {
      minFits = fits;
      limiting = bucket;
    }
  }
  if (observed === 0) {
    const why = snapshot.sourceState === 'unavailable'
      ? 'the pool budget ledger is unavailable'
      : stale > 0
        ? `pool ${pool}'s last observation passed its reset without a new reading`
        : `pool ${pool} has no observed budget`;
    return pass(`${why}; fan-out is unconstrained`);
  }
  const granted = Math.max(0, Math.min(requested, minFits));
  if (granted === requested) return pass(`observed ${pool} budget affords all ${requested} fan-out job(s)`);
  return {
    pool, requested, granted, limiting,
    reason: `${limiting} remaining affords ${granted} of ${requested} fan-out job(s) at ${perJobUnits} unit(s) each`,
  };
}

/**
 * Read the persisted budget ledger and cap in one call. `directory`/`now`
 * exist for tests; production callers take the defaults (~/.ashlr/fleet/budgets).
 */
export async function capAskFanoutFromLedger(
  requested: number,
  pool: string,
  opts: { directory?: string; now?: Date; perJobUnits?: number } = {},
): Promise<AskFanoutBudgetCap> {
  const snapshot = await readPoolBudgets(opts.directory, opts.now);
  return capAskFanoutByBudget(requested, pool, snapshot, opts.perJobUnits);
}
