/**
 * forecast.ts — cost attribution + forward forecast for a recent usage window.
 *
 * M15: buildForecast reuses buildRollup for actual spend and the canonical
 * budget pricing to compute local savings. All numbers are ESTIMATES, clearly
 * labeled. Never throws — falls back to zeroed CostForecast on any error.
 */

import type { AshlrConfig, CostForecast } from '../types.js';
import { cloudReferenceCost } from '../run/budget.js';
import { buildRollup, windowToMs, isLocalProviderModel } from './rollup.js';

// ---------------------------------------------------------------------------
// buildForecast
// ---------------------------------------------------------------------------

/**
 * Build a CostForecast for the given window.
 *
 * - `spentUsd`: actual cost from the rollup (local providers contribute $0).
 * - `localSavingsUsd`: estimated cloud cost for tokens served by LOCAL models —
 *   what you WOULD have paid if those same tokens ran on cloud.
 * - `projectedMonthlyUsd`: the window's daily average spend × 30 days.
 *
 * All figures are ESTIMATES. Never throws — returns a zeroed forecast on error.
 */
export function buildForecast(
  window: '7d' | '30d',
  cfg: AshlrConfig,
): CostForecast {
  try {
    const rollup = buildRollup(window, cfg);

    // Actual spend is already computed in the rollup totals.
    const spentUsd = Math.max(0, rollup.totals.estCostUsd);

    // ── Local savings ───────────────────────────────────────────────────────
    // Sum up the cloud-equivalent cost for every local model's token usage.
    // rollup.byModel lists per-model aggregates; we identify local models and
    // compute what cloud would have charged for the same token volume.
    let localSavingsUsd = 0;
    for (const mu of rollup.byModel) {
      if (isLocalProviderModel(mu.model)) {
        // Price the hypothetical cloud usage without resolving host providers.
        localSavingsUsd += cloudReferenceCost(mu.tokensIn, mu.tokensOut);
      }
    }
    localSavingsUsd = Math.max(0, localSavingsUsd);

    // ── Monthly projection ──────────────────────────────────────────────────
    // Scale the window's spend to a 30-day equivalent.
    // windowToMs is already exported from rollup.ts.
    const windowDays = windowToMs(window) / 86_400_000; // exact days in window
    const dailyRate = windowDays > 0 ? spentUsd / windowDays : 0;
    const projectedMonthlyUsd = Math.max(0, dailyRate * 30);

    return {
      window,
      spentUsd,
      localSavingsUsd,
      projectedMonthlyUsd,
    };
  } catch {
    // Never throw — return a safe zeroed forecast on any error.
    return {
      window,
      spentUsd: 0,
      localSavingsUsd: 0,
      projectedMonthlyUsd: 0,
    };
  }
}
