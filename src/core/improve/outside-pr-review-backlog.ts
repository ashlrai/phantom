/**
 * Outside-PR review coverage → self-improvement backlog items.
 *
 * Sibling of outside-pr-backlog.ts and outside-pr-ci-backlog.ts on the
 * same journal: those feeds fold metrics/outside-pr-outcomes.jsonl per
 * repository for standing revert verdicts and for the `ci`
 * check-rollup verdict, and outside-pr-agent-backlog.ts folds it per
 * attributed agent — but every journaled row also carries `reviews`,
 * gh's review evidence for the merge (src/core/fleet/outside-pr-outcomes.ts):
 * a bounded `latest` reviewer count plus the closed-vocabulary
 * `decision`, or null when gh returned no parseable review fields.
 * `latest === 0` is a real signal, not missing evidence — gh returned
 * an empty latestReviews array, so the merge landed with zero recorded
 * reviewers. Until now the field's only readers were the sibling
 * prompts' context tallies and the router-weight report's advisory
 * community-seat section: a repo whose outside merges keep landing
 * unreviewed — green CI, no revert, no recorded review anywhere —
 * never became work.
 *
 * outsidePrReviewBacklogItems carries the recurring cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling feeds. Items
 * self-target: each cell's `repo` is the outside PRs' own repository
 * (validated against CLOUD_REPO_PATTERN), because the fix — review
 * gates for non-fleet heads, branch protection and rulesets requiring
 * approving reviews, CODEOWNERS coverage, merge-queue or auto-merge
 * policy — lives in that repo, not in the fleet's.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling feeds use)
 *    and parsed by parseOutsidePrOutcomeJournal; nothing is written and
 *    no network is touched. A missing journal folds as empty — no sync
 *    has recorded outcomes yet, a clean empty source, not a guess; an
 *    unreadable or non-file journal yields no items.
 *  - 'unknown' never counts. A null `reviews` — a pre-fields row or a
 *    gh read that returned no parseable review fields — is missing
 *    evidence, never a verdict: those rows tally as context and never
 *    toward the bar. `latest === 0` is the adverse verdict; `latest`
 *    above zero is reviewed and likewise never counts.
 *  - Adverse means recorded. An outside merge counts toward the bar
 *    only when its newest journaled row carries review evidence with
 *    `latest === 0` — gh's empty latestReviews array, meaning no
 *    reviewer stood on the merge when the sync read it. Reviews can
 *    happen off GitHub (chat, calls, a maintainer's own read), and a
 *    repo may intentionally carry no review requirement, so the prompt
 *    quotes the decision tallies and keeps the no-change escape rather
 *    than asserting the merges were wrong.
 *  - Recurring means recorded. A repo cell emits only at
 *    OUTSIDE_PR_REVIEW_RECURRING unreviewed merges inside the window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply
 *    to their own tallies — so one unreviewed merge never queues a
 *    session. Reviewed and unknown merges are quoted as the
 *    denominator: the signal is the share of review-evidenced outside
 *    merges that landed with zero recorded reviewers, not the raw
 *    count.
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
 *    product the sync's recorded branch/login convention matched, or
 *    null for the unattributed bucket; prompts quote that tally over
 *    the unreviewed rows and never claim a model — gh records none.
 *  - Reverts are context, not the signal. An unreviewed row's standing
 *    revert verdict is quoted per example and tallied, since a merge
 *    that was both unreviewed and reverted corroborates the pattern —
 *    but the sibling feeds own the revert signal itself.
 *  - Review decisions are context, not the bar. gh's computed
 *    reviewDecision tallies over the evidence-carrying rows — APPROVED,
 *    CHANGES_REQUESTED, REVIEW_REQUIRED, or no usable decision — are
 *    quoted so a repo whose merges mostly approved reads differently
 *    from one whose decision evidence is absent or adverse; only
 *    `latest === 0` moves the count.
 *  - Dedup is downstream. The item id embeds a stable hash of the repo
 *    identity (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a repo that stops producing unreviewed merges simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, PR numbers, titles, repos and authors are
 *    scrubbed, flattened and capped, and the brief names the journal,
 *    the sync, the commands and the machinery with the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import type { OutsidePrReviewDecision } from '../fleet/outside-pr-outcomes.js';
import {
  OUTSIDE_PR_FUTURE_SKEW_MS,
  OUTSIDE_PR_WINDOW_HOURS,
} from './outside-pr-backlog.js';
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
export const OUTSIDE_PR_REVIEW_MAX_ITEMS = 6;
const OUTSIDE_PR_REVIEW_ITEM_HARD_MAX = 12;
/**
 * Unreviewed outside merges one repo cell needs inside the window
 * before it counts as recurring — the same bar the sibling feeds
 * apply to their own tallies (RECURRING_FAILURES = 3).
 */
export const OUTSIDE_PR_REVIEW_RECURRING = 3;
/** Journal tail cap — the same 8 MiB bound the sibling feeds' dedup reads apply. */
const OUTSIDE_PR_REVIEW_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** PR-title snippet quoted per example inside one prompt. */
const MAX_TITLE_FIELD_CHARS = 120;
/** Unreviewed merges quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** Author tallies quoted per cell inside one prompt. */
const MAX_AUTHORS = 3;

/**
 * The adverse review evidence: gh's latestReviews array came back
 * empty, so the merge landed with zero recorded reviewers. `reviews`
 * itself must be non-null — a null record is missing evidence (a
 * pre-fields row or an unparseable gh read), never a verdict.
 */
const isUnreviewed = (row: OutsidePrOutcomeJournalRow): boolean =>
  row.reviews !== null && row.reviews.latest === 0;

/** One repo's in-window outside-merge review cell: recorded verdict tallies plus quoted evidence. */
export interface OutsidePrReviewBacklogCell {
  /** The outside PRs' own repository (owner/name as gh reported it). */
  repo: string;
  /** Outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges whose newest journaled row carries review evidence with zero recorded reviewers. */
  unreviewed: number;
  /** Merges whose newest journaled row carries review evidence with at least one recorded reviewer. */
  reviewed: number;
  /** Merges carrying any journaled `reviews` record — the review-evidence denominator. */
  reviewsKnown: number;
  /** Merges with no journaled `reviews` record (pre-fields rows, unparseable gh reads) — never counted. */
  reviewsUnknown: number;
  /** reviewsKnown merges whose journaled reviewDecision is APPROVED. */
  approved: number;
  /** reviewsKnown merges whose journaled reviewDecision is CHANGES_REQUESTED. */
  changesRequested: number;
  /** reviewsKnown merges whose journaled reviewDecision is REVIEW_REQUIRED. */
  reviewRequired: number;
  /** reviewsKnown merges whose journaled reviewDecision is null — reviewers recorded but no usable decision. */
  undecided: number;
  /** Unreviewed merges now carrying a standing revert verdict — corroboration, never the signal. */
  unreviewedReverted: number;
  /** Unreviewed merges by gh author login (null = ghost author), most unreviewed first. */
  authors: Array<{ author: string | null; unreviewed: number }>;
  /** Unreviewed merges by journaled agent attribution (null = unattributed), most unreviewed first. */
  agents: Array<{ agent: string | null; unreviewed: number }>;
  /** Up to MAX_EXAMPLES unreviewed merges, most recent merge first. */
  examples: Array<{ number: number; title: string; author: string | null; mergedAt: string; decision: OutsidePrReviewDecision | null; reverted: OutsidePrOutcomeJournalRow['reverted'] }>;
  /** ISO bounds of the unreviewed merges' mergedAt; null when none carried a parseable one. */
  firstUnreviewed: string | null;
  lastUnreviewed: string | null;
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-repo
 * review cells. Only merges inside the window count — before its start
 * or past the evaluation time plus the sibling feeds' future skew,
 * which is corrupt evidence that never reaches a cell; cells below the
 * recurring bar are dropped here so callers see only emittable
 * evidence. Null `reviews` records tally as `reviewsUnknown` context
 * and never toward the bar.
 */
export function foldOutsidePrReviewCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrReviewBacklogCell[] {
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
  const cells: OutsidePrReviewBacklogCell[] = [];
  for (const [repo, repoRows] of byRepo) {
    let unreviewed = 0;
    let reviewed = 0;
    let reviewsKnown = 0;
    let reviewsUnknown = 0;
    let approved = 0;
    let changesRequested = 0;
    let reviewRequired = 0;
    let undecided = 0;
    let unreviewedReverted = 0;
    const authorCounts = new Map<string | null, number>();
    const agentCounts = new Map<string | null, number>();
    const unreviewedRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of repoRows) {
      if (row.reviews === null) {
        reviewsUnknown += 1;
      } else {
        reviewsKnown += 1;
        if (row.reviews.decision === 'APPROVED') approved += 1;
        else if (row.reviews.decision === 'CHANGES_REQUESTED') changesRequested += 1;
        else if (row.reviews.decision === 'REVIEW_REQUIRED') reviewRequired += 1;
        else undecided += 1;
        if (isUnreviewed(row)) unreviewed += 1;
        else reviewed += 1;
      }
      if (!isUnreviewed(row)) continue;
      unreviewedRows.push(row);
      if (row.reverted === 'yes') unreviewedReverted += 1;
      authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
      agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
    }
    if (unreviewed < OUTSIDE_PR_REVIEW_RECURRING) continue;
    const times = unreviewedRows.map(mergedMs).filter(Number.isFinite);
    cells.push({
      repo,
      merged: repoRows.length,
      unreviewed,
      reviewed,
      reviewsKnown,
      reviewsUnknown,
      approved,
      changesRequested,
      reviewRequired,
      undecided,
      unreviewedReverted,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, unreviewed: count }))
        .sort((a, b) => b.unreviewed - a.unreviewed || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      agents: [...agentCounts.entries()]
        .map(([agent, count]) => ({ agent, unreviewed: count }))
        .sort((a, b) => b.unreviewed - a.unreviewed || (a.agent ?? '').localeCompare(b.agent ?? ''))
        .slice(0, MAX_AUTHORS),
      examples: [...unreviewedRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
          decision: row.reviews?.decision ?? null,
          reverted: row.reverted,
        })),
      firstUnreviewed: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastUnreviewed: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.unreviewed - a.unreviewed || a.repo.localeCompare(b.repo));
}

const NO_CHANGE = 'If the window has rolled forward, the repo\'s outside-PR path has already changed (review requirements in branch protection or rulesets, CODEOWNERS coverage, merge-queue or auto-merge policy, or reviews happening off GitHub that gh cannot see), the merges were correct verdicts on work that legitimately needed no recorded review, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set, each row\'s `reviews` field gh\'s review evidence for the merge. `phm fleet outside-outcomes --json` prints the same live read.';

function seenText(cell: OutsidePrReviewBacklogCell): string {
  if (cell.firstUnreviewed === null || cell.lastUnreviewed === null) return '';
  return cell.firstUnreviewed === cell.lastUnreviewed
    ? ` Merged ${cell.firstUnreviewed}.`
    : ` Merged ${cell.firstUnreviewed} through ${cell.lastUnreviewed}.`;
}

function tallyText(cell: OutsidePrReviewBacklogCell): string {
  const parts = [`${cell.merged} outside merges`];
  const verdicts = [
    cell.reviewsUnknown > 0 ? `${cell.reviewsUnknown} with no journaled review evidence (pre-fields rows or unparseable gh reads — they never count)` : null,
  ].filter((part): part is string => part !== null);
  if (verdicts.length > 0) parts.push(verdicts.join(', '));
  return parts.join(', ') + '.';
}

function reviewText(cell: OutsidePrReviewBacklogCell): string {
  if (cell.reviewsKnown === 0) return '';
  const parts = [`${cell.reviewsKnown} of the recorded merges carry journaled review evidence — ${cell.unreviewed} of those gh returned zero reviewers, ${cell.reviewed} at least one`];
  const decisions = [
    cell.approved > 0 ? `${cell.approved} APPROVED` : null,
    cell.changesRequested > 0 ? `${cell.changesRequested} CHANGES_REQUESTED` : null,
    cell.reviewRequired > 0 ? `${cell.reviewRequired} REVIEW_REQUIRED` : null,
    cell.undecided > 0 ? `${cell.undecided} with no usable decision` : null,
  ].filter((part): part is string => part !== null);
  if (decisions.length > 0) parts.push(`gh's computed reviewDecision across those rows: ${decisions.join(', ')}`);
  // Reverts corroborate but never drive this feed — the sibling feeds own that signal.
  const tail = cell.unreviewedReverted > 0 ? ` ${cell.unreviewedReverted} of the unreviewed merges now stand reverted.` : '';
  return ` Review evidence: ${parts.join('; ')}.${tail}`;
}

function authorsText(cell: OutsidePrReviewBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.unreviewed})`);
  return ` Unreviewed merges by gh author login: ${parts.join(', ')} — one login pushes work for many agents, so the login alone cannot say which produced a change.`;
}

function agentsText(cell: OutsidePrReviewBacklogCell): string {
  if (cell.agents.length === 0) return '';
  const parts = cell.agents.map((a) => `${a.agent ?? 'unattributed'} (${a.unreviewed})`);
  return ` Unreviewed merges by attributed agent (the journal's recorded branch/login convention — 'unattributed' means no known convention matched, and the model is never recorded): ${parts.join(', ')}.`;
}

const DECISION_LABELS: Record<OutsidePrReviewDecision, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested standing',
  REVIEW_REQUIRED: 'review required',
};

function examplesText(cell: OutsidePrReviewBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    const decision = example.decision === null ? 'no recorded decision' : DECISION_LABELS[example.decision];
    const reverted = example.reverted === 'yes' ? ', now standing reverted' : example.reverted === 'unknown' ? ', revert verdict unknown' : '';
    return `#${example.number}${title}${author} (merged ${example.mergedAt}, zero recorded reviewers${decision === 'no recorded decision' ? '' : `, ${decision}`}${reverted})`;
  });
  return ` Example unreviewed merges (most recent first): ${parts.join('; ')}.`;
}

/** Coverage caveats from the newest scan row; empty when the read saw nothing to qualify. */
function coverageText(scan: OutsidePrScanJournalRow | null): string[] {
  if (scan === null) return ['No scan receipt is journaled inside the read window, so repo coverage cannot be confirmed.'];
  const notes: string[] = [];
  if (scan.sourceState !== 'healthy') notes.push(`the newest scan row reports sourceState '${scan.sourceState}'`);
  if (scan.revertLedger !== 'read') notes.push(`the standing revert ledger read as '${scan.revertLedger}', which marks every verdict 'unknown' — quoted only as context here`);
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

function outsidePrReviewPrompt(
  cell: OutsidePrReviewBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const lead = partial
    ? `Outside contributors' pull requests on ${cell.repo} keep being merged with no recorded review — at least ${cell.unreviewed} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry journaled review evidence showing zero reviewers (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests on ${cell.repo} keep being merged with no recorded review — ${cell.unreviewed} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry journaled review evidence showing zero reviewers, the self-improvement work this backlog exists for.`;
  const scope = `The merges themselves are evidence, not the defect — what is in scope is this repository's outside-PR review path: whether branch protection or rulesets require approving reviews for non-fleet heads, whether CODEOWNERS coverage routes outside changes to a reviewer, whether merge-queue or auto-merge policy lets outside PRs land before any recorded review stands, and whether the fleet's own merge machinery should hold outside heads to a review bar fleet work already meets. gh's latestReviews counts recorded GitHub reviews only — reviews that happened off-platform or in a maintainer's head leave no trace, and a repo may intentionally carry no review requirement, so weigh the decision tallies before changing policy. Fix the cause in ${cell.repo}. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge; its 'reviews' field is gh's review evidence read after merge: 'latest' the number of reviewers whose latest review stands (0 means gh returned an empty latestReviews array — the merge landed with zero recorded reviewers, a real unreviewed signal) and 'decision' gh's computed reviewDecision (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when gh recorded no usable decision); the whole field is null when gh returned no parseable review fields, which is missing evidence and never counts. ${tallyText(cell)}${seenText(cell)}${reviewText(cell)}${authorsText(cell)}${agentsText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrReviewItem(
  cell: OutsidePrReviewBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): CloudBacklogItem {
  const title = `Outside merges on ${cell.repo} keep landing unreviewed`;
  const id = `outside-pr-review-${createHash('sha256').update(`outside-pr-review:${cell.repo}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrReviewPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

export interface OutsidePrReviewBacklogOptions {
  /** Runs dir holding metrics/outside-pr-outcomes.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default OUTSIDE_PR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default OUTSIDE_PR_REVIEW_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for repos whose outside merges keep landing with zero
 * recorded reviewers. Total: a missing journal, an unreadable journal,
 * or any read or fold failure yields no items rather than throwing into
 * discovery. Unlike the sibling machinery feeds there is no
 * fleet-repo gate — each cell self-targets the repository its outside
 * PRs landed on.
 */
export async function outsidePrReviewBacklogItems(opts: OutsidePrReviewBacklogOptions = {}): Promise<CloudBacklogItem[]> {
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
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_REVIEW_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrReviewCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_REVIEW_MAX_ITEMS, OUTSIDE_PR_REVIEW_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrReviewItem(cell, windowHours, partial, parsed.scan));
  } catch {
    return [];
  }
}
