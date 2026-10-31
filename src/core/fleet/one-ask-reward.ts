/** Observation-only reward for one attempt, never routing or merge authority. */
import { resolve } from 'node:path';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import type { Proposal } from '../types.js';
import { inspectPostMergeWindow } from './post-merge-window.js';

export const ONE_ASK_REWARD_WINDOW_MS = 72 * 60 * 60 * 1_000;

export type OneAskReward =
  | { state: 'scored'; outcome: 'published' | 'stable' | 'reverted'; rewardPerToken: number }
  | { state: 'unknown'; reason: 'invalid-usage' | 'invalid-weight' | 'no-authenticated-merge' | 'inspection-inconclusive' | 'window-pending' | 'follow-up-observed' };

/**
 * Score an individual attempt against its authenticated merge and a bounded
 * inspection of the repository's current HEAD. The caller supplies complete
 * attempt token usage (input plus output) and a positive task weight. A
 * published-only attempt has no merge claim. Unknown evidence is never zero.
 *
 * A deterministic revert is negative as soon as observed, including after
 * the 72-hour window; a heuristic follow-up prevents a positive score. The
 * result is a snapshot for reporting, not a post-merge credit release.
 */
export function inspectOneAskReward(input: {
  outcome: { kind: 'published' } | { kind: 'merged'; proposal: Proposal };
  tokens: number;
  weight: number;
  nowMs?: number;
}): OneAskReward {
  if (!Number.isSafeInteger(input.tokens) || input.tokens <= 0) return { state: 'unknown', reason: 'invalid-usage' };
  if (!Number.isFinite(input.weight) || input.weight <= 0 || !Number.isFinite(input.weight / input.tokens) || input.weight / input.tokens === 0) {
    return { state: 'unknown', reason: 'invalid-weight' };
  }
  if (input.outcome.kind === 'published') return { state: 'scored', outcome: 'published', rewardPerToken: 0 };

  const proposal = input.outcome.proposal;
  const merge = authenticatedRealizedMergeOf(proposal);
  if (!merge || !proposal.repo) return { state: 'unknown', reason: 'no-authenticated-merge' };
  const startedAt = merge.source === 'github-host' ? merge.mergedAt : merge.observedAt;
  const inspection = inspectPostMergeWindow({
    repo: resolve(proposal.repo), mergeCommit: merge.mergeCommitOid,
    observedAtMs: input.nowMs ?? Date.now(), followUpWindowMs: ONE_ASK_REWARD_WINDOW_MS,
    windowStartedAtMs: Date.parse(startedAt),
  });
  if (inspection.state !== 'complete') return { state: 'unknown', reason: 'inspection-inconclusive' };
  if (inspection.adverse?.outcome === 'reverted') {
    return { state: 'scored', outcome: 'reverted', rewardPerToken: -input.weight / input.tokens };
  }
  if (inspection.adverse) return { state: 'unknown', reason: 'follow-up-observed' };
  if (!inspection.windowElapsed) return { state: 'unknown', reason: 'window-pending' };
  return { state: 'scored', outcome: 'stable', rewardPerToken: input.weight / input.tokens };
}
