/**
 * community-seats.ts — bounded read of the outside-PR outcome journal for
 * the advisory router-weight report's community-seat section.
 *
 * Community-scale RSI: outside contributors and their agents open PRs on
 * fleet repos, but the fleet's own ledgers (jobs.jsonl, work-market.jsonl)
 * only see `codex-bridge/*` work — a merged outside PR never becomes a
 * router outcome and never reaches the (work_class, lane) weight
 * proposals. The cloud scheduler's hourly improve sync already journals
 * what src/core/fleet/outside-pr-outcomes.ts measures — merged non-fleet
 * PRs per fleet repo joined to the standing revert set — as
 * fleet.outside-pr-outcome.v1 rows in
 * <runs>/metrics/outside-pr-outcomes.jsonl (contract:
 * src/core/fleet/outside-pr-outcome-ledger.ts). Until now the journal's
 * only folds were `phm fleet outside-outcomes` (a live gh read) and the
 * improve backlog's recurring-revert cells — a community seat whose
 * merges mostly held was invisible to the surface that proposes router
 * weights.
 *
 * This module folds the journal's newest-per-PR outcome rows into
 * per-attributed-agent tallies — the community-seat outcome evidence the
 * weight report carries beside its lane proposals. It is advisory
 * context only: outside PRs carry no lane or work_class, so they can
 * never enter a (work_class, lane) proposal group; the section exists so
 * the same report that moves fleet weights also shows which recorded
 * outside-agent conventions produce merges that hold versus merges that
 * get reverted.
 *
 * Honesty rules (same stance as outcomes.ts and outside-pr-backlog.ts):
 *   - Read-only. The journal is read through readLedgerTail's bounded
 *     no-follow tail read and parsed by parseOutsidePrOutcomeJournal;
 *     nothing is written and no network or gh call is made. A missing
 *     journal is state 'missing' — no sync has recorded outcomes yet, a
 *     clean empty source, not a guess.
 *   - Agent is convention attribution only. Journal rows carry the
 *     product the sync's recorded branch/login convention matched
 *     (outsidePrAgentAttribution), or null for the unattributed bucket —
 *     an honest unknown, never a guess. `model` is always null: gh
 *     records none.
 *   - 'unknown' never counts as held or reverted. A revert verdict is
 *     'yes' only when the standing revert ledger positively matched the
 *     PR; 'unknown' tallies separately and never moves a rate.
 *   - Latency, review and CI evidence stay honest. `ttm_known` counts
 *     only merges whose journaled `createdAt` parses at or before
 *     `mergedAt`; `reviews_known` counts only rows carrying a journaled
 *     `reviews` object — pre-fields rows read as unknown, never as
 *     unreviewed or zero-latency. `unreviewed` is a real gh signal
 *     (latestReviews empty), distinct from evidence never captured.
 *     `ci_known` counts only rows carrying a journaled `ci` verdict —
 *     the check-rollup outcome the sync's bounded per-PR `gh pr view`
 *     read recorded; 'none' inside that vocabulary is a real empty
 *     rollup (no CI ran), while a null `ci` (pre-fields rows, a failed
 *     or capped read) never counts toward any verdict.
 *   - Diff size stays honest the same way. `diff_known` counts only
 *     rows carrying a journaled `diff` triple — gh's recorded
 *     additions/deletions/changedFiles, frozen at merge; pre-fields
 *     rows and malformed records never count, and
 *     `diff_lines_mean`/`diff_files_mean` are means over that
 *     denominator (null when it is empty), never guessed zeros.
 *   - Windowed on the merge. mergedAt is when the outside PR landed —
 *     the same evidence clock the improve fold applies; rows whose
 *     mergedAt does not parse or sits past the evaluation-time skew
 *     cannot prove they are inside the window and are skipped.
 *   - Coverage is stated, not implied. The newest scan row's gh source
 *     state, revert-ledger state and per-repo read health ride along as
 *     `coverage`; a truncated tail or ignored lines mark every count a
 *     recorded floor ("at least"), matching the sibling feeds' rule.
 *   - Nothing here routes, weights or applies anything — the tallies are
 *     reported as evidence context only.
 */
import {
  outsidePrOutcomeJournalPath,
  parseOutsidePrOutcomeJournal,
  type OutsidePrOutcomeJournalRow,
  type OutsidePrScanJournalRow,
} from '../fleet/outside-pr-outcome-ledger.js';
import { readLedgerTail, resolveRouterRunsDir, type LedgerTailState } from './outcomes.js';

/** Journal tail cap — the same 8 MiB bound the improve fold's dedup read applies. */
export const COMMUNITY_SEATS_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Default evidence window in days — the outcome read's own window
 * (ListOutsidePrOutcomesOptions.days default), so the seats section
 * covers the same cohort `phm fleet outside-outcomes` reports live.
 */
export const COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS = 30;
const COMMUNITY_SEATS_MAX_WINDOW_DAYS = 365;
/**
 * Future-skew ceiling on mergedAt stamps — the sibling feeds' one-minute
 * tolerance for clock drift between the recording host and the merge
 * timestamp's source.
 */
const COMMUNITY_SEATS_FUTURE_SKEW_MS = 60_000;
/** Defensive bound on distinct agent buckets reported. */
const COMMUNITY_SEATS_MAX_SEATS = 32;
/** Repo names quoted per coverage note; the scan lists at most MAX_REPOS upstream. */
const COMMUNITY_SEATS_MAX_DEGRADED_REPOS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Journal-tail read states; readLedgerTail never returns 'too-large' (the tail is always bounded). */
export type CommunitySeatsState = LedgerTailState;

/** One attributed agent's in-window outside-merge tallies. */
export interface CommunitySeatOutcome {
  /**
   * Agent product the recorded branch/login convention attributes the
   * merges to; null is the unattributed bucket — no known convention
   * matched, an honest unknown rather than a guess.
   */
  agent: string | null;
  /** gh never records which model produced a change — always null. */
  model: null;
  /** Distinct repositories the seat's in-window merges landed on. */
  repos: number;
  /** In-window merged outside PRs across all verdicts. */
  prs: number;
  /** Merges carrying a standing revert verdict ('yes'). */
  reverted: number;
  /** Merges standing without a revert verdict ('no'). */
  kept: number;
  /** Merges whose revert verdict the ledger could not support ('unknown'). */
  unknown: number;
  /**
   * Merges whose journaled createdAt parses at or before mergedAt — the
   * open→merge latency denominator. Rows lacking a usable createdAt
   * (pre-fields rows, gh gaps) never count.
   */
  ttm_known: number;
  /** Mean open→merge minutes over ttm_known, one decimal; null when ttm_known is 0. */
  ttm_minutes_mean: number | null;
  /** Merges carrying a journaled reviews object — the review-evidence denominator. */
  reviews_known: number;
  /** reviews_known rows with at least one recorded reviewer (latestReviews non-empty). */
  reviewed: number;
  /** reviews_known rows gh returned with zero reviews — a real unreviewed signal, not missing evidence. */
  unreviewed: number;
  /** reviews_known rows whose reviewDecision is APPROVED. */
  approved: number;
  /** reviews_known rows whose reviewDecision is CHANGES_REQUESTED. */
  changes_requested: number;
  /** reviews_known rows whose reviewDecision is REVIEW_REQUIRED. */
  review_required: number;
  /**
   * Merges carrying a journaled `ci` verdict — the CI-evidence
   * denominator. Rows with a null `ci` (pre-fields rows, a failed or
   * capped per-PR read) never count, matching the reviews rule.
   */
  ci_known: number;
  /** ci_known rows whose head checks all passed ('success'). */
  ci_passed: number;
  /** ci_known rows with at least one failed head check ('failure'). */
  ci_failed: number;
  /** ci_known rows whose head checks were still incomplete ('pending'). */
  ci_pending: number;
  /** ci_known rows gh returned an empty rollup for — a real no-CI signal ('none'). */
  ci_none: number;
  /**
   * Merges carrying a journaled `diff` triple — gh's recorded
   * additions/deletions/changedFiles merge size, frozen at merge. Rows
   * journaled before the field existed, gh rows missing it, and
   * malformed records never count.
   */
  diff_known: number;
  /** Mean additions+deletions lines over diff_known, one decimal; null when diff_known is 0. */
  diff_lines_mean: number | null;
  /** Mean changedFiles over diff_known, one decimal; null when diff_known is 0. */
  diff_files_mean: number | null;
}

/** Coverage context from the journal's newest scan receipt; null when none parsed. */
export interface CommunitySeatsCoverage {
  /** The scan's gh source state; 'missing'/'degraded' means coverage may be partial. */
  source_state: 'healthy' | 'missing' | 'degraded';
  /** The scan's standing revert-ledger state; anything but 'read' marks every verdict 'unknown'. */
  revert_ledger: 'read' | 'missing' | 'unreadable';
  /** Repos whose scan read was degraded or hit gh's result limit, sorted, bounded. */
  degraded_repos: string[];
}

export interface OutsidePrCommunitySeatsRead {
  state: CommunitySeatsState;
  path: string;
  /** True when the retained tail was cut — seat counts cover the newest bytes only. */
  truncated: boolean;
  /** Journal lines the parser rejected; null unless state==='read'. */
  ignored_rows: number | null;
  /** Evidence window the seat tallies were folded under, in days. */
  window_days: number;
  /** ISO window start the fold applied (now - window_days). */
  since: string;
  /** Per attributed-agent tallies, most merges first; empty unless state==='read'. */
  seats: CommunitySeatOutcome[];
  /** Newest scan receipt's coverage fields; null when no scan row parsed or state!=='read'. */
  coverage: CommunitySeatsCoverage | null;
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);
const createdMs = (row: OutsidePrOutcomeJournalRow): number => (row.createdAt === null ? NaN : Date.parse(row.createdAt));

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-agent
 * cells. Only merges inside the window count — before its start or past
 * the evaluation time plus the future-skew tolerance, which is corrupt
 * evidence that never reaches a cell; rows whose mergedAt does not parse
 * are skipped the same way. 'unknown' verdicts tally as context and
 * never toward kept or reverted. Open→merge minutes count only when both
 * stamps parse and the PR did not "open" after it merged; review tallies
 * count only rows carrying a journaled reviews object.
 */
export function foldCommunitySeats(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowDays: number },
): CommunitySeatOutcome[] {
  const sinceMs = opts.nowMs - opts.windowDays * DAY_MS;
  const untilMs = opts.nowMs + COMMUNITY_SEATS_FUTURE_SKEW_MS;
  const byAgent = new Map<string | null, {
    prs: number; reverted: number; kept: number; unknown: number; repos: Set<string>;
    ttmKnown: number; ttmMinutes: number;
    reviewsKnown: number; reviewed: number; unreviewed: number;
    approved: number; changesRequested: number; reviewRequired: number;
    ciKnown: number; ciPassed: number; ciFailed: number; ciPending: number; ciNone: number;
    diffKnown: number; diffLines: number; diffFiles: number;
  }>();
  for (const row of rows) {
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const cell = byAgent.get(row.agent) ?? {
      prs: 0, reverted: 0, kept: 0, unknown: 0, repos: new Set<string>(),
      ttmKnown: 0, ttmMinutes: 0,
      reviewsKnown: 0, reviewed: 0, unreviewed: 0,
      approved: 0, changesRequested: 0, reviewRequired: 0,
      ciKnown: 0, ciPassed: 0, ciFailed: 0, ciPending: 0, ciNone: 0,
      diffKnown: 0, diffLines: 0, diffFiles: 0,
    };
    cell.prs += 1;
    cell.repos.add(row.repo);
    if (row.reverted === 'yes') cell.reverted += 1;
    else if (row.reverted === 'unknown') cell.unknown += 1;
    else cell.kept += 1;
    const openedMs = createdMs(row);
    if (Number.isFinite(openedMs) && openedMs <= mergedAtMs) {
      cell.ttmKnown += 1;
      cell.ttmMinutes += (mergedAtMs - openedMs) / 60_000;
    }
    if (row.reviews !== null) {
      cell.reviewsKnown += 1;
      if (row.reviews.latest > 0) cell.reviewed += 1;
      else cell.unreviewed += 1;
      if (row.reviews.decision === 'APPROVED') cell.approved += 1;
      else if (row.reviews.decision === 'CHANGES_REQUESTED') cell.changesRequested += 1;
      else if (row.reviews.decision === 'REVIEW_REQUIRED') cell.reviewRequired += 1;
    }
    if (row.ci !== null) {
      cell.ciKnown += 1;
      if (row.ci === 'success') cell.ciPassed += 1;
      else if (row.ci === 'failure') cell.ciFailed += 1;
      else if (row.ci === 'pending') cell.ciPending += 1;
      else if (row.ci === 'none') cell.ciNone += 1;
    }
    if (row.diff !== null) {
      cell.diffKnown += 1;
      cell.diffLines += row.diff.additions + row.diff.deletions;
      cell.diffFiles += row.diff.changedFiles;
    }
    byAgent.set(row.agent, cell);
  }
  return [...byAgent.entries()]
    .map(([agent, c]) => ({
      agent,
      model: null,
      repos: c.repos.size,
      prs: c.prs,
      reverted: c.reverted,
      kept: c.kept,
      unknown: c.unknown,
      ttm_known: c.ttmKnown,
      ttm_minutes_mean: c.ttmKnown === 0 ? null : Math.round((c.ttmMinutes / c.ttmKnown) * 10) / 10,
      reviews_known: c.reviewsKnown,
      reviewed: c.reviewed,
      unreviewed: c.unreviewed,
      approved: c.approved,
      changes_requested: c.changesRequested,
      review_required: c.reviewRequired,
      ci_known: c.ciKnown,
      ci_passed: c.ciPassed,
      ci_failed: c.ciFailed,
      ci_pending: c.ciPending,
      ci_none: c.ciNone,
      diff_known: c.diffKnown,
      diff_lines_mean: c.diffKnown === 0 ? null : Math.round((c.diffLines / c.diffKnown) * 10) / 10,
      diff_files_mean: c.diffKnown === 0 ? null : Math.round((c.diffFiles / c.diffKnown) * 10) / 10,
    }))
    .sort((a, b) => b.prs - a.prs || (a.agent ?? '').localeCompare(b.agent ?? ''))
    .slice(0, COMMUNITY_SEATS_MAX_SEATS);
}

/** The newest scan receipt's coverage fields, bounded for the report. */
function coverageFromScan(scan: OutsidePrScanJournalRow | null): CommunitySeatsCoverage | null {
  if (scan === null) return null;
  const degraded = scan.repos
    .filter((repo) => repo.state === 'degraded' || repo.hitLimit)
    .map((repo) => repo.repo)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, COMMUNITY_SEATS_MAX_DEGRADED_REPOS);
  return { source_state: scan.sourceState, revert_ledger: scan.revertLedger, degraded_repos: degraded };
}

/**
 * Read `<runsDir>/metrics/outside-pr-outcomes.jsonl` (or `journalPath`)
 * and fold its outcome rows into per-agent community-seat tallies.
 * `runsDir` resolves like readRouterOutcomes (ASHLR_RUNS_DIR, then
 * ~/.ashlr-runs) and must be absolute when given. Never throws on file
 * content — degraded input is a state, not an exception.
 */
export async function readOutsidePrCommunitySeats(opts: {
  runsDir?: string;
  journalPath?: string;
  /** Evidence window in days (default COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS, clamped to 1..365). */
  windowDays?: number;
  /** Clock anchoring the window and `since` (default: now). */
  now?: Date;
} = {}): Promise<OutsidePrCommunitySeatsRead> {
  const runsDir = resolveRouterRunsDir(opts.runsDir);
  const path = opts.journalPath ?? outsidePrOutcomeJournalPath(runsDir);
  const windowDays = Math.min(
    COMMUNITY_SEATS_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(opts.windowDays ?? COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS) || COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS),
  );
  const nowMs = (opts.now ?? new Date()).getTime();
  const since = new Date(nowMs - windowDays * DAY_MS).toISOString();
  const read = await readLedgerTail(path, COMMUNITY_SEATS_JOURNAL_MAX_BYTES);
  if (read.state !== 'read') {
    return {
      state: read.state, path, truncated: false, ignored_rows: null,
      window_days: windowDays, since, seats: [], coverage: null,
    };
  }
  const parsed = parseOutsidePrOutcomeJournal(read.text, nowMs);
  return {
    state: 'read',
    path,
    truncated: read.truncated,
    ignored_rows: parsed.ignored,
    window_days: windowDays,
    since,
    seats: foldCommunitySeats(parsed.outcomes, { nowMs, windowDays }),
    coverage: coverageFromScan(parsed.scan),
  };
}
