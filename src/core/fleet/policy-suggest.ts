import type { OutcomeGroup, OutcomeMetrics } from './outcome-metrics.js';

interface Evidence {
  /** Heuristic evidence strength, not a probability of improvement. */
  confidence: number;
  reason: string;
  evidenceRefs: string[];
}
export interface PolicySuggestion {
  schema: 'fleet.policy-suggestion.v1';
  suggestOnly: true;
  sourceState: OutcomeMetrics['sourceState'];
  since: string;
  until: string;
  laneTargetDeltas: (Evidence & { lane: string; delta: -1 | 1 })[];
  tierRoutingHints: (Evidence & { tier: string; preferModel: string; overModel: string })[];
  promptTemplateFlags: (Evidence & { lane: string; flag: 'review-scope-and-context' })[];
}
const strength = (n: number): number => Math.min(0.9, n / (n + 20));
const complete = (g: OutcomeGroup): boolean => g.jobs >= 20 && g.finished === g.jobs &&
  g.samples.pr === g.jobs && g.estCost !== null && g.samples.published > 0 && (g.prRate ?? 0) >= 0.8;

/** Deterministic, capped advice. Never reads targets, changes prompts or invokes a router. */
export function suggestOutcomePolicy(metrics: OutcomeMetrics): PolicySuggestion {
  const out: PolicySuggestion = { schema: 'fleet.policy-suggestion.v1', suggestOnly: true, sourceState: metrics.sourceState, since: metrics.since, until: metrics.until,
    laneTargetDeltas: [], tierRoutingHints: [], promptTemplateFlags: [] };
  if (metrics.sourceState !== 'healthy') return out;
  for (const g of metrics.byLane) {
    if (g.name === 'unknown' || g.jobs < 20) continue;
    const evidenceRefs = [...g.evidenceRefs];
    if (g.samples.empty >= 20 && (g.emptyRate ?? 0) >= 0.5) {
      const evidence = { confidence: strength(g.samples.empty), evidenceRefs,
        reason: `${g.samples.empty} measured finishes; empty rate ${g.emptyRate}. Review task scope and context before changing templates.` };
      out.promptTemplateFlags.push({ ...evidence, lane: g.name, flag: 'review-scope-and-context' });
      out.laneTargetDeltas.push({ ...evidence, lane: g.name, delta: -1 });
    } else if (complete(g) && g.samples.empty === g.jobs && (g.emptyRate ?? 1) <= 0.1) {
      out.laneTargetDeltas.push({ lane: g.name, delta: 1, confidence: strength(g.jobs), evidenceRefs,
        reason: `${g.jobs} completed attempts with full cost/PR evidence and PR rate ${g.prRate}; consider one slot only after checking capacity and budget.` });
    }
  }
  const candidates = metrics.byModelTier.filter(g => g.model && g.tier && complete(g));
  for (const tier of [...new Set(candidates.map(g => g.tier!))].sort()) {
    const ranked = candidates.filter(g => g.tier === tier).sort((a, b) =>
      a.estCost! / a.samples.published - b.estCost! / b.samples.published || a.name.localeCompare(b.name));
    const best = ranked[0], worst = ranked.at(-1);
    if (!best || !worst || best === worst || best.prRate! < worst.prRate! - 0.05 ||
      best.estCost! / best.samples.published > 0.8 * (worst.estCost! / worst.samples.published) || worst.estCost === 0) continue;
    out.tierRoutingHints.push({ tier, preferModel: best.model!, overModel: worst.model!,
      confidence: strength(Math.min(best.jobs, worst.jobs)), evidenceRefs: [...best.evidenceRefs, ...worst.evidenceRefs],
      reason: 'At least 20% lower recorded USD per published PR within this tier, with comparable PR rate. Validate task mix and merge durability before routing.' });
  }
  out.laneTargetDeltas = out.laneTargetDeltas.slice(0, 8);
  out.tierRoutingHints = out.tierRoutingHints.slice(0, 8);
  out.promptTemplateFlags = out.promptTemplateFlags.slice(0, 8);
  return out;
}
