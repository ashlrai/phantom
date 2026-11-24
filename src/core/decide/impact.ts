/** Deterministic impact context for Jev. No provider or classifier calls. */
import {
  IMPACT_VERSION,
  deduplicateImpactInputs,
  scoreImpact,
  type ImpactInput,
  type ImpactOverride,
} from '../metrics/impact.js';

/** Observed reward ordering, separate from the bandit's exploration bonus. */
export function rankJevImpact(
  history: readonly ImpactInput[],
  overrides: Readonly<Record<string, ImpactOverride>> = {},
) {
  return {
    version: IMPACT_VERSION,
    advisory: true as const,
    outcomes: deduplicateImpactInputs(history).map((input) => scoreImpact(input, overrides[input.id]))
      .sort((a, b) => b.reward - a.reward || a.id.localeCompare(b.id)),
  };
}
