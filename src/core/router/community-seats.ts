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
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  outsidePrOutcomeJournalPath,
  parseOutsidePrOutcomeJournal,
  type OutsidePrOutcomeJournalRow,
  type OutsidePrScanJournalRow,
} from '../fleet/outside-pr-outcome-ledger.js';
import { readLedgerTail } from './outcomes.js';

/** Journal tail cap — the same 8 MiB bound the improve fold's dedup read applies. */
export const COMMUNITY_SEATS_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Default evidence window in days — the outcome read's own window
 * (ListOutsidePrOutcomesOptions.days default), so the seats section
 * covers the same cohort `phm fleet outside-outcomes` reports live.
 */
export const COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS = 30;
export const COMMUNITY_SEATS_MAX_WINDOW_DAYS = 365;
/**
 * Future-skew ceiling on mergedAt stamps — the sibling feeds' one-minute
 * tolerance for clock drift between the recording host and the merge
 * timestamp's source.
 */
export const COMMUNITY_SEATS_FUTURE_SKEW_MS = 60_000;
/** Defensive bound on distinct agent buckets reported. */
export const COMMUNITY_SEATS_MAX_SEATS = 32;
/** Repo names quoted per coverage note; the scan lists at most MAX_REPOS upstream. */
const COMMUNITY_SEATS_MAX_DEGRADED_REPOS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Journal-tail read states; readLedgerTail never returns 'too-large' (the tail is always bounded). */
export type CommunitySeatsState = 'read' | 'missing' | 'unreadable' | 'not-file';

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

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-agent
 * cells. Only merges inside the window count — before its start or past
 * the evaluation time plus the future-skew tolerance, which is corrupt
 * evidence that never reaches a cell; rows whose mergedAt does not parse
 * are skipped the same way. 'unknown' verdicts tally as context and
 * never toward kept or reverted.
 */
export function foldCommunitySeats(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowDays: number },
): CommunitySeatOutcome[] {
  const sinceMs = opts.nowMs - opts.windowDays * DAY_MS;
  const untilMs = opts.nowMs + COMMUNITY_SEATS_FUTURE_SKEW_MS;
  const byAgent = new Map<string | null, { prs: number; reverted: number; kept: number; unknown: number; repos: Set<string> }>();
  for (const row of rows) {
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const cell = byAgent.get(row.agent) ?? { prs: 0, reverted: 0, kept: 0, unknown: 0, repos: new Set<string>() };
    cell.prs += 1;
    cell.repos.add(row.repo);
    if (row.reverted === 'yes') cell.reverted += 1;
    else if (row.reverted === 'unknown') cell.unknown += 1;
    else cell.kept += 1;
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
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
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
  const parsed = parseOutsidePrOutcomeJournal(read.text);
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
