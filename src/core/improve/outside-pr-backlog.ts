/**
 * Outside-PR revert outcomes → self-improvement backlog items.
 *
 * The fleet's own ledgers only see `codex-bridge/*` work, so a merged
 * outside (community) PR leaves no outcome evidence in jobs.jsonl,
 * merge-events.jsonl or work-market.jsonl. The cloud scheduler's hourly
 * improve tick now journals what src/core/fleet/outside-pr-outcomes.ts
 * measures — merged non-fleet PRs per fleet repo joined to the standing
 * revert set — into <runs>/metrics/outside-pr-outcomes.jsonl through
 * src/core/fleet/outside-outcome-sync.ts (contract:
 * src/core/fleet/outside-pr-outcome-ledger.ts). Until now even that
 * journal had no reader: a repo whose outside merges keep being reverted
 * was visible only in `phm fleet outside-outcomes`, a report someone had
 * to run and read.
 *
 * outsidePrBacklogItems carries the recurring cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence
 * sources beside it. Items self-target: each cell's `repo` is the
 * outside PR's own repository (validated against CLOUD_REPO_PATTERN),
 * because the fix — review gates, CONTRIBUTING/CI bars for external
 * heads, auto-merge policy — lives in that repo, not in the fleet's.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling outcome
 *    ledgers use) and parsed by parseOutsidePrOutcomeJournal; nothing
 *    is written and no network is touched. A missing journal folds as
 *    empty — no sync has recorded outcomes yet, a clean empty source,
 *    not a guess; an unreadable or non-file journal yields no items.
 *  - 'unknown' never counts. A revert verdict is 'yes' only when the
 *    standing revert ledger positively matched the PR; an unreadable
 *    revert ledger marks every verdict 'unknown' and those rows are
 *    context, never evidence toward the recurring bar.
 *  - Recurring means recorded. A repo cell emits only at
 *    OUTSIDE_PR_REVERTED_RECURRING reverted merges inside the window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply
 *    to their own tallies — so one reverted PR never queues a session.
 *    Merges whose verdict is 'no' are quoted as the denominator: the
 *    signal is the revert rate among outside merges, not the raw count.
 *  - Windowed on the merge. mergedAt is when the outside PR landed;
 *    rows whose mergedAt does not parse cannot prove they are inside
 *    the window and are skipped. The journal's own `at` (when the sync
 *    recorded the verdict) is audit metadata, not the evidence clock.
 *  - Coverage is stated, not implied. The newest scan row's source
 *    state, revert-ledger state and per-repo read health are quoted in
 *    the prompt when they are not fully healthy, and a truncated tail
 *    or ignored lines make every count a recorded floor ("at least"),
 *    matching the sibling feeds' lower-bound rule.
 *  - Agent is convention-attributed. Journal rows carry the agent
 *    product the sync's recorded branch/login convention matched
 *    (outsidePrAgentAttribution), or null for the unattributed bucket;
 *    prompts quote that tally and never claim a model — gh records none.
 *  - Review and size evidence is evidence, not blame. Reverted merges'
 *    journaled createdAt/reviews/diff fields tally usable open→merge
 *    latency, gh's recorded review coverage — including merges gh shows
 *    as unreviewed or still CHANGES_REQUESTED — and the recorded merge
 *    size (mean lines changed and files touched), so a repo whose
 *    reverted outside merges were also its largest reads differently
 *    than one reverting small fixes. Pre-fields rows count in no
 *    denominator; unknown coverage is quoted as unknown, never 0.
 *  - Dedup is downstream. The item id embeds a stable hash of the repo
 *    identity (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a repo that stops producing reverted merges simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, PR numbers and titles are scrubbed,
 *    flattened and capped, and the brief names the journal, the sync,
 *    the commands and the machinery with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  outsidePrOutcomeJournalPath,
  parseOutsidePrOutcomeJournal,
  type OutsidePrJournalParse,
  type OutsidePrOutcomeJournalRow,
  type OutsidePrScanJournalRow,
} from '../fleet/outside-pr-outcome-ledger.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Repo cells one call may emit; bounded by fleet-repo count (MAX_REPOS = 10 upstream). */
export const OUTSIDE_PR_MAX_ITEMS = 6;
const OUTSIDE_PR_ITEM_HARD_MAX = 12;
/**
 * Reverted outside merges one repo cell needs inside the window before
 * it counts as recurring — the fleet's RECURRING_FAILURES convention
 * the sibling feeds apply to their own tallies.
 */
export const OUTSIDE_PR_REVERTED_RECURRING = 3;
/**
 * The evidence window: thirty days, matching the outcome read's own
 * window (ListOutsidePrOutcomesOptions.days default) — outside PR
 * volume is far below the fleet's own job cadence, so the sibling
 * feeds' seven-day recurrence window would almost never reach the bar.
 */
export const OUTSIDE_PR_WINDOW_HOURS = 24 * 30;
/**
 * Future-skew ceiling on mergedAt stamps, the sibling feeds' one-minute
 * tolerance for clock drift between the recording host and the merge
 * timestamp's source: a merge stamped further ahead than the evaluation
 * time is corrupt or replayed evidence and never reaches a cell.
 */
export const OUTSIDE_PR_FUTURE_SKEW_MS = 60_000;
/** Journal tail cap — the same 8 MiB bound the sync's dedup read applies. */
const OUTSIDE_PR_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** PR-title snippet quoted per example inside one prompt. */
const MAX_TITLE_FIELD_CHARS = 120;
/** Reverted PRs quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** Author tallies quoted per cell inside one prompt. */
const MAX_AUTHORS = 3;

/** One repo's in-window outside-merge cell: recorded verdict tallies plus quoted evidence. */
export interface OutsidePrBacklogCell {
  /** The outside PRs' own repository (owner/name as gh reported it). */
  repo: string;
  /** Outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges carrying a standing revert verdict. */
  reverted: number;
  /** Merges whose revert verdict the ledger could not support. */
  unknown: number;
  /** Merges standing without a revert verdict. */
  kept: number;
  /** Reverted merges by gh author login (null = ghost author), most reverted first. */
  authors: Array<{ author: string | null; reverted: number }>;
  /** Reverted merges by journaled agent attribution (null = unattributed), most reverted first. */
  agents: Array<{ agent: string | null; reverted: number }>;
  /**
   * Reverted merges whose journaled createdAt parses at or before
   * mergedAt — the open→merge latency denominator. Rows lacking a usable
   * createdAt never count, so the mean below is never a guessed zero.
   */
  ttm_known: number;
  /** Mean open→merge minutes over ttm_known reverted merges; null when ttm_known is 0. */
  ttm_minutes_mean: number | null;
  /** Reverted merges carrying a journaled reviews object — the review-evidence denominator. */
  reviews_known: number;
  /** reviews_known reverted merges gh returned with zero reviewers — a real "merged unreviewed" signal. */
  unreviewed: number;
  /** reviews_known reverted merges whose reviewDecision stands CHANGES_REQUESTED at journal time. */
  changes_requested: number;
  /**
   * Reverted merges carrying a journaled `diff` triple — gh's recorded
   * additions/deletions/changedFiles merge size. Rows journaled before
   * the field existed or carrying a malformed record never count.
   */
  diff_known: number;
  /** Mean additions+deletions lines over diff_known reverted merges; null when diff_known is 0. */
  diff_lines_mean: number | null;
  /** Mean changedFiles over diff_known reverted merges; null when diff_known is 0. */
  diff_files_mean: number | null;
  /** Up to MAX_EXAMPLES reverted merges, most recent merge first. */
  examples: Array<{ number: number; title: string; author: string | null; mergedAt: string }>;
  /** ISO bounds of the reverted merges' mergedAt; null when none carried a parseable one. */
  firstMerged: string | null;
  lastMerged: string | null;
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-repo
 * cells. Only merges inside the window count — before its start or past
 * the evaluation time plus the sibling feeds' future skew, which is
 * corrupt evidence that never reaches a cell; cells below the
 * recurring bar are dropped here so callers see only emittable
 * evidence. `unknown` verdicts tally as context and never toward the
 * bar.
 */
export function foldOutsidePrCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrBacklogCell[] {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + OUTSIDE_PR_FUTURE_SKEW_MS;
  const byRepo = new Map<string, OutsidePrOutcomeJournalRow[]>();
  for (const row of rows) {
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const list = byRepo.get(row.repo) ?? [];
    list.push(row);
    byRepo.set(row.repo, list);
  }
  const cells: OutsidePrBacklogCell[] = [];
  for (const [repo, repoRows] of byRepo) {
    let reverted = 0;
    let unknown = 0;
    let kept = 0;
    const authorCounts = new Map<string | null, number>();
    const agentCounts = new Map<string | null, number>();
    const revertedRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of repoRows) {
      if (row.reverted === 'yes') {
        reverted += 1;
        revertedRows.push(row);
        authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
        agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
      } else if (row.reverted === 'unknown') unknown += 1;
      else kept += 1;
    }
    if (reverted < OUTSIDE_PR_REVERTED_RECURRING) continue;
    const times = revertedRows.map(mergedMs).filter(Number.isFinite);
    let ttmKnown = 0;
    let ttmMinutes = 0;
    let reviewsKnown = 0;
    let unreviewed = 0;
    let changesRequested = 0;
    let diffKnown = 0;
    let diffLines = 0;
    let diffFiles = 0;
    for (const row of revertedRows) {
      const openedMs = row.createdAt === null ? NaN : Date.parse(row.createdAt);
      const mergedAtMs = mergedMs(row);
      if (Number.isFinite(openedMs) && Number.isFinite(mergedAtMs) && openedMs <= mergedAtMs) {
        ttmKnown += 1;
        ttmMinutes += (mergedAtMs - openedMs) / 60_000;
      }
      if (row.reviews !== null) {
        reviewsKnown += 1;
        if (row.reviews.latest === 0) unreviewed += 1;
        if (row.reviews.decision === 'CHANGES_REQUESTED') changesRequested += 1;
      }
      if (row.diff !== null) {
        diffKnown += 1;
        diffLines += row.diff.additions + row.diff.deletions;
        diffFiles += row.diff.changedFiles;
      }
    }
    cells.push({
      repo,
      merged: repoRows.length,
      reverted,
      unknown,
      kept,
      ttm_known: ttmKnown,
      ttm_minutes_mean: ttmKnown === 0 ? null : Math.round((ttmMinutes / ttmKnown) * 10) / 10,
      reviews_known: reviewsKnown,
      unreviewed,
      changes_requested: changesRequested,
      diff_known: diffKnown,
      diff_lines_mean: diffKnown === 0 ? null : Math.round((diffLines / diffKnown) * 10) / 10,
      diff_files_mean: diffKnown === 0 ? null : Math.round((diffFiles / diffKnown) * 10) / 10,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, reverted: count }))
        .sort((a, b) => b.reverted - a.reverted || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      agents: [...agentCounts.entries()]
        .map(([agent, count]) => ({ agent, reverted: count }))
        .sort((a, b) => b.reverted - a.reverted || (a.agent ?? '').localeCompare(b.agent ?? ''))
        .slice(0, MAX_AUTHORS),
      examples: [...revertedRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
        })),
      firstMerged: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastMerged: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.reverted - a.reverted || a.repo.localeCompare(b.repo));
}

const NO_CHANGE = 'If the window has rolled forward, the repo\'s outside-PR path has already changed (review gates, CI bars or merge policy), the reverts were correct verdicts on genuinely bad contributions, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set (src/core/improve/revert-ledger.ts). `phm fleet outside-outcomes --json` prints the same live read.';

function seenText(cell: OutsidePrBacklogCell): string {
  if (cell.firstMerged === null || cell.lastMerged === null) return '';
  return cell.firstMerged === cell.lastMerged
    ? ` Merged ${cell.firstMerged}.`
    : ` Merged ${cell.firstMerged} through ${cell.lastMerged}.`;
}

function tallyText(cell: OutsidePrBacklogCell): string {
  const parts = [`${cell.merged} outside merges`];
  if (cell.unknown > 0) parts.push(`${cell.unknown} with an 'unknown' revert verdict (the revert ledger could not be read — they never count toward the bar)`);
  if (cell.kept > 0) parts.push(`${cell.kept} standing without a revert`);
  return parts.join(', ') + '.';
}

function authorsText(cell: OutsidePrBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.reverted})`);
  return ` Reverted merges by gh author login: ${parts.join(', ')} — one login pushes work for many agents, so the login alone cannot say which produced a change.`;
}

function agentsText(cell: OutsidePrBacklogCell): string {
  if (cell.agents.length === 0) return '';
  const parts = cell.agents.map((a) => `${a.agent ?? 'unattributed'} (${a.reverted})`);
  return ` Reverted merges by attributed agent (the journal's recorded branch/login convention — 'unattributed' means no known convention matched, and the model is never recorded): ${parts.join(', ')}.`;
}

/**
 * The review/latency evidence the journaled rows carry for the reverted
 * merges — how fast they landed and whether gh recorded any review at
 * all. Denominators are stated so "no evidence" never reads as "no
 * review"; an empty string when no reverted row carried either field.
 */
function reviewText(cell: OutsidePrBacklogCell): string {
  const parts: string[] = [];
  if (cell.ttm_known > 0 && cell.ttm_minutes_mean !== null) {
    parts.push(`${cell.ttm_known} of the reverted merges carry a usable open→merge time (mean ${cell.ttm_minutes_mean} minutes)`);
  }
  if (cell.reviews_known > 0) {
    const reviewBits = [`${cell.reviews_known} of the reverted merges carry journaled review evidence`];
    if (cell.unreviewed > 0) reviewBits.push(`${cell.unreviewed} of those gh returned with zero reviewers — merged without a recorded review`);
    if (cell.changes_requested > 0) reviewBits.push(`${cell.changes_requested} still stood CHANGES_REQUESTED when the sync read them`);
    parts.push(reviewBits.join('; '));
  }
  if (parts.length === 0) return '';
  return ` Review and merge-speed evidence (journaled gh fields — rows written before these fields existed count in no denominator): ${parts.join('; ')}.`;
}

/**
 * The diff-size evidence the journaled rows carry for the reverted
 * merges — how large the reverted changes were, so a repo reverting its
 * biggest outside merges reads differently than one reverting small
 * fixes. The denominator is stated so "no evidence" never reads as
 * "empty diffs"; an empty string when no reverted row carried the field.
 */
function diffText(cell: OutsidePrBacklogCell): string {
  if (cell.diff_known === 0 || cell.diff_lines_mean === null || cell.diff_files_mean === null) return '';
  return ` Diff-size evidence (journaled gh fields — rows written before the field existed count in no denominator): ${cell.diff_known} of the reverted merges carry journaled diff size (mean ${cell.diff_lines_mean} lines changed across ${cell.diff_files_mean} files).`;
}

function examplesText(cell: OutsidePrBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    return `#${example.number}${title}${author} (merged ${example.mergedAt})`;
  });
  return ` Example reverted merges (most recent first): ${parts.join('; ')}.`;
}

/** Coverage caveats from the newest scan row; empty when the read saw nothing to qualify. */
function coverageText(scan: OutsidePrScanJournalRow | null): string[] {
  if (scan === null) return ['No scan receipt is journaled inside the read window, so repo coverage cannot be confirmed.'];
  const notes: string[] = [];
  if (scan.sourceState !== 'healthy') notes.push(`the newest scan row reports sourceState '${scan.sourceState}'`);
  if (scan.revertLedger !== 'read') notes.push(`the standing revert ledger read as '${scan.revertLedger}', which marks every verdict 'unknown' — 'unknown' never counts toward the bar, so the true reverted count may be higher`);
  const partial = scan.repos.filter((repo) => repo.state === 'degraded' || repo.hitLimit);
  if (partial.length > 0) {
    const why = partial.map((repo) => {
      const flags = [repo.state === 'degraded' ? 'degraded' : null, repo.hitLimit ? 'gh result limit hit' : null]
        .filter((flag): flag is string => flag !== null).join(', ');
      return `${repo.repo} (${flags})`;
    }).join(', ');
    notes.push(`repo reads were partial: ${why}`);
  }
  return notes.length === 0 ? [] : [`Coverage: ${notes.join('; ')}.`];
}

function outsidePrPrompt(
  cell: OutsidePrBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const lead = partial
    ? `Outside contributors' pull requests on ${cell.repo} keep being merged and then reverted — at least ${cell.reverted} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a standing revert verdict (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests on ${cell.repo} keep being merged and then reverted — ${cell.reverted} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a standing revert verdict, the self-improvement work this backlog exists for.`;
  const scope = `The reverts themselves are evidence, not the defect — what is in scope is this repository's outside-PR path: whether review or merge gates treat non-fleet heads differently than fleet work, whether CONTRIBUTING or CI bars outside contributions can realistically pass, whether auto-merge or merge-queue policy lets weak outside PRs land and then get reverted by hand, and whether the fleet's own merge machinery should route outside heads through a different lane. Fix the cause in ${cell.repo}. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge joined to the standing revert set: 'yes' means a revert of that PR is standing, 'no' means none is, 'unknown' means the revert ledger could not be read when the sync ran. ${tallyText(cell)}${seenText(cell)}${authorsText(cell)}${agentsText(cell)}${reviewText(cell)}${diffText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrItem(
  cell: OutsidePrBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): CloudBacklogItem {
  const title = `Outside PRs on ${cell.repo} keep being reverted after merge`;
  const id = `outside-pr-reverts-${createHash('sha256').update(`outside-pr-outcome:${cell.repo}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

export interface OutsidePrBacklogOptions {
  /** Runs dir holding metrics/outside-pr-outcomes.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default OUTSIDE_PR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default OUTSIDE_PR_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for repos whose outside merges keep being reverted.
 * Total: a missing journal, an unreadable journal, or any read or fold
 * failure yields no items rather than throwing into discovery. Unlike
 * the sibling machinery feeds there is no fleet-repo gate — each cell
 * self-targets the repository its outside PRs landed on.
 */
export async function outsidePrBacklogItems(opts: OutsidePrBacklogOptions = {}): Promise<CloudBacklogItem[]> {
  try {
    const home = opts.homeDir ?? homedir();
    // Same precedence the sync applies: explicit dir, then a non-empty
    // ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? outsidePrOutcomeJournalPath(runsDir);
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : OUTSIDE_PR_WINDOW_HOURS;
    const nowMs = (opts.now ?? new Date()).getTime();
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_MAX_ITEMS, OUTSIDE_PR_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrItem(cell, windowHours, partial, parsed.scan));
  } catch {
    return [];
  }
}
