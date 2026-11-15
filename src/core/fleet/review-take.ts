/** Advisory review claims; leases coordinate agents and grant no execution authority. */
import { tmpdir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import {
  claimFleetWork, releaseFleetClaim, readFleetBoard,
  type FleetClaim,
} from './coordination.js';
import {
  readReviewPick, parseReviewPickPrs, REVIEW_PICK_GH_FIELDS,
  type ReviewPickPicked, type ReviewPickReadOptions,
} from './review-pick.js';

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BYTES = 2 * 1024 * 1024;
/** Default per-read deadline for the post-claim head re-read (ms). */
const READ_TIMEOUT_MS = 15_000;
/** Bound on the open-PR page the post-claim re-read scans. */
const RECHECK_LIMIT = 500;

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

const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/** What the post-claim re-read proved: the picked head still matches, the read failed, or a concrete staleness reason. */
type PickedHeadRecheck =
  | { kind: 'same' }
  | { kind: 'unreadable' }
  | { kind: 'stale'; reason: string };

/**
 * Await `read` under a deadline, mirroring review-pick's boundedRead: a throw
 * or timeout resolves `fallback` and a late settlement is dropped, so it can
 * never change the returned value or leak a timer.
 */
function boundedRead<T>(read: () => T | Promise<T>, fallback: () => T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback());
    }, timeoutMs);
    timer.unref?.();
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      Promise.resolve(read()).then(finish, () => finish(fallback()));
    } catch {
      finish(fallback());
    }
  });
}

/**
 * Re-read the picked PR on the same open-PR list read the pick used, after
 * the claim was acquired — a PR can close, turn draft or move its head while
 * acquisition runs. A claim is reported only for the same repository, PR
 * number, open non-draft state and full head SHA the pick observed. Read-only
 * and as-of: it can never prove the head will not move afterwards.
 */
async function recheckPickedHead(picked: ReviewPickPicked, gh: CloudGh, timeoutMs: number): Promise<PickedHeadRecheck> {
  const rows = await boundedRead(async () => {
    const result = await gh([
      'pr', 'list', '--repo', picked.repo, '--state', 'open', '--limit', String(RECHECK_LIMIT), '--json', REVIEW_PICK_GH_FIELDS,
    ]);
    if (!result.ok) return null;
    try { return parseReviewPickPrs(JSON.parse(result.stdout)); } catch { return null; }
  }, () => null, timeoutMs);
  if (rows === null) return { kind: 'unreadable' };
  const current = rows.find(row => row.number === picked.pr);
  if (current === undefined) return { kind: 'stale', reason: 'picked PR is no longer listed open' };
  if (current.headSha !== picked.head_sha) return { kind: 'stale', reason: 'picked PR head moved during claim' };
  if (current.isDraft) return { kind: 'stale', reason: 'picked PR became a draft during claim' };
  if (current.headRef !== picked.head) return { kind: 'stale', reason: 'picked PR head branch changed during claim' };
  return { kind: 'same' };
}

/** Pick once, claim the deterministic work key, then yield to any foreign PR holder. */
export async function takeReview(options: ReviewTakeOptions): Promise<ReviewTakeReport> {
  const now = options.now ?? Date.now;
  const ledgerOptions = () => ({ path: options.ledgerPath, now: now() });
  const readTimeoutMs = typeof options.readTimeoutMs === 'number'
    && Number.isFinite(options.readTimeoutMs) && options.readTimeoutMs > 0
    ? options.readTimeoutMs : READ_TIMEOUT_MS;
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
    const unavailable = pick.source.prs === 'unavailable' || pick.source.unavailable.length > 0;
    // Keep an unambiguous holder on refusal; multiple skipped PRs have no single owner.
    const owner = !unavailable && pick.skipped.length === 1 ? pick.skipped[0]!.owner : null;
    return { ...report, outcome: unavailable ? 'unavailable' : 'none', owner };
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
  /** Release only the lease just acquired; on failure keep the receipt so the caller can recover ownership. */
  const refuse = (outcome: 'none' | 'unavailable' | 'conflict', reason: string, owner: string | null): ReviewTakeReport => {
    const released = (options.release ?? releaseFleetClaim)({ id: claim.id, agent: options.agent, lease }, ledgerOptions());
    if (!released.ok) {
      return { ...report, outcome: 'unavailable', owner: options.agent, claim: receipt, lease, reason: 'claim release unavailable' };
    }
    return { ...report, outcome, owner, reason };
  };
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
    return refuse(unavailable ? 'unavailable' : 'conflict',
      unavailable ? 'coordination race check unavailable' : 'another live claim owns this PR',
      conflict?.agent ?? null);
  }
  const recheck = await recheckPickedHead(picked, options.gh ?? defaultGh, readTimeoutMs);
  if (recheck.kind !== 'same') {
    return refuse(recheck.kind === 'unreadable' ? 'unavailable' : 'none',
      recheck.kind === 'unreadable' ? 'picked PR recheck unavailable' : recheck.reason, null);
  }
  return {
    ...report, outcome: 'claimed', owner: options.agent,
    claim: receipt, lease, reason: 'review claimed',
  };
}
