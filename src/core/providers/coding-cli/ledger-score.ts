/**
 * Historical score per coding pool, computed from recorded SpendDecision rows.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886,
 * src/core/providers/coding-cli/ledger.ts `reweight`). The formula is kept
 * exactly; what changed is the name and the contract. A score here is a
 * historical proposal over the rows given. It is not an eligibility, spending
 * or dispatch decision, it is not wired into routing, and it is not comparable
 * across pools whose cost units differ.
 *
 * Legacy cost rule: the source divides the known merged costs by the total
 * merged count, so an unknown (null) cost adds nothing to the numerator but
 * still counts in the denominator. It is excluded, not measured as zero; the
 * per-pool counts report how many merged rows had unknown cost.
 */
import type { SpendDecision } from './ledger.js';

export const LEDGER_SCORE_NOTE =
  'Historical score over the listed rows only. Not an eligibility, spending or dispatch decision. '
  + 'Scores are not comparable across pools: cost is in each pool\'s own unit and is not converted.';

export interface PoolLedgerScore {
  poolId: string;
  /** Listed rows for this pool (merged and unmerged). */
  rows: number;
  merged: number;
  mergeRate: number;
  /** CI outcomes across all listed rows; unknown CI is excluded from the CI rate. */
  ci: { passed: number; failed: number; known: number; unknown: number };
  /** CI pass rate over known outcomes; 0 when no CI outcome is known. */
  ciPassRate: number;
  /** Cost over merged rows. Unknown cost is excluded from the sum, not counted as zero. */
  cost: { knownMerged: number; unknownMerged: number };
  /** Sum of known merged costs divided by the total merged count (legacy formula). */
  costPerMerged: number;
  /** mergeRate * ciPassRate / (1 + costPerMerged), rounded to six decimals; 0 with no merges. */
  score: number;
}

/**
 * Group rows by poolId and score each pool. Pools are returned in first-seen
 * order. Grouping uses a Map, so prototype-shaped identifiers such as
 * "__proto__" or "constructor" are ordinary keys and nothing is assigned onto
 * a plain object.
 */
export function scoreHistoricalPools(rows: readonly SpendDecision[]): PoolLedgerScore[] {
  const groups = new Map<string, SpendDecision[]>();
  for (const row of rows) {
    const list = groups.get(row.poolId);
    if (list) list.push(row);
    else groups.set(row.poolId, [row]);
  }
  return [...groups].map(([poolId, list]) => scorePool(poolId, list));
}

function scorePool(poolId: string, list: readonly SpendDecision[]): PoolLedgerScore {
  const merges = list.filter((row) => row.merged);
  const ciKnown = list.filter((row) => row.ci !== 'unknown');
  const ciPassed = ciKnown.filter((row) => row.ci === 'passed').length;
  const mergeRate = list.length === 0 ? 0 : merges.length / list.length;
  const ciPassRate = ciKnown.length === 0 ? 0 : ciPassed / ciKnown.length;
  const costKnown = merges.filter((row) => row.cost !== null);
  const costSum = costKnown.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const costPerMerged = merges.length === 0 ? 0 : costSum / merges.length;
  const raw = merges.length === 0 ? 0 : (mergeRate * ciPassRate) / (1 + costPerMerged);
  return {
    poolId,
    rows: list.length,
    merged: merges.length,
    mergeRate,
    ci: {
      passed: ciPassed,
      failed: ciKnown.length - ciPassed,
      known: ciKnown.length,
      unknown: list.length - ciKnown.length,
    },
    ciPassRate,
    cost: { knownMerged: costKnown.length, unknownMerged: merges.length - costKnown.length },
    costPerMerged,
    score: Math.round(raw * 1_000_000) / 1_000_000,
  };
}
