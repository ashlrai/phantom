/** Development-loop observations. These measure GitHub activity, not merge authority. */
export const LOOP_REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin'].map(name => `ashlrai/${name}`);
export const LOOP_STAGES = ['queue_wait', 'agent', 'ci', 'review', 'merge'] as const;
export type LoopStage = typeof LOOP_STAGES[number];
export interface LoopPercentiles { samples: number; p50_ms: number | null; p90_ms: number | null }
export interface LoopPr {
  repo: string;
  number: number;
  head_sha: string;
  opened_at: string;
  ready_at: string | null;
  merged_at: string | null;
  reverted: boolean;
  agent: string | null;
  durations_ms: Record<LoopStage, number | null>;
  ci_ledger_ms: number | null;
  ci_source: 'github' | 'ci_time.v1' | 'unknown';
}
export interface LoopCost {
  pool_spend_usd: number | null;
  merged_prs_per_dollar: number | null;
  grok_ultra_points: number | null;
  grok_ultra_points_per_merged_pr: number | null;
  by_agent: { agent: string; points: number; merged_prs: number; points_per_merged_pr: number | null }[];
  unattributed_points: number | null;
}
export interface LoopReport {
  schema: 'loop.v1';
  generated_at: string;
  window: { start: string; end: string; days: 7 };
  complete: boolean;
  sources: { source: string; complete: boolean; reason: string | null }[];
  repos: { repo: string; complete: boolean; merged_prs: number | null }[];
  stages: Record<LoopStage, LoopPercentiles>;
  bottleneck: { stage: LoopStage | null; basis: 'largest_p90_ms'; p90_ms: number | null; provisional: boolean };
  merged_prs: number | null;
  revert_rate: { reverts: number | null; merged_prs: number | null; rate: number | null; basis: 'merged_revert_pr_titles' };
  cost: LoopCost;
  prs: LoopPr[];
  panel: { title: string; stages: { stage: LoopStage; samples: number; p50_ms: number | null; p90_ms: number | null }[]; bottleneck: LoopStage | null;
    merged_prs: number | null; revert_rate: number | null; cost: LoopCost };
  telemetry: 'disabled' | 'sent' | 'failed';
}
export type Row = Record<string, unknown>;
export function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
export function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function time(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
export function elapsed(start: unknown, end: unknown, now: number): number | null {
  const a = time(start), b = time(end);
  return a !== null && b !== null && b >= a && b <= now ? b - a : null;
}
export function percentiles(values: (number | null)[]): LoopPercentiles {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  // Nearest rank, including one-element populations; no interpolation of unseen durations.
  const rank = (p: number): number | null => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { samples: sorted.length, p50_ms: rank(0.5), p90_ms: rank(0.9) };
}
export function summarizeLoop(
  now: number, prs: LoopPr[], sources: LoopReport['sources'], repos: LoopReport['repos'], cost: LoopCost,
): LoopReport {
  const stages = Object.fromEntries(LOOP_STAGES.map(stage => [stage, percentiles(prs.map(pr => pr.durations_ms[stage]))])) as LoopReport['stages'];
  const complete = sources.every(source => source.complete);
  const githubComplete = repos.every(repo => repo.complete);
  const merged = githubComplete ? prs.filter(pr => pr.merged_at !== null).length : null;
  const reverts = merged === null ? null : prs.filter(pr => pr.merged_at !== null && pr.reverted).length;
  const largest = LOOP_STAGES.filter(stage => stages[stage].p90_ms !== null)
    .sort((a, b) => stages[b].p90_ms! - stages[a].p90_ms!)[0] ?? null;
  const outcomeCost = { ...cost, merged_prs_per_dollar: merged !== null && cost.pool_spend_usd ? merged / cost.pool_spend_usd : null,
    grok_ultra_points_per_merged_pr: merged && cost.grok_ultra_points !== null ? cost.grok_ultra_points / merged : null };
  const revertRate = merged && reverts !== null ? reverts / merged : null;
  const incompleteStages = LOOP_STAGES.some(stage => {
    const eligible = stage === 'merge' ? prs.filter(pr => pr.merged_at !== null).length :
      stage === 'review' ? prs.filter(pr => pr.ready_at !== null).length : prs.length;
    return stages[stage].samples === 0 || stages[stage].samples < eligible;
  });
  return {
    schema: 'loop.v1', generated_at: new Date(now).toISOString(),
    window: { start: new Date(now - 7 * 86400_000).toISOString(), end: new Date(now).toISOString(), days: 7 },
    complete, sources, repos, stages,
    bottleneck: { stage: largest, basis: 'largest_p90_ms', p90_ms: largest ? stages[largest].p90_ms : null, provisional: !complete || incompleteStages },
    merged_prs: merged,
    revert_rate: { reverts, merged_prs: merged, rate: revertRate, basis: 'merged_revert_pr_titles' },
    cost: outcomeCost,
    prs, panel: { title: 'Development loop · last 7 days', stages: LOOP_STAGES.map(stage => ({ stage, ...stages[stage] })), bottleneck: largest,
      merged_prs: merged, revert_rate: revertRate, cost: outcomeCost },
    telemetry: 'disabled',
  };
}
