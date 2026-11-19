/**
 * Post-merge learning evidence — report-only release protocol.
 *
 * A realized merge is an immutable operational fact, not proof that the
 * change remained beneficial. This module is the only prospective release
 * boundary, but it mints no operational authority while the observation source
 * remains adverse-only:
 *
 *   1. The proposal must carry an AUTHENTICATED realized-merge witness
 *      (authenticatedRealizedMergeOf — binds to this exact proposal via a
 *      local receipt HMAC or host reconciliation; shape alone is never
 *      authority).
 *   2. At least MIN_POST_MERGE_OBSERVATION_WINDOW_MS must have elapsed since
 *      the merge was observed. The regression sentinel / outcome watcher
 *      (outcome-watcher.ts) sweeps merged proposals on a 6h throttle with a
 *      7-day follow-up window; 14 days gives ~2x that follow-up window and
 *      dozens of scan cycles of headroom before we trust the silence.
 *   3. The signed, observation-only post-merge-observations ledger
 *      (post-merge-observations.ts) must contain NO adverse record
 *      ('regressed' | 'reverted' | 'followed-up') for this exact
 *      (repo, proposalId, mergeCommit) event, and the ledger must have read
 *      back healthy/complete (a degraded read fails closed — we never treat
 *      "couldn't check" as "checked clean").
 *   4. The signed post-merge-stability store (post-merge-stability.ts) must
 *      contain a RELEASED, manifested witness bound to this exact
 *      (repo, proposalId, mergeCommit) event — the positive "swept clean"
 *      proof the adverse-only ledger cannot give. Only cohort-manifested
 *      rows are returned as usable evidence; schema v2 is required because
 *      v1 cannot establish the verification environment. A degraded store
 *      fails closed; a missing store simply has no witnesses.
 *
 * Even with all four, POST_MERGE_CREDIT_OPERATIONAL_RELEASE keeps minting
 * disabled until the remaining release proofs (denominator-complete cohorts,
 * monotonic rollback anchor, authenticated release record) exist; evaluation
 * then reports 'report-only-operational-release-disabled' rather than a
 * token, which keeps "waiting on witnesses" distinguishable from "waiting on
 * the ops gate".
 *
 * HISTORICAL TOKEN SHAPE: the verifier remains fail-closed even for formerly
 * valid HMAC-shaped values while operational release is disabled.
 * isPostMergeCreditReleaseLabel() remains
 * "structural recognition only" — matching the bare literal — for the
 * existing defensive filters elsewhere that specifically reject the
 * unauthenticated literal (e.g. skill-records.ts, decisions-ledger.ts).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { loadOrCreateKey, signSkillCardAttestation } from '../foundry/provenance.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { causalMetadataFromProposal } from '../learning/causal.js';
import type { Proposal, SkillCard } from '../types.js';
import { readDecisions, recordDecision } from './decisions-ledger.js';
import { postMergeObservationEventId, readPostMergeObservations } from './post-merge-observations.js';
import { skillCardContentHash } from './skill-attestation.js';
import { POST_MERGE_CREDIT_RELEASE_LABEL } from './post-merge-credit-label.js';
import {
  postMergeStabilityRepoDigest,
  readPostMergeStability,
  type PostMergeStabilityReadResult,
} from './post-merge-stability.js';

export {
  POST_MERGE_CREDIT_RELEASE_LABEL,
  isPostMergeCreditReleaseLabel,
} from './post-merge-credit-label.js';

// ---------------------------------------------------------------------------
// Structural constants
// ---------------------------------------------------------------------------

export const POST_MERGE_CREDIT_POLICY_VERSION = 'post-merge-credit-v1' as const;
/**
 * Operational release remains disabled until a positive, complete stability
 * witness exists. The current adverse-only ledger supports reporting, not
 * authority to steer routing or promote reusable skills.
 */
export const POST_MERGE_CREDIT_OPERATIONAL_RELEASE = false as const;

/**
 * Minimum wall-clock time since the realized merge before credit MAY be
 * released. See module doc for rationale (~2x the outcome-watcher follow-up
 * window, dozens of throttled scan cycles of headroom).
 */
export const MIN_POST_MERGE_OBSERVATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Domain-separated HMAC payload prefix for minted credit tokens. */
const CREDIT_TOKEN_DOMAIN = 'ashlr:post-merge-credit-release:v1';

/**
 * Both segments are truncated to 24 hex chars (96 bits each) — plenty for
 * MAC-forgery infeasibility and event-identifier collision-resistance at
 * fleet scale, and DELIBERATELY short for two independent reasons discovered
 * empirically (see test/post-merge-credit-release.test.ts):
 *   1. decisions-ledger.ts's generic secret-scrubber (util/scrub.ts) redacts
 *      any bare 64+ char hex run as a likely API key/hash — a 64-char segment
 *      would be silently corrupted the moment it passed through
 *      recordDecision().
 *   2. recordDecision() -> sanitizeDecisionEntry() unconditionally ends with
 *      normalizeDecisionLearningFields() (learning/causal.ts), which re-runs
 *      causalMetadata() and applies boundedText(labelBasis, 80) — ANY
 *      labelBasis over 80 chars is silently truncated, with no way to opt
 *      out from a caller outside that module. The full token
 *      ("post-merge-credit-release-v1:" (30 chars) + eventRef + ':' + mac)
 *      must fit in 80 chars total, so each hex segment is capped at 24
 *      (30 + 24 + 1 + 24 = 79).
 * Neither constraint is owned by this module; 24 hex chars satisfies both
 * with margin.
 */
const CREDIT_REF_HEX_CHARS = 24;

/** `post-merge-credit-release-v1:<event-ref-hex32>:<hmac-hex32>` */
const CREDIT_TOKEN_RE = new RegExp(
  `^post-merge-credit-release-v1:([a-f0-9]{${CREDIT_REF_HEX_CHARS}}):([a-f0-9]{${CREDIT_REF_HEX_CHARS}})$`,
);

/** Truncate a full sha256 eventId to the reference used inside the token. */
function creditEventRef(eventId: string): string {
  return eventId.slice(0, CREDIT_REF_HEX_CHARS);
}

function computeCreditMac(eventRef: string): string | null {
  try {
    return createHmac('sha256', loadOrCreateKey())
      .update(`${CREDIT_TOKEN_DOMAIN}:${eventRef}`)
      .digest('hex')
      .slice(0, CREDIT_REF_HEX_CHARS);
  } catch {
    return null;
  }
}

function equalHex(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify that `labelBasis` is a validly-signed post-merge-credit release
 * token minted by evaluatePostMergeCreditRelease. Pure, synchronous
 * (host-local key read only), never throws. Deliberately rejects the bare
 * POST_MERGE_CREDIT_RELEASE_LABEL literal and any other string that is not a
 * correctly-formed, correctly-signed token — so raw ledgers, injected
 * dependencies, and caller-controlled metadata cannot mint credit.
 */
export function hasReleasedPostMergeCredit(labelBasis: unknown): boolean {
  try {
    if (!POST_MERGE_CREDIT_OPERATIONAL_RELEASE) return false;
    if (typeof labelBasis !== 'string') return false;
    const match = CREDIT_TOKEN_RE.exec(labelBasis);
    if (!match) return false;
    const eventRef = match[1]!;
    const mac = match[2]!;
    const expected = computeCreditMac(eventRef);
    if (!expected) return false;
    return equalHex(mac, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// evaluatePostMergeCreditRelease — the release protocol's eligibility check
// ---------------------------------------------------------------------------

export type PostMergeCreditEligibilityReason =
  | 'clean-window-elapsed'
  | 'no-authenticated-merge-witness'
  | 'invalid-merge-timestamp'
  | 'observation-window-not-elapsed'
  | 'observation-ledger-degraded'
  | 'adverse-outcome-observed'
  | 'stability-ledger-degraded'
  | 'no-positive-stability-witness'
  | 'report-only-operational-release-disabled'
  | 'signing-unavailable'
  | 'error';

export interface PostMergeCreditEligibility {
  eligible: boolean;
  /** Signed token to persist as labelBasis when eligible; null otherwise. */
  label: string | null;
  reason: PostMergeCreditEligibilityReason;
}

/**
 * The stability-store fields the release gate consumes. Batch callers (the
 * sweep) pass one shared snapshot so a pass reads the append-only store
 * once; single callers get a fresh bounded read by default.
 */
export type PostMergeCreditStabilitySnapshot = Pick<
  PostMergeStabilityReadResult,
  'witnesses' | 'sourceState' | 'complete'
>;

/**
 * Determine whether `proposal` has reportable post-merge evidence RIGHT NOW.
 * Operational eligibility remains false until a positive stability witness
 * exists. Fail-closed on every
 * ambiguous path (missing witness, unparseable timestamp, window not yet
 * elapsed, degraded/incomplete observation-ledger read, any adverse
 * observation for this exact merge event, degraded/incomplete stability
 * read, no manifested stability witness for this exact merge event, signing
 * failure). Never throws.
 *
 * This function does NOT persist anything — see sweepPostMergeCreditReleases
 * for the write-back that records a minted label to the decisions ledger.
 */
export function evaluatePostMergeCreditRelease(
  proposal: Proposal,
  opts: { nowMs?: number; stability?: PostMergeCreditStabilitySnapshot } = {},
): PostMergeCreditEligibility {
  try {
    if (!proposal || typeof proposal.id !== 'string' || proposal.id.length === 0) {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const evidence = authenticatedRealizedMergeOf(proposal);
    if (!evidence || typeof proposal.repo !== 'string' || proposal.repo.length === 0) {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const observedAtIso = evidence.source === 'github-host'
      ? evidence.reconciliation.observedAt
      : evidence.observedAt;
    const mergedAtMs = Date.parse(observedAtIso);
    if (!Number.isFinite(mergedAtMs)) {
      return { eligible: false, label: null, reason: 'invalid-merge-timestamp' };
    }
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs < mergedAtMs || nowMs - mergedAtMs < MIN_POST_MERGE_OBSERVATION_WINDOW_MS) {
      return { eligible: false, label: null, reason: 'observation-window-not-elapsed' };
    }

    let repoAbs: string;
    try {
      repoAbs = resolve(proposal.repo);
    } catch {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const eventId = postMergeObservationEventId({
      repo: repoAbs,
      proposalId: proposal.id,
      mergeCommit: evidence.mergeCommitOid.toLowerCase(),
    });

    // Adverse-only ledger: absence of a row is the only "clean" signal it can
    // ever give us. A degraded/incomplete read must NOT be treated as clean.
    const read = readPostMergeObservations({ requireComplete: true });
    if (read.sourceState === 'degraded' || !read.complete) {
      return { eligible: false, label: null, reason: 'observation-ledger-degraded' };
    }
    if (read.observations.some((observation) => observation.eventId === eventId)) {
      return { eligible: false, label: null, reason: 'adverse-outcome-observed' };
    }

    // The adverse ledger above proves only the negative. The positive
    // "swept clean" proof this release protocol requires is a RELEASED,
    // manifested stability witness (the store returns only cohort-manifested
    // rows) bound to this exact (repo, proposalId, mergeCommit) event. Only
    // schema v2 witnesses carry the sealed required-command execution
    // evidence — v1 cannot establish the verification environment. A
    // degraded store fails closed; a missing store simply has no witnesses.
    const stability = opts.stability ??
      readPostMergeStability({ requireComplete: true, lockWaitMs: 0 });
    if (stability.sourceState === 'degraded' || !stability.complete) {
      return { eligible: false, label: null, reason: 'stability-ledger-degraded' };
    }
    const repoDigest = postMergeStabilityRepoDigest(repoAbs);
    const witnessed = repoDigest !== null && stability.witnesses.some((witness) =>
      witness.schemaVersion === 2 &&
      witness.proposalId === proposal.id &&
      witness.mergeCommit === evidence.mergeCommitOid.toLowerCase() &&
      witness.repoDigest === repoDigest);
    if (!witnessed) {
      return { eligible: false, label: null, reason: 'no-positive-stability-witness' };
    }

    // A witnessed-stable merge still mints nothing while operational release
    // stays disabled: the remaining release proofs (denominator-complete
    // cohorts, monotonic rollback anchor, authenticated release record) are
    // separate lanes. This reason now distinguishes "waiting on witnesses"
    // from "waiting on the ops gate".
    if (!POST_MERGE_CREDIT_OPERATIONAL_RELEASE) {
      return {
        eligible: false,
        label: null,
        reason: 'report-only-operational-release-disabled',
      };
    }

    const eventRef = creditEventRef(eventId);
    const mac = computeCreditMac(eventRef);
    if (!mac) return { eligible: false, label: null, reason: 'signing-unavailable' };
    return {
      eligible: true,
      label: `${POST_MERGE_CREDIT_RELEASE_LABEL}:${eventRef}:${mac}`,
      reason: 'clean-window-elapsed',
    };
  } catch {
    return { eligible: false, label: null, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// sweepPostMergeCreditReleases — periodic write-back
// ---------------------------------------------------------------------------

/**
 * Bound on candidates inspected per sweep pass — mirrors outcome-watcher.ts's
 * own bounding so a large backlog degrades gracefully instead of blocking.
 */
const MAX_SWEEP_CANDIDATES = 200;

export interface PostMergeCreditSweepResult {
  /** Applied proposals inspected this pass. */
  scanned: number;
  /** Proposals for which a new credit-release decision row was recorded. */
  released: number;
  /** Proposals inspected but not released this pass (not yet eligible, or a
   *  transient error) — never a reason to trust the negative permanently. */
  skipped: number;
  /** Eligibility-reason counts for skipped proposals — the release funnel's
   *  diagnostics (e.g. distinguishes 'no-positive-stability-witness' from
   *  'report-only-operational-release-disabled'). Source-quality skips are
   *  reported via sourceComplete, not here. */
  skippedByReason: Record<string, number>;
  /** False when the proposal or decisions source was incomplete/degraded, or
   *  the candidate cap was hit — a hint the pass should be retried. */
  sourceComplete: boolean;
}

/**
 * Sweep applied proposals for post-merge diagnostics. No operational release
 * row is recorded while positive stability witnesses are unavailable.
 *
 * The post-merge-observations ledger only records adverse outcomes. Closing
 * the release path requires a positive, complete "swept clean" witness bound
 * to the exact merge event; elapsed time and silence are insufficient.
 *
 * SCALING NOTE: unlike outcome-watcher.ts, this sweep has no persistent
 * cursor — it re-scans applied proposals from the top of listProposalsDetailed
 * every pass, bounded by MAX_SWEEP_CANDIDATES. At small-to-moderate applied-
 * proposal counts this converges fine (already-released proposals are
 * skipped instantly via the decisions-ledger dedup check, so the cap mostly
 * matters for proposals still awaiting their window). At very large scale a
 * persistent cursor (mirroring monitoring-cursor.ts) would be needed to
 * guarantee every proposal eventually gets swept; out of scope here.
 *
 * Never throws.
 */
export function sweepPostMergeCreditReleases(
  opts: {
    nowMs?: number;
    listProposals?: () => Proposal[];
    /** Pre-read stability snapshot shared by every evaluation this pass. */
    stability?: PostMergeCreditStabilitySnapshot;
  } = {},
): PostMergeCreditSweepResult {
  const result: PostMergeCreditSweepResult = {
    scanned: 0, released: 0, skipped: 0, skippedByReason: {}, sourceComplete: true,
  };
  try {
    const nowMs = opts.nowMs ?? Date.now();

    let proposals: Proposal[];
    if (typeof opts.listProposals === 'function') {
      try {
        proposals = opts.listProposals();
      } catch {
        proposals = [];
      }
    } else {
      const read = listProposalsDetailed({ status: 'applied', requireComplete: true });
      if (!read.complete || read.sourceState === 'degraded') {
        result.sourceComplete = false;
        return result;
      }
      proposals = read.proposals;
    }

    // One bounded stability read per pass, shared by every evaluation — the
    // store is append-only signed evidence, so a mid-pass write cannot make
    // release decisions within the sweep inconsistent.
    const stability = opts.stability ??
      readPostMergeStability({ requireComplete: true, lockWaitMs: 0 });

    let inspected = 0;
    for (const proposal of proposals) {
      if (proposal.status !== 'applied') continue;
      if (inspected >= MAX_SWEEP_CANDIDATES) {
        result.sourceComplete = false;
        break;
      }
      inspected++;
      result.scanned++;
      try {
        const existing = readDecisions({ proposalId: proposal.id, requireComplete: true });
        const existingQuality = (existing as typeof existing & {
          sourceQuality?: { sourceState?: string; complete?: boolean };
        }).sourceQuality;
        if (existingQuality && (existingQuality.sourceState === 'degraded' || existingQuality.complete === false)) {
          result.skipped++;
          result.sourceComplete = false;
          continue;
        }
        const alreadyReleased = existing.some(
          (entry) => entry.action === 'merged' && hasReleasedPostMergeCredit(entry.labelBasis),
        );
        if (alreadyReleased) continue;

        const eligibility = evaluatePostMergeCreditRelease(proposal, { nowMs, stability });
        if (!eligibility.eligible || !eligibility.label) {
          result.skipped++;
          result.skippedByReason[eligibility.reason] =
            (result.skippedByReason[eligibility.reason] ?? 0) + 1;
          continue;
        }

        const ts = new Date(nowMs).toISOString();
        recordDecision({
          ts,
          proposalId: proposal.id,
          // NOTE: labelBasis is intentionally NOT routed through
          // causalMetadataFromProposal's `input.labelBasis` — causalMetadata()
          // (learning/causal.ts) applies boundedText(value, 80) to that field,
          // which would silently truncate our signed token (>80 chars) into
          // an unverifiable fragment. Set it directly below instead, after the
          // spread, so the full token survives.
          ...causalMetadataFromProposal(proposal, { ts, learningSource: 'outcome-record' }),
          action: 'merged',
          verdict: 'applied',
          labelBasis: eligibility.label,
          repo: proposal.repo ?? '',
          engine: proposal.engineModel ?? '',
          model: '',
        } as Parameters<typeof recordDecision>[0]);
        result.released++;
      } catch {
        result.skipped++;
      }
    }
    return result;
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// attestPostMergeCreditSkillCard — dedicated signing boundary
// ---------------------------------------------------------------------------

/**
 * Sign a SkillCard that legitimately carries released post-merge credit.
 *
 * skill-attestation.ts's generic attestSkillCard() deliberately refuses any
 * card for which hasReleasedPostMergeCredit(card.labelBasis) is true — its
 * signature payload doesn't cover the credit-release claim, so it must not
 * be the thing vouching for it. This module owns that proof, so it owns this
 * signing boundary too: same crypto primitive (signSkillCardAttestation),
 * same payload shape, so verifyAttestedSkillCard() on the read side still
 * validates cards signed here — only the gating differs (this function signs
 * ONLY when hasReleasedPostMergeCredit is true; attestSkillCard signs only
 * when it is false).
 *
 * Never throws.
 */
export function attestPostMergeCreditSkillCard(card: SkillCard): SkillCard | null {
  try {
    if (!hasReleasedPostMergeCredit(card.labelBasis)) return null;
    const diffHash = card.verification?.diffHash;
    if (!card.proposalId || !diffHash) return null;
    const contentHash = skillCardContentHash(card);
    const attestation = signSkillCardAttestation({
      contentHash,
      skillId: card.skillId,
      revision: card.revision,
      proposalId: card.proposalId,
      diffHash,
    });
    return attestation ? { ...card, contentHash, attestation } : null;
  } catch {
    return null;
  }
}
