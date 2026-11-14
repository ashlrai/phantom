/**
 * Merge-confidence gate: folds the diff-risk heuristics, post-merge durability
 * history (fleet IQ) and CI signal into one 0-100 score. Below the threshold a
 * PR goes to leader review instead of auto-merge. Pure and deterministic; the
 * score can only withhold auto-merge. It never grants authority, and every
 * existing gate, review and required check still applies.
 *
 * Missing evidence (no history yet, CI not run) is dropped and the remaining
 * weights renormalize, so absence is never counted as good or bad. The diff
 * component is always present; an unmeasurable diff is a hard blocker.
 */
import type { FleetEvalReport } from '../core/fleet/eval-report.js';
import type { DiffRiskAssessment } from './risk.js';

export const MERGE_CONFIDENCE_SCHEMA = 'merge-confidence/v1' as const;
export const DEFAULT_MERGE_CONFIDENCE_THRESHOLD = 55;
/** Resolved merges needed before durability history counts as evidence. */
export const MIN_HISTORY_RESOLVED = 5;
/** A history this durable-poor is a blocker on its own, whatever the diff. */
const HISTORY_BLOCK_LOWER_BOUND = 0.5;
const HISTORY_BLOCK_MIN_RESOLVED = 10;
const WEIGHTS = { diff: 0.5, history: 0.3, ci: 0.2 } as const;

export type MergeCiState = 'clean' | 'failed-checks' | 'unknown';

export interface MergeHistoryEvidence {
  scope: 'repo' | 'fleet';
  resolved: number;
  /** stable / (stable + adverse), 0..1. */
  rate: number;
  /** Wilson 95% lower bound, 0..1. */
  lowerBound: number;
}

export interface MergeConfidenceInput {
  diff: DiffRiskAssessment;
  history?: MergeHistoryEvidence | null;
  ci?: MergeCiState;
  threshold?: number;
}

export interface MergeConfidence {
  schema: typeof MERGE_CONFIDENCE_SCHEMA;
  score: number;
  threshold: number;
  decision: 'auto-merge' | 'leader-review';
  /** Per-component 0-100 scores; null = no evidence, excluded from the blend. */
  components: { diff: number; history: number | null; ci: number | null };
  /** Conditions that force leader review regardless of the blended score. */
  blockers: string[];
}

/**
 * Pick durability evidence from a fleet eval report: the repo's own group when
 * it has enough resolved merges, else the fleet-wide rate, else none.
 */
export function historyFromEvalReport(report: FleetEvalReport | null | undefined, repo: string): MergeHistoryEvidence | null {
  if (!report) return null;
  const row = report.byRepo.find((group) => group.name.toLowerCase() === repo.toLowerCase());
  if (row && row.durability.resolved >= MIN_HISTORY_RESOLVED && row.durability.rate !== null && row.durability.ci95) {
    return { scope: 'repo', resolved: row.durability.resolved, rate: row.durability.rate, lowerBound: row.durability.ci95[0] };
  }
  const { resolved, fleetIQ, fleetIqCi95 } = report.merges;
  if (resolved >= MIN_HISTORY_RESOLVED && fleetIQ !== null && fleetIqCi95) {
    return { scope: 'fleet', resolved, rate: fleetIQ / 100, lowerBound: fleetIqCi95[0] };
  }
  return null;
}

export function scoreMergeConfidence(input: MergeConfidenceInput): MergeConfidence {
  const threshold = Math.min(100, Math.max(1, Math.round(input.threshold ?? DEFAULT_MERGE_CONFIDENCE_THRESHOLD)));
  const blockers: string[] = [];

  const diff = input.diff.measurable ? Math.max(0, 100 - input.diff.score) : 0;
  if (!input.diff.measurable) blockers.push(`diff-unmeasurable:${input.diff.invalidReason ?? 'unknown'}`);
  else if (input.diff.risk === 'high') blockers.push('diff-risk-high');

  // Midpoint of the observed rate and its lower bound: a young repo with five
  // clean merges is not punished like an unproven one, nor trusted like 50.
  const h = input.history ?? null;
  const history = h ? Math.round(((h.rate + h.lowerBound) / 2) * 100) : null;
  if (h && h.resolved >= HISTORY_BLOCK_MIN_RESOLVED && h.lowerBound < HISTORY_BLOCK_LOWER_BOUND) {
    blockers.push(`history-${h.scope}-durability-low`);
  }

  const ci = input.ci === 'clean' ? 100 : input.ci === 'failed-checks' ? 0 : null;
  if (input.ci === 'failed-checks') blockers.push('ci-failed-checks');

  const parts = [[diff, WEIGHTS.diff], [history, WEIGHTS.history], [ci, WEIGHTS.ci]] as const;
  let weight = 0;
  let total = 0;
  for (const [value, w] of parts) {
    if (value === null) continue;
    weight += w;
    total += value * w;
  }
  const blended = Math.round(total / weight);
  const score = blockers.length ? Math.min(blended, threshold - 1) : blended;
  return {
    schema: MERGE_CONFIDENCE_SCHEMA, score, threshold,
    decision: score >= threshold && !blockers.length ? 'auto-merge' : 'leader-review',
    components: { diff, history, ci },
    blockers,
  };
}

/** One-line PR metadata, e.g. for the PR body footer. */
export function formatMergeConfidenceLine(result: MergeConfidence): string {
  const part = (name: string, value: number | null): string => `${name} ${value ?? '—'}`;
  const { diff, history, ci } = result.components;
  return `Merge confidence: ${result.score}/100 (threshold ${result.threshold}) · ` +
    `${result.decision === 'auto-merge' ? 'auto-merge eligible' : 'leader review'} · ` +
    `${part('diff', diff)} · ${part('history', history)} · ${part('ci', ci)}` +
    (result.blockers.length ? ` · blockers: ${result.blockers.join(', ')}` : '');
}

/** Why a below-threshold PR is routed to leader review (owner-lane reason text). */
export function leaderReviewReason(result: MergeConfidence): string {
  return result.blockers.length
    ? `merge confidence ${result.score}/${result.threshold}: ${result.blockers.join(', ')}`
    : `merge confidence ${result.score} is below the ${result.threshold} auto-merge threshold`;
}
