/** Offline bandit advice. Ranking never grants dispatch or merge authority. */
import {
  IMPACT_VERSION,
  rankImpactTemplates,
  type ImpactInput,
  type ImpactOverride,
} from '../metrics/impact.js';

/** One shared reward and exploration policy, with no second bandit formula. */
export function adviseImpactBandit(
  history: readonly ImpactInput[],
  overrides: Readonly<Record<string, ImpactOverride>> = {},
) {
  const ranking = rankImpactTemplates(history, overrides);
  return {
    version: IMPACT_VERSION,
    advisory: true as const,
    recommendation: ranking[0] ?? null,
    ranking,
  };
}
