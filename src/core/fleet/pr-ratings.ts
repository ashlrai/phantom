/**
 * Longitudinal, observation-only PR ratings for the existing fleet scorecard.
 * Critic estimates describe potential impact; exact authenticated merges and
 * manifested detached verification describe observed delivery. Neither grants
 * merge authority, routing credit, or permission to take additional risk.
 */
import { createHash } from 'node:crypto';
import { hashDiff, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { realizedMergeOf, canonicalRealizedMergeIdentity } from '../inbox/realized-merge.js';
import type { Proposal } from '../types.js';
import { readPostMergeObservations, type PostMergeObservation } from './post-merge-observations.js';
import { postMergeStabilityRepoDigest, readPostMergeStability, type PostMergeStabilityWitness } from './post-merge-stability.js';
import { buildDetachedPostMergeCandidateIdentity, readDetachedPostMergeVerificationCohorts,
  type DetachedPostMergeVerificationCohort } from './detached-post-merge-verification.js';

export const PR_RATING_POLICY_VERSION = 'pr-ratings-v1' as const;
const MAX_RATINGS = 64;
const MAX_RATING_BYTES = 64 * 1024;
const MIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
type Source = { sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean };
export type PrRatingStatus = 'unobserved' | 'verified-window' | 'verification-failed' | 'followed-up' | 'regressed' | 'reverted' | 'unknown';
export interface PrRating {
  proposalId: string;
  mergeSource: 'github-host' | 'local-default-branch';
  githubPr: { url: string; repository: string; number: number } | null;
  eventDigest: string;
  diffHash: string;
  proposalHeadOid: string;
  mergeCommitOid: string;
  observedHeadOid: string | null;
  mergedAt: string;
  status: PrRatingStatus;
  /** Potential leverage, never a measured business or benchmark improvement. */
  impactEstimate: { source: 'critic-estimate'; confidence: null; alignment: number; ambition: number; design: number } | null;
  /** Advisory comparison only; null is unknown, not zero reward. */
  advisoryReward: number | null;
  evidenceDigests: string[];
  ratingDigest: string;
}
export interface PrRatings {
  authority: 'observation-only';
  policyVersion: typeof PR_RATING_POLICY_VERSION;
  policyEligible: false;
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  candidateCount: number | null;
  capped: boolean;
  reasons: string[];
  sources: { adverse: Source['sourceState']; stability: Source['sourceState']; detached: Source['sourceState'] };
  /** Ratings deliberately outlive the enclosing scorecard's velocity window. */
  lookbackStartedAt: string | null;
  scorecardWindowStartedAt: string | null;
  ratings: PrRating[];
}
interface RatingInputs {
  proposals: readonly Proposal[];
  proposalSource: Source;
  adverse: Source & { observations: readonly PostMergeObservation[] };
  stability: Source & { witnesses: readonly PostMergeStabilityWitness[] };
  detached: Source & { cohorts: readonly DetachedPostMergeVerificationCohort[] };
  sinceMs: number;
  nowMs: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const healthy = (source: Source) => source.complete && source.sourceState !== 'degraded';
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5;
const validTime = (value: string, nowMs: number) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= nowMs;

/** Inputs must come from the authenticated store readers; this is not a write boundary. */
export function buildPrRatings(input: RatingInputs): PrRatings {
  const reasons: string[] = [];
  const report: PrRatings = { authority: 'observation-only', policyVersion: PR_RATING_POLICY_VERSION,
    policyEligible: false, sourceState: 'healthy', complete: true, candidateCount: null, capped: false, reasons, ratings: [],
    sources: { adverse: input.adverse.sourceState, stability: input.stability.sourceState, detached: input.detached.sourceState },
    lookbackStartedAt: null, scorecardWindowStartedAt: null };
  if (!Number.isFinite(new Date(input.sinceMs).getTime()) || !Number.isFinite(new Date(input.nowMs).getTime()) || input.sinceMs > input.nowMs) {
    return { ...report, sourceState: 'degraded', complete: false, reasons: ['invalid-rating-window'] };
  }
  const lookbackMs = Math.max(0, input.nowMs - LOOKBACK_MS);
  report.lookbackStartedAt = new Date(lookbackMs).toISOString();
  report.scorecardWindowStartedAt = new Date(input.sinceMs).toISOString();
  if (!healthy(input.proposalSource)) {
    return { ...report, sourceState: 'degraded', complete: false, reasons: ['proposal-source-incomplete'] };
  }
  if (!healthy(input.adverse)) reasons.push('adverse-source-incomplete');
  if (!healthy(input.stability)) reasons.push('stability-source-incomplete');
  if (input.detached.sourceState !== 'missing' && !healthy(input.detached)) reasons.push('detached-source-incomplete');
  else if (input.detached.sourceState === 'missing') reasons.push('detached-source-missing');
  const shapedCandidates = input.proposals.flatMap((proposal) => {
    // A shape-only time filter earns nothing. Authenticate once only after it
    // excludes older rows, avoiding repeated Git authority reads per proposal.
    const merge = realizedMergeOf(proposal);
    if (!merge || !proposal.diff?.trim() || proposal.isPartial) return [];
    const mergedAt = merge.source === 'github-host' ? merge.mergedAt : merge.observedAt;
    if (!validTime(mergedAt, input.nowMs) || Date.parse(mergedAt) < lookbackMs) return [];
    return [{ proposal, merge, mergedAt }];
  }).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || a.proposal.id.localeCompare(b.proposal.id));
  // Enumeration is cheap; remote-authority authentication can spawn Git.
  // Never authenticate an unbounded history on the synchronous scorecard path.
  report.capped = shapedCandidates.length > MAX_RATINGS;
  if (report.capped) reasons.push('rating-limit');
  const candidates = shapedCandidates.slice(0, MAX_RATINGS).flatMap((candidate) => {
    const identity = canonicalRealizedMergeIdentity(candidate.proposal);
    return identity && identity.source === candidate.merge.source && identity.mergeCommitOid === candidate.merge.mergeCommitOid
      ? [{ ...candidate, identity }] : [];
  });
  report.candidateCount = report.capped ? null : candidates.length;
  if (new Set(candidates.map((c) => c.identity.key)).size !== candidates.length) {
    return { ...report, sourceState: 'degraded', complete: false, reasons: [...reasons, 'duplicate-merge-identity'] };
  }
  const key = loadExistingProvenanceKeyReadOnly();
  const repoDigests = new Map<string, string | null>();
  for (const { proposal, merge, identity, mergedAt } of candidates.slice(0, MAX_RATINGS)) {
    const diffHash = hashDiff(proposal.diff!);
    const bound = proposal.diffHash === diffHash && proposal.verifyResult?.passed === true &&
      proposal.verifyResult.diffHash === diffHash && proposal.localMergeIntent?.diffHash === diffHash &&
      proposal.localMergeIntent.proposalHeadOid === (merge.source === 'github-host' ? merge.expectedHeadOid : merge.proposalHeadOid);
    const eventDigest = digest([PR_RATING_POLICY_VERSION, identity.key, proposal.id, merge.source === 'github-host' ? merge.expectedHeadOid : merge.proposalHeadOid, diffHash]);
    const estimate = proposal.taste;
    const impactEstimate = estimate && dimension(estimate.alignment) && dimension(estimate.ambition) && dimension(estimate.design)
      ? { source: 'critic-estimate' as const, confidence: null, alignment: estimate.alignment, ambition: estimate.ambition, design: estimate.design } : null;
    const adverse = healthy(input.adverse) ? input.adverse.observations.filter((row) =>
      row.proposalId === proposal.id && row.repo === proposal.repo && row.mergeCommit === merge.mergeCommitOid &&
      validTime(row.observedAt, input.nowMs) && Date.parse(row.observedAt) >= Date.parse(mergedAt)) : [];
    if (proposal.repo && !repoDigests.has(proposal.repo)) repoDigests.set(proposal.repo, postMergeStabilityRepoDigest(proposal.repo));
    const repoDigest = proposal.repo ? repoDigests.get(proposal.repo) : null;
    const candidate = key && proposal.repo ? buildDetachedPostMergeCandidateIdentity({ repo: proposal.repo,
      proposalId: proposal.id, baseBranch: merge.base,
      candidateHead: merge.source === 'github-host' ? merge.expectedHeadOid : merge.proposalHeadOid,
      mergeCommit: merge.mergeCommitOid }, key) : null;
    const detached = candidate && healthy(input.detached) ? input.detached.cohorts
      .filter((cohort) => validTime(cohort.observedAt, input.nowMs))
      .flatMap((cohort) => cohort.members).filter((member) => member.repoDigest === candidate.repoDigest &&
        member.proposalId === candidate.proposalDigest && member.baseBranch === candidate.baseBranchDigest &&
        member.candidateHead === candidate.candidateHead && member.mergeCommit === candidate.mergeCommit &&
        member.sourceState === 'healthy' && member.terminal !== 'unknown' && member.verifiedHead === merge.mergeCommitOid &&
        validTime(member.verifiedAt ?? '', input.nowMs) && Date.parse(member.verifiedAt!) >= Date.parse(mergedAt)) : [];
    const witnesses = healthy(input.stability) && healthy(input.adverse) && bound && repoDigest
      ? input.stability.witnesses.filter((row) => row.proposalId === proposal.id && row.repoDigest === repoDigest &&
        row.mergeCommit === merge.mergeCommitOid && row.schemaVersion === 2 && row.verificationIsolation === 'detached-worktree' &&
        row.workspaceClean === true && (row.requiredCommandCount ?? 0) > 0 && row.windowMs >= MIN_WINDOW_MS &&
        row.windowStartedAt === mergedAt &&
        Date.parse(row.stableAt) >= Date.parse(row.windowStartedAt) + row.windowMs &&
        validTime(row.stableAt, input.nowMs) && validTime(row.verifiedAt ?? '', input.nowMs) &&
        Date.parse(row.verifiedAt!) >= Date.parse(row.stableAt) && detached.some((member) =>
          member.terminal === 'pass' && member.verifiedHead === row.observedHead && member.verifiedHead === merge.mergeCommitOid &&
          member.verifiedAt === row.verifiedAt && member.verifierManifestDigest === row.verificationDigest &&
          member.requiredCommandCount === row.requiredCommandCount)) : [];
    witnesses.sort((a, b) => Date.parse(b.stableAt) - Date.parse(a.stableAt));
    const adverseRank = { 'followed-up': 1, regressed: 2, reverted: 3 } as const;
    adverse.sort((a, b) => adverseRank[b.outcome] - adverseRank[a.outcome]);
    const adverseStatus = adverse.at(0)?.outcome;
    const failed = detached.find((member) => member.terminal === 'fail');
    // The strongest observed failure wins, even beside a positive witness.
    const status: PrRatingStatus = adverseStatus === 'reverted' || adverseStatus === 'regressed' ? adverseStatus :
      failed ? 'verification-failed' : adverseStatus ?? (
      !bound || !healthy(input.adverse) || !healthy(input.stability) || input.detached.sourceState !== 'missing' && !healthy(input.detached)
      ? 'unknown' : witnesses.length ? 'verified-window' : 'unobserved');
    const advisoryReward = status === 'reverted' ? -100 : status === 'regressed' ? -80 : status === 'verification-failed' ? -60 : status === 'followed-up' ? -20 :
      status === 'verified-window' && impactEstimate
        ? Math.round((impactEstimate.alignment * 0.35 + impactEstimate.ambition * 0.45 + impactEstimate.design * 0.2) * 20) : null;
    const row = { proposalId: proposal.id, mergeSource: merge.source,
      githubPr: identity.source === 'github-host' ? { url: identity.prUrl, repository: identity.repo,
        number: Number(identity.prUrl.split('/').at(-1)) } : null,
      eventDigest, diffHash,
      proposalHeadOid: merge.source === 'github-host' ? merge.expectedHeadOid : merge.proposalHeadOid,
      mergeCommitOid: merge.mergeCommitOid, observedHeadOid: (status === 'verification-failed' ? failed?.verifiedHead :
        adverse[0]?.observedHead ?? witnesses[0]?.observedHead ?? detached[0]?.verifiedHead) ?? null,
      mergedAt, status, impactEstimate, advisoryReward,
      evidenceDigests: [...(adverse.length ? [digest(adverse.map((r) => r.eventId).sort())] : []),
        ...(witnesses.length ? [digest(witnesses.map((r) => r.witnessDigest).sort())] : []),
        ...(detached.length ? [digest(detached.map((r) => r.memberDigest).sort())] : [])] };
    const rated = { ...row, ratingDigest: digest([PR_RATING_POLICY_VERSION, row]) };
    if (Buffer.byteLength(JSON.stringify([...report.ratings, rated])) > MAX_RATING_BYTES) {
      report.capped = true;
      reasons.push('rating-byte-limit');
      break;
    }
    report.ratings.push(rated);
  }
  report.complete = reasons.length === 0;
  report.sourceState = report.complete ? 'healthy' : 'degraded';
  return report;
}

/** Bounded local reads; never executes repository code or calls a provider. */
export function readPrRatings(proposals: readonly Proposal[], proposalSource: Source, sinceMs: number, nowMs: number): PrRatings {
  try {
    return buildPrRatings({ proposals, proposalSource, sinceMs, nowMs,
      adverse: readPostMergeObservations({ requireComplete: true, lockWaitMs: 0, maxBytes: 4 * 1024 * 1024, maxRows: 8192 }),
      stability: readPostMergeStability({ requireComplete: true, lockWaitMs: 0, maxFiles: 90, maxBytes: 4 * 1024 * 1024, maxRows: 8192 }),
      detached: readDetachedPostMergeVerificationCohorts({ requireComplete: true, maxFiles: 256, maxBytes: 8 * 1024 * 1024 }) });
  } catch {
    return { authority: 'observation-only', policyVersion: PR_RATING_POLICY_VERSION, policyEligible: false,
      sourceState: 'degraded', complete: false, candidateCount: null, capped: false, reasons: ['rating-source-unavailable'], ratings: [],
      sources: { adverse: 'degraded', stability: 'degraded', detached: 'degraded' }, lookbackStartedAt: null, scorecardWindowStartedAt: null };
  }
}
