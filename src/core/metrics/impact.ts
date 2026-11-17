/** Offline advisory reward. Changes to the formula require a new version. */
export const IMPACT_VERSION = 'phantom-impact/v1' as const;

export interface ImpactInput {
  id: string;
  repo: string;
  template?: string;
  status: 'merged' | 'failed' | 'empty' | 'pending';
  tokens?: number;
  additions?: number;
  deletions?: number;
  files?: string[];
  labels?: string[];
  tags?: string[];
  mergedAt?: string;
  dependentJobs?: number;
  criticalPathDepth?: number;
  repoBreadth?: number;
  reverted?: boolean;
  fixedForward?: boolean;
  churnFiles?: number;
}

export interface ImpactOverride {
  capability?: number;
  autonomy?: number;
  unblocking?: number;
  fleetLoop?: number;
  productionReach?: number;
  repoBreadth?: number;
  novelty?: number;
  riskTier?: 1 | 2 | 3;
  trivial?: boolean;
}

export const IMPACT_WEIGHTS = Object.freeze({
  capability: 30,
  autonomy: 25,
  unblocking: 20,
  fleetLoop: 20,
  productionReach: 15,
  repoBreadth: 10,
});
type Dimension = keyof typeof IMPACT_WEIGHTS;

export interface ImpactScore {
  version: typeof IMPACT_VERSION;
  id: string;
  repo: string;
  template?: string;
  status: ImpactInput['status'];
  reward: number;
  impact: number;
  tokenCost: number;
  exploration: boolean;
  ambition: number;
  components: Record<Dimension, number>;
  penalties: { trivial: number; empty: number; revert: number; churn: number };
}

function quantity(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Impact quantities must be nonnegative safe integers.');
  return value;
}

function dimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Impact dimensions must be between 0 and 1.');
  return value;
}

/** Labels are exact, case-insensitive tokens, not guesses from PR prose. */
export function scoreImpact(input: ImpactInput, override: ImpactOverride = {}): ImpactScore {
  if (!input.id?.trim() || !input.repo?.trim()) throw new Error('Impact requires a job/PR identity and repository.');
  if (!['merged', 'failed', 'empty', 'pending'].includes(input.status)) throw new Error('Unknown impact status.');
  const labels = new Set([...(input.labels ?? []), ...(input.tags ?? [])].map(label => label.toLowerCase()));
  const has = (label: string) => labels.has(label) ? 1 : 0;
  const additions = quantity(input.additions);
  const deletions = quantity(input.deletions);
  const tokens = quantity(input.tokens);
  const dependentJobs = quantity(input.dependentJobs);
  const criticalPathDepth = quantity(input.criticalPathDepth);
  const repoBreadth = quantity(input.repoBreadth);
  const churnFiles = quantity(input.churnFiles);
  const files = new Set(input.files ?? []).size;
  const components: Record<Dimension, number> = {
    capability: dimension(override.capability, has('impact:capability')),
    autonomy: dimension(override.autonomy, has('impact:autonomy')),
    unblocking: dimension(override.unblocking, Math.min(1, dependentJobs / 5 + criticalPathDepth / 5)),
    fleetLoop: dimension(override.fleetLoop, has('impact:fleet-loop')),
    productionReach: dimension(override.productionReach, Math.max(has('impact:released'), has('impact:published'))),
    repoBreadth: dimension(override.repoBreadth, Math.min(1, Math.max(0, repoBreadth - 1) / 4)),
  };
  const novelty = dimension(override.novelty, has('impact:novel'));
  if (override.riskTier !== undefined && ![1, 2, 3].includes(override.riskTier)) throw new Error('Impact risk tier must be 1, 2 or 3.');
  const riskTier = override.riskTier ?? (has('risk:tier-1') ? 1 : has('risk:tier-2') ? 2 : 3);
  const risk = riskTier === 1 ? 1 : riskTier === 2 ? 0.5 : 0;
  // Diff size measures ambition, never value by itself. Saturation limits padding.
  const scope = Math.min(1, (additions + deletions) / 1000 + files / 20);
  const ambition = 1 + 2 * scope + 2 * risk + novelty;
  const weighted = (Object.keys(IMPACT_WEIGHTS) as Dimension[])
    .reduce((sum, key) => sum + components[key] * IMPACT_WEIGHTS[key], 0);
  // Missing metadata is unknown, never proof of an empty job.
  const explicitEmpty = input.status === 'empty' || (input.status === 'merged'
    && input.additions === 0 && input.deletions === 0 && input.files?.length === 0);
  const impact = input.status === 'merged' && !explicitEmpty ? weighted * ambition : 0;
  const tokenCost = tokens / 1_000_000;
  const trivial = override.trivial ?? (Boolean(has('impact:trivial')) || (input.status === 'merged'
    && input.additions !== undefined && input.deletions !== undefined
    && additions + deletions <= 10 && files <= 1 && weighted === 0));
  const penalties = {
    trivial: input.status === 'merged' && trivial && !explicitEmpty ? 8 : 0,
    empty: explicitEmpty ? 25 : 0,
    // Cancel all gross credit and impose a loss. Maximum ambition cannot mask a revert.
    revert: input.status === 'merged' && input.reverted && !input.fixedForward ? impact + 25 : 0,
    churn: input.status === 'merged' ? Math.min(20, churnFiles * 2) : 0,
  };
  return {
    version: IMPACT_VERSION,
    id: input.id,
    repo: input.repo,
    ...(input.template !== undefined ? { template: input.template } : {}),
    status: input.status,
    reward: impact - tokenCost - Object.values(penalties).reduce((sum, penalty) => sum + penalty, 0),
    impact,
    tokenCost,
    exploration: input.status === 'failed' && ambition >= 3,
    ambition,
    components,
    penalties,
  };
}

function canonicalInput(input: ImpactInput): string {
  const normalized = { ...input };
  for (const key of ['files', 'labels', 'tags'] as const) {
    if (normalized[key]) normalized[key] = [...new Set(normalized[key])].sort();
  }
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}

/** A PR is one observation even when multiple job rows reference it. */
export function deduplicateImpactInputs(inputs: readonly ImpactInput[]): ImpactInput[] {
  const identities = new Map<string, { input: ImpactInput; canonical: string }>();
  for (const input of inputs) {
    const key = JSON.stringify([input.repo, input.id]);
    const canonical = canonicalInput(input);
    const prior = identities.get(key);
    if (prior && prior.canonical !== canonical) throw new Error('Conflicting duplicate impact identity.');
    if (!prior) identities.set(key, { input, canonical });
  }
  return [...identities.values()].map(value => value.input);
}

export interface ImpactTemplateRank {
  version: typeof IMPACT_VERSION;
  template: string;
  attempts: number;
  explorations: number;
  totalReward: number;
  meanReward: number;
  explorationBonus: number;
  score: number;
}

/** Shared UCB policy for the bandit and template ordering. No random state or I/O. */
export function rankImpactTemplates(
  inputs: readonly ImpactInput[],
  overrides: Readonly<Record<string, ImpactOverride>> = {},
): ImpactTemplateRank[] {
  const groups = new Map<string, { scores: ImpactScore[]; ambition: number }>();
  let observations = 0;
  for (const input of deduplicateImpactInputs(inputs)) {
    if (!input.template) continue;
    // Imported identities include their repository, keeping override keys portable.
    const override = overrides[input.id];
    const scored = scoreImpact(input, override);
    const group = groups.get(input.template) ?? { scores: [], ambition: 1 };
    group.ambition = Math.max(group.ambition, scored.ambition);
    if (input.status !== 'pending') {
      group.scores.push(scored);
      observations++;
    }
    groups.set(input.template, group);
  }
  return [...groups.entries()].map(([template, group]) => {
    const attempts = group.scores.length;
    const totalReward = group.scores.reduce((sum, score) => sum + score.reward, 0);
    const meanReward = attempts ? totalReward / attempts : 0;
    // Finite cold-start UCB; bold templates get more exploration, not fabricated reward.
    const explorationBonus = 20 * (1 + (group.ambition - 1) / 5)
      * Math.sqrt(2 * Math.log(observations + 2) / Math.max(1, attempts));
    return {
      version: IMPACT_VERSION, template, attempts,
      explorations: group.scores.filter(score => score.exploration).length,
      totalReward, meanReward, explorationBonus, score: meanReward + explorationBonus,
    };
  }).sort((a, b) => b.score - a.score || a.template.localeCompare(b.template));
}
