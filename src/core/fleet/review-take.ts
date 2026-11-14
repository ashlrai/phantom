/** Advisory review claims; leases coordinate agents and grant no execution authority. */
import {
  claimFleetWork, releaseFleetClaim, readFleetBoard,
  type FleetClaim,
} from './coordination.js';
import { readReviewPick, type ReviewPickReadOptions } from './review-pick.js';

export interface ReviewTakeOptions extends ReviewPickReadOptions {
  agent: string;
  ttlSeconds?: number;
  ledgerPath?: string;
  claim?: typeof claimFleetWork;
  release?: typeof releaseFleetClaim;
  readBoardAfter?: typeof readFleetBoard;
}

export interface ReviewTakeReport {
  schema: 'fleet.review-take.v1';
  outcome: 'claimed' | 'none' | 'unavailable' | 'duplicate' | 'conflict' | 'invalid-input';
  as_of: string;
  repo: string;
  pr: number | null;
  head: string | null;
  head_sha: string | null;
  title: string | null;
  owner: string | null;
  claim: { id: string; task: string; expiresAt: number } | null;
  /** Return to the caller's stdout only; never persist or log this release fence. */
  lease: string | null;
  pick_reason: string;
  reason: string;
}

/** Pick once, claim the deterministic work key, then yield to any foreign PR holder. */
export async function takeReview(options: ReviewTakeOptions): Promise<ReviewTakeReport> {
  const now = options.now ?? Date.now;
  const ledgerOptions = () => ({ path: options.ledgerPath, now: now() });
  const pick = await readReviewPick({
    ...options,
    readBoard: options.readBoard ?? (() => readFleetBoard(ledgerOptions())),
  });
  const picked = pick.picked;
  const report: ReviewTakeReport = {
    schema: 'fleet.review-take.v1', outcome: 'none', as_of: pick.as_of, repo: pick.repo,
    pr: picked?.pr ?? null, head: picked?.head ?? null, head_sha: picked?.head_sha ?? null,
    title: picked?.title ?? null, owner: null, claim: null, lease: null,
    pick_reason: pick.reason, reason: pick.reason,
  };
  if (picked === null) {
    return { ...report, outcome: pick.source.prs === 'unavailable' || pick.source.unavailable.length > 0 ? 'unavailable' : 'none' };
  }
  if (options.ttlSeconds !== undefined
    && (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 86400)) {
    return { ...report, outcome: 'invalid-input', reason: 'ttlSeconds requires 1-86400' };
  }
  const task = `review ${picked.repo}#${picked.pr} ${picked.head} @${picked.head_sha.slice(0, 12)}`;
  const result = (options.claim ?? claimFleetWork)({
    repo: picked.repo, task, agent: options.agent,
    ttlMs: options.ttlSeconds === undefined ? undefined : options.ttlSeconds * 1000,
  }, ledgerOptions());
  if (!result.ok) {
    const outcome = result.error === 'duplicate' || result.error === 'invalid-input' ? result.error : 'unavailable';
    return { ...report, outcome, reason: result.error };
  }
  const { claim, lease } = result.value;
  const receipt = { id: claim.id, task: claim.task, expiresAt: claim.expiresAt };
  let conflict: FleetClaim | undefined;
  let unavailable = false;
  try {
    const boardOptions = ledgerOptions();
    const board = (options.readBoardAfter ?? readFleetBoard)(boardOptions);
    unavailable = board.state !== 'known';
    const prRe = new RegExp(`#${picked.pr}(?![0-9])`);
    conflict = board.claims.find(other => other.id !== claim.id
      && other.repo.toLowerCase() === picked.repo.toLowerCase()
      && other.expiresAt > boardOptions.now && prRe.test(other.task));
  } catch { unavailable = true; }
  if (unavailable || conflict !== undefined) {
    const released = (options.release ?? releaseFleetClaim)({ id: claim.id, agent: options.agent, lease }, ledgerOptions());
    if (!released.ok) {
      // Retain the receipt so the caller can release a claim whose cleanup failed.
      return { ...report, outcome: 'unavailable', owner: options.agent, claim: receipt, lease, reason: 'claim release unavailable' };
    }
    return {
      ...report, outcome: unavailable ? 'unavailable' : 'conflict', owner: conflict?.agent ?? null,
      reason: unavailable ? 'coordination race check unavailable' : 'another live claim owns this PR',
    };
  }
  return {
    ...report, outcome: 'claimed', owner: options.agent,
    claim: receipt, lease, reason: 'review claimed',
  };
}
