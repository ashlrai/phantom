import type { DecisionEntry, Proposal } from '../types.js';
import {
  evaluateReviewerIndependence,
  judgeLanePreference,
  producerModelFamily,
  reviewModelFamily,
} from './reviewer-independence.js';
import type { FleetEngine } from './fleet-types.js';

export type ReviewerArm = 'claude-cli' | 'codex' | 'grok-cli';

/** A bandit may choose only among the supplied, currently eligible arms. */
export type ReviewerArmHook = (arms: readonly ReviewerArm[]) => ReviewerArm | null | undefined;

/**
 * Select a reviewer lane, without dispatching or granting merge authority.
 * Availability must be supplied by the caller after its own policy, quota and
 * readiness checks. An invalid bandit choice falls back to the first eligible
 * lane; unknown authors and empty availability fail closed.
 */
export function selectCrossReviewer(
  author: string | null | undefined,
  available: readonly ReviewerArm[],
  chooseArm?: ReviewerArmHook,
): ReviewerArm | null {
  const availableSet = new Set<ReviewerArm>(available);
  const arms = judgeLanePreference(producerModelFamily(author)).filter(
    (lane): lane is FleetEngine & ReviewerArm =>
      availableSet.has(lane as ReviewerArm) && evaluateReviewerIndependence(author, lane).independent,
  );
  if (arms.length === 0) return null;
  const selected = chooseArm?.(Object.freeze([...arms]));
  return selected && arms.includes(selected) ? selected : arms[0]!;
}

export interface CrossReviewShare {
  /** Completed judged rows with both provider families known. */
  comparable: number;
  crossProvider: number;
  /** Completed judged rows lacking a known author or reviewer family. */
  unknown: number;
  /** crossProvider / comparable, or null when no reviews are comparable. */
  share: number | null;
}

/**
 * Count review events, not proposals or attempted selections. A proposal can
 * have multiple reviews. Failed judge calls and escalations are not reviews.
 * Identities are recorded observations, not proof of merge eligibility.
 */
export function computeCrossReviewShare(
  proposals: readonly Pick<Proposal, 'id' | 'engineModel'>[],
  decisions: readonly DecisionEntry[],
): CrossReviewShare {
  const authors = new Map(proposals.map((proposal) => [proposal.id, proposal.engineModel]));
  let comparable = 0;
  let crossProvider = 0;
  let unknown = 0;
  for (const decision of decisions) {
    if (decision.action !== 'judged' || !authors.has(decision.proposalId) ||
      decision.judgeReasonCode === 'judge-parse-failure' || decision.judgeReasonCode === 'judge-network-failure' ||
      decision.detail === 'judge-parse-failure' || decision.detail === 'judge-network-failure') continue;
    const verdict = evaluateReviewerIndependence(authors.get(decision.proposalId), decision.engine ?? decision.model);
    const modelFamily = reviewModelFamily(decision.model);
    const conflictingReviewer = modelFamily !== 'unknown' && verdict.reviewerFamily !== 'unknown' &&
      modelFamily !== verdict.reviewerFamily;
    if (verdict.producerFamily === 'unknown' || verdict.reviewerFamily === 'unknown' || conflictingReviewer) {
      unknown++;
    } else {
      comparable++;
      if (verdict.independent) crossProvider++;
    }
  }
  return { comparable, crossProvider, unknown, share: comparable ? crossProvider / comparable : null };
}
