/**
 * core/fleet/review-pick.ts — one read-only answer to "name a currently
 * unowned review task" (RQ-PHX-REVIEWPICK371): an open, non-draft PR that no
 * live claim or running worker names, with repository, PR/head and owner.
 *
 * Ownership evidence comes from the live readers already on master — never
 * new parsers: queue/claimed.tsv rows through parseClaimedTsv, the bus work
 * claims table through inspectBusWorkClaims, the coordination board through
 * readFleetBoard, and the process table through listLiveWorkers. A PR counts
 * as owned when a live, unexpired claim names its PR number, its head branch,
 * or an RQ-* id in its branch or title, or when a running worker carries that
 * id.
 *
 * HONESTY CONTRACT: a source that cannot be read lands in
 * `source.unavailable` and forces `picked: null` — the report says
 * 'ownership source unavailable' rather than guessing `owner: 'none'` on
 * partial evidence. `owner: 'none'` is only emitted when every source read
 * cleanly and none named the PR.
 *
 * READ-ONLY: the only network call is `gh pr list`; the module never creates
 * claims, posts comments or touches labels. Module top level performs no I/O.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from './bus-work-claims.js';
import { readFleetBoard, type FleetBoard } from './coordination.js';
import { readSource } from './runs-parked-queue.js';
import { parseClaimedTsv, type FleetRunsClaim } from './runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from './runs-live-workers.js';

export const REVIEW_PICK_SCHEMA = 'fleet.review-pick.v1' as const;
/** The `gh pr list --json` columns one review-pick read requests. */
export const REVIEW_PICK_GH_FIELDS = 'number,title,headRefName,headRefOid,isDraft,mergeStateStatus,updatedAt';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_PRS = 1000;
const MAX_CLAIM_ROWS = 4096;
const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BYTES = 2 * 1024 * 1024;
const CLAIMED_TSV_MAX_BYTES = 8 * 1024 * 1024;

export type ReviewPickSourceId = 'claimed-tsv' | 'bus-work-claims' | 'coordination' | 'live-workers';
export type ReviewPickSourceState = 'read' | 'missing' | 'unavailable';
const SOURCE_IDS: readonly ReviewPickSourceId[] = ['claimed-tsv', 'bus-work-claims', 'coordination', 'live-workers'];

/** One validated open-PR row: the shape `gh pr list` returns for REVIEW_PICK_GH_FIELDS. */
export interface ReviewPickPr {
  number: number;
  headSha: string;
  headRef: string;
  title: string;
  isDraft: boolean;
  mergeStateStatus: string;
  updatedAt: string;
}

/** The four ownership sources, each in the shape its existing reader returns. */
export interface ReviewPickClaims {
  /** readSource() state for queue/claimed.tsv plus the parseClaimedTsv rows over it. */
  claimedTsv: { state: 'healthy' | 'missing' | 'degraded'; claims: FleetRunsClaim[] };
  /** inspectBusWorkClaims() verbatim. */
  busWork: BusWorkClaimsInspection;
  /** readFleetBoard() verbatim; state 'unknown' is treated as unreadable. */
  board: FleetBoard;
  /** listLiveWorkers() verbatim. */
  liveWorkers: LiveWorkersSnapshot;
}

export interface ReviewPickInput {
  repo: string;
  prs: ReviewPickPr[];
  claims: ReviewPickClaims;
  /** Injected clock, ms since epoch. */
  now: number;
}

export interface ReviewPickPicked {
  repo: string;
  pr: number;
  head: string;
  head_sha: string;
  title: string;
  owner: 'none';
  reason: string;
}

export interface ReviewPickSkipped {
  pr: number;
  owner: string | null;
  why: string;
}

export interface ReviewPickSource {
  prs: 'read' | 'unavailable';
  claims: Record<ReviewPickSourceId, ReviewPickSourceState>;
  unavailable: ReviewPickSourceId[];
}

export interface ReviewPickResult {
  schema: typeof REVIEW_PICK_SCHEMA;
  as_of: string;
  repo: string;
  source: ReviewPickSource;
  picked: ReviewPickPicked | null;
  /** Why the answer is what it is — 'ownership source unavailable', 'no unowned non-draft open PRs', or the pick rationale. */
  reason: string;
  skipped: ReviewPickSkipped[];
  /** Non-draft PRs no readable source owns — the pool `picked` was drawn from, or withheld over. */
  unowned_candidates: number;
}

/** `RQ-<SEGMENT>` tokens on token boundaries; ids compare uppercased. */
const RQ_TOKEN_RE = /RQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
const HEAD_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{3,199}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function rqIdsOf(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(RQ_TOKEN_RE)) ids.add(match[0].toUpperCase());
  return ids;
}

/** `#N`, `PR-N`, `PR N`, `PR/N` or `pull/N` — never a bare number. */
function prNumberRe(n: number): RegExp {
  return new RegExp(`(?:#|PR[-\\s/]|pull/)${n}(?![0-9])`, 'i');
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\p{Cc}/gu, ' ').trim();
  return text && text.length <= max ? text : null;
}

/** Row validator; null when the row cannot name a PR at all. */
export function validReviewPickPr(row: unknown): ReviewPickPr | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const pr = row as Record<string, unknown>;
  const number = pr['number'];
  const title = bounded(pr['title'], 300);
  const headRef = bounded(pr['headRefName'] ?? pr['headRef'], 200);
  const headSha = bounded(pr['headRefOid'] ?? pr['headSha'], 80);
  const mergeStateStatus = bounded(pr['mergeStateStatus'], 40);
  const updatedAt = bounded(pr['updatedAt'], 60);
  if (!Number.isSafeInteger(number) || (number as number) < 1 || title === null || headRef === null
    || headSha === null || mergeStateStatus === null || updatedAt === null || typeof pr['isDraft'] !== 'boolean') return null;
  return {
    number: number as number,
    headSha,
    headRef,
    title,
    isDraft: pr['isDraft'] as boolean,
    mergeStateStatus: mergeStateStatus.toUpperCase() || 'UNKNOWN',
    updatedAt,
  };
}

/** Validate one `gh pr list` page; null when the page is not an array. */
export function parseReviewPickPrs(raw: unknown): ReviewPickPr[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, MAX_PRS).flatMap(row => {
    const pr = validReviewPickPr(row);
    return pr === null ? [] : [pr];
  });
}

interface LiveClaim {
  source: ReviewPickSourceId;
  owner: string;
  /** Bounded searchable text: the claim id, job or task string. */
  text: string;
  /** RQ-* tokens already extracted from `text` (uppercased). */
  rqIds: ReadonlySet<string>;
  /** 'claim' for ledger/table rows, 'worker' for a live process. */
  kind: 'claim' | 'worker';
}

function busState(source: BusWorkClaimsInspection['source']): ReviewPickSourceState {
  return source === 'available' ? 'read' : source === 'missing' ? 'missing' : 'unavailable';
}

/** Project each source's reader output to one read state plus its live claim rows. */
function collectClaims(input: ReviewPickClaims, nowMs: number, repo: string):
  { states: Record<ReviewPickSourceId, ReviewPickSourceState>; live: LiveClaim[] } {
  const states: Record<ReviewPickSourceId, ReviewPickSourceState> = {
    'claimed-tsv': input.claimedTsv.state === 'healthy' ? 'read' : input.claimedTsv.state === 'missing' ? 'missing' : 'unavailable',
    'bus-work-claims': busState(input.busWork.source),
    // readFleetBoard folds a missing ledger and an unreadable one into the same
    // 'unknown' — neither is evidence, so 'unavailable' is the honest label.
    'coordination': input.board.state === 'known' ? 'read' : 'unavailable',
    'live-workers': input.liveWorkers.sourceState === 'healthy' ? 'read' : 'unavailable',
  };
  const live: LiveClaim[] = [];
  const repoShort = repo.split('/')[1]?.toLowerCase() ?? null;
  if (states['claimed-tsv'] === 'read') {
    for (const row of input.claimedTsv.claims.slice(0, MAX_CLAIM_ROWS)) {
      live.push({ source: 'claimed-tsv', owner: row.lane, text: row.job, rqIds: rqIdsOf(row.job), kind: 'claim' });
    }
  }
  if (states['bus-work-claims'] === 'read') {
    for (const row of input.busWork.claims.slice(0, MAX_CLAIM_ROWS)) {
      if (row.completedAt !== null || !(row.leaseUntil > nowMs)) continue;
      live.push({ source: 'bus-work-claims', owner: row.owner, text: row.id, rqIds: rqIdsOf(row.id), kind: 'claim' });
    }
  }
  if (states['coordination'] === 'read') {
    for (const row of input.board.claims.slice(0, MAX_CLAIM_ROWS)) {
      // The ledger is fleet-wide; a claim on another repo cannot own this PR.
      if (!(row.expiresAt > nowMs) || row.repo.toLowerCase() !== repo.toLowerCase()) continue;
      const text = `${row.id} ${row.task}`;
      live.push({ source: 'coordination', owner: row.agent, text, rqIds: rqIdsOf(text), kind: 'claim' });
    }
  }
  if (states['live-workers'] === 'read') {
    for (const worker of input.liveWorkers.workers.slice(0, MAX_CLAIM_ROWS)) {
      // The process table is host-wide: attribute only workers on this repo.
      if (repoShort !== null && worker.repo.toLowerCase() !== repoShort) continue;
      live.push({ source: 'live-workers', owner: worker.lane, text: worker.job, rqIds: rqIdsOf(worker.job), kind: 'worker' });
    }
  }
  return { states, live };
}

/** The claim key a PR matches: RQ id, head branch or `#N` — first hit wins, source order above. */
function matchClaim(live: readonly LiveClaim[], pr: ReviewPickPr): { claim: LiveClaim; key: string } | null {
  const prRqIds = rqIdsOf(`${pr.headRef} ${pr.title}`);
  const headRef = HEAD_REF_RE.test(pr.headRef) ? pr.headRef : null;
  const numberRe = prNumberRe(pr.number);
  for (const claim of live) {
    for (const id of prRqIds) if (claim.rqIds.has(id)) return { claim, key: id };
    if (headRef !== null && claim.text.includes(headRef)) return { claim, key: `branch ${headRef}` };
    if (claim.text === String(pr.number) || numberRe.test(claim.text)) return { claim, key: `#${pr.number}` };
  }
  return null;
}

/** Candidate order: CLEAN, then BLOCKED/UNSTABLE, then DIRTY, then anything else; oldest update first. */
function mergeStateRank(status: string): number {
  if (status === 'CLEAN') return 0;
  if (status === 'BLOCKED' || status === 'UNSTABLE') return 1;
  if (status === 'DIRTY') return 2;
  return 3;
}

function updatedMs(pr: ReviewPickPr): number {
  const ms = Date.parse(pr.updatedAt);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function isoOf(nowMs: number): string {
  const date = new Date(nowMs);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/**
 * Pick at most one open PR no live source owns. Pure: every read arrives in
 * `input`, every answer — including 'no pick is honest right now' — is data.
 */
export function pickUnownedReview(input: ReviewPickInput): ReviewPickResult {
  const nowMs = Number.isSafeInteger(input.now) ? input.now : Number.NaN;
  const as_of = isoOf(nowMs);
  const { states, live } = collectClaims(input.claims, nowMs, input.repo);
  const unavailable = SOURCE_IDS.filter(id => states[id] === 'unavailable');
  const source: ReviewPickSource = { prs: 'read', claims: states, unavailable };

  const skipped: ReviewPickSkipped[] = [];
  const candidates: ReviewPickPr[] = [];
  for (const row of input.prs.slice(0, MAX_PRS)) {
    const pr = validReviewPickPr(row);
    if (pr === null) continue;
    const match = matchClaim(live, pr);
    const why: string[] = [];
    if (pr.isDraft) why.push('draft');
    if (match !== null) {
      why.push(match.claim.kind === 'worker'
        ? `running worker '${match.key}' via ${match.claim.source}`
        : `live claim '${match.key}' via ${match.claim.source}`);
    }
    if (why.length === 0) candidates.push(pr);
    else skipped.push({ pr: pr.number, owner: match?.claim.owner ?? null, why: why.join('; ') });
  }
  candidates.sort((a, b) =>
    mergeStateRank(a.mergeStateStatus) - mergeStateRank(b.mergeStateStatus)
    || updatedMs(a) - updatedMs(b)
    || a.number - b.number);

  if (unavailable.length > 0) {
    return {
      schema: REVIEW_PICK_SCHEMA, as_of, repo: input.repo, source, picked: null,
      reason: 'ownership source unavailable', skipped, unowned_candidates: candidates.length,
    };
  }
  if (input.prs.length === 0) {
    return {
      schema: REVIEW_PICK_SCHEMA, as_of, repo: input.repo, source, picked: null,
      reason: 'no open PRs', skipped, unowned_candidates: 0,
    };
  }
  const top = candidates[0];
  if (top === undefined) {
    return {
      schema: REVIEW_PICK_SCHEMA, as_of, repo: input.repo, source, picked: null,
      reason: 'no unowned non-draft open PRs', skipped, unowned_candidates: 0,
    };
  }
  const reason = `no live claim or running worker names it; merge state ${top.mergeStateStatus}; `
    + `oldest update among ${candidates.length} unowned candidate${candidates.length === 1 ? '' : 's'}`;
  return {
    schema: REVIEW_PICK_SCHEMA, as_of, repo: input.repo, source,
    picked: { repo: input.repo, pr: top.number, head: top.headRef, head_sha: top.headSha, title: top.title, owner: 'none', reason },
    reason, skipped, unowned_candidates: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// Collection: one gh read plus the four local ownership reads, each bounded
// and independently fail-safe. Everything is injectable so tests never touch
// the network, the process table or the real home directory.
// ---------------------------------------------------------------------------

export interface ReviewPickReadOptions {
  repo: string;
  /** `gh pr list --limit`, clamped to 1..500 (default 100). */
  limit?: number;
  /** Runs dir for queue/claimed.tsv; default `~/.ashlr-runs`. */
  runsDir?: string;
  gh?: CloudGh;
  readClaimedTsv?: () => Promise<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>;
  inspectBusWork?: () => BusWorkClaimsInspection;
  readBoard?: () => FleetBoard;
  listWorkers?: () => Promise<LiveWorkersSnapshot>;
  now?: () => number;
}

export type ReviewPickReport = ReviewPickResult;

const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

async function listOpenReviewPrs(repo: string, limit: number, gh: CloudGh): Promise<ReviewPickPr[] | null> {
  const result = await gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', REVIEW_PICK_GH_FIELDS,
  ]);
  if (!result.ok) return null;
  try { return parseReviewPickPrs(JSON.parse(result.stdout)); } catch { return null; }
}

async function guarded<T>(read: () => T | Promise<T>, fallback: () => T): Promise<T> {
  try { return await read(); } catch { return fallback(); }
}

/** Collect the open-PR page and every ownership source, then pick. Never throws. */
export async function readReviewPick(options: ReviewPickReadOptions): Promise<ReviewPickReport> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const repo = options.repo;
  const limit = Number.isSafeInteger(options.limit)
    ? Math.min(Math.max(options.limit as number, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');

  const readClaimedTsv = options.readClaimedTsv
    ?? (() => readSource(join(runsDir, 'queue', 'claimed.tsv'), CLAIMED_TSV_MAX_BYTES, false));
  const [claimed, busWork, board, liveWorkers] = await Promise.all([
    guarded(readClaimedTsv, () => ({ state: 'degraded' as const, text: '' })),
    guarded(() => options.inspectBusWork ? options.inspectBusWork() : inspectBusWorkClaims(),
      () => ({ source: 'unavailable' as const, claims: [] })),
    guarded(() => options.readBoard ? options.readBoard() : readFleetBoard({ now: nowMs }),
      () => ({ schema: 'fleet.coordination.v1' as const, state: 'unknown' as const, claims: [], messages: [], proposals: [], expiredClaims: null })),
    guarded(() => (options.listWorkers ?? listLiveWorkers)(),
      () => ({ v: 1 as const, generatedAt: isoOf(nowMs), sourceState: 'unavailable' as const, workers: [], leaders: [], orchestratorAgents: 0 })),
  ]);
  const claims: ReviewPickClaims = {
    claimedTsv: { state: claimed.state, claims: parseClaimedTsv(claimed.text) },
    busWork, board, liveWorkers,
  };

  const prs = REPO_RE.test(repo) ? await guarded(() => listOpenReviewPrs(repo, limit, options.gh ?? defaultGh), () => null) : null;
  if (prs === null) {
    const probe = pickUnownedReview({ repo, prs: [], claims, now: nowMs });
    const ownershipDown = probe.source.unavailable.length > 0;
    return {
      ...probe,
      source: { ...probe.source, prs: 'unavailable' },
      reason: ownershipDown ? 'pr and ownership sources unavailable' : 'pr source unavailable',
    };
  }
  const result = pickUnownedReview({ repo, prs, claims, now: nowMs });
  return { ...result, source: { ...result.source, prs: 'read' } };
}
