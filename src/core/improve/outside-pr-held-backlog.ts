/**
 * Outside-PR agent-attribution held outcomes → self-improvement backlog items.
 *
 * Sibling of outside-pr-agent-backlog.ts on the same journal, on the
 * positive side of the verdict: that feed and its per-repo siblings fold
 * metrics/outside-pr-outcomes.jsonl for adverse evidence — standing
 * reverts, missing green CI, zero recorded reviewers — but every one of
 * their bars counts only failures. A merge that lands clean (no standing
 * revert, a 'success' check-rollup verdict, at least one recorded
 * reviewer) is the outcome community-scale RSI exists to produce, and
 * until now it was visible only inside `phm fleet outside-outcomes` and
 * the router-weight report's advisory community-seat section — reads
 * someone had to run. This feed folds the same rows per attributed
 * agent for the held-clean cell, so `phm improve discover` queues the
 * fleet-side study question the adverse feeds cannot ask: what
 * conventions this agent product's held merges share — verification
 * evidence, scope discipline, review responsiveness, PR hygiene — that
 * this repository's contributor guidance (CONTRIBUTING.md,
 * docs/CONTRIBUTE-WITH-AN-AGENT.md) and intake machinery do not yet
 * name, and whether a learned-skill candidate or guidance update should
 * capture them.
 *
 * Items emit only for the fleet's own repository: the study target —
 * contributor guidance and fleet intake conventions — lives in this
 * repository's machinery, the same gate the agent-attribution sibling
 * applies.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling feeds use)
 *    and parsed by parseOutsidePrOutcomeJournal; nothing is written and
 *    no network is touched. A missing journal folds as empty — no sync
 *    has recorded outcomes yet, a clean empty source, not a guess; an
 *    unreadable or non-file journal yields no items.
 *  - 'unknown' never counts. A revert verdict is 'no' only when the
 *    standing revert ledger positively cleared the PR; 'unknown' rows
 *    are context, never evidence toward the held bar. A null `ci` or
 *    null `reviews` record is missing evidence — pre-fields rows and
 *    unparseable gh reads — and likewise never counts, so a merge
 *    journaled before the evidence fields existed cannot inflate the
 *    held count.
 *  - Held-clean means all three legs recorded. A merge counts toward
 *    the bar only when its newest journaled row carries reverted 'no',
 *    ci 'success' and a reviews record with latest >= 1 — gh's
 *    latestReviews array non-empty, meaning at least one reviewer
 *    stood on the merge. Merges standing without a revert that miss a
 *    leg (red/pending/empty CI, zero or unrecorded reviewers) tally as
 *    `kept` context with their leg breakdown quoted, since they are
 *    good outcomes the full-evidence bar cannot claim.
 *  - Recurring means recorded. An agent cell emits only at
 *    OUTSIDE_PR_HELD_RECURRING held-clean merges inside the window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply
 *    to their own tallies — so one lucky merge never queues a session.
 *    The kept-but-not-clean share is quoted as the denominator context:
 *    the signal is the share of an agent's non-reverted merges that
 *    withstood the full evidence stack, not the raw count.
 *  - Dependency automation is not a study subject. 'dependabot' and
 *    'renovate' merges are version bumps — they author no conventions
 *    a fleet session could adopt, so their held merges would emit a
 *    permanent noise item every window. They are excluded by slug,
 *    documented here, and every other attributed agent stays eligible.
 *  - Windowed on the merge. mergedAt is when the outside PR landed;
 *    rows whose mergedAt does not parse cannot prove they are inside
 *    the window and are skipped. The journal's own `at` (when the sync
 *    recorded the verdict) is audit metadata, not the evidence clock.
 *  - Coverage is stated, not implied. The newest scan row's source
 *    state, revert-ledger state and per-repo read health are quoted in
 *    the prompt when they are not fully healthy, and a truncated tail
 *    or ignored lines make every count a recorded floor ("at least"),
 *    matching the sibling feeds' lower-bound rule.
 *  - Agent is convention-attributed, never a model claim. The cell key
 *    is the journaled product slug; prompts say so and never claim a
 *    model — gh records none.
 *  - Repo spread is evidence, not blame. The per-repo tally shows
 *    whether the held merges concentrate on one repository (where the
 *    sibling per-repo feeds' context already applies) or disperse
 *    across the fleet's repos (the agent-level pattern this feed
 *    exists for); the prompt states both readings and keeps the
 *    no-change escape.
 *  - Review, latency and size evidence is evidence, not blame. The
 *    same journaled createdAt/reviews/diff tallies the sibling quotes
 *    are folded over this agent's held-clean merges only, with stated
 *    denominators; kept-but-not-clean rows count in no evidence
 *    denominator and unknown coverage is quoted as unknown, never 0.
 *  - Dedup is downstream. The item id embeds a stable hash of the agent
 *    slug (never the counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; an agent
 *    that stops producing held-clean merges simply stops re-adding.
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
import type { OutsidePrReviewDecision } from '../fleet/outside-pr-outcomes.js';

/** Agent cells one call may emit; the attribution table bounds the slug space. */
export const OUTSIDE_PR_HELD_MAX_ITEMS = 8;
const OUTSIDE_PR_HELD_ITEM_HARD_MAX = 16;
/**
 * Held-clean outside merges one agent cell needs inside the window
 * before it counts as recurring — the same bar the sibling feeds apply
 * to their own tallies (RECURRING_FAILURES = 3).
 */
export const OUTSIDE_PR_HELD_RECURRING = 3;
/**
 * Agent slugs whose outside merges are dependency automation, not
 * authored work: 'dependabot' and 'renovate' version bumps carry no
 * reviewable conventions, so their held merges can never be a study
 * subject and are excluded before cells form.
 */
export const OUTSIDE_PR_HELD_EXCLUDED_AGENTS: ReadonlySet<string> = new Set(['dependabot', 'renovate']);
/** Journal tail cap — the same 8 MiB bound the sync's dedup read applies. */
const OUTSIDE_PR_HELD_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** PR-title snippet quoted per example inside one prompt. */
const MAX_TITLE_FIELD_CHARS = 120;
/** Held-clean merges quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** Author tallies quoted per cell inside one prompt. */
const MAX_AUTHORS = 3;
/** Repositories quoted per cell inside one prompt. */
const MAX_REPOS = 5;

const FLEET_REPO_NAME = 'phantom';

function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** One attributed agent's in-window outside-merge cell: recorded verdict tallies plus quoted evidence. */
export interface OutsidePrHeldBacklogCell {
  /** The journaled agent-attribution slug (never null — unattributed rows form no cell). */
  agent: string;
  /** This agent's outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges meeting the held-clean bar: reverted 'no', ci 'success', at least one recorded reviewer. */
  held: number;
  /** Merges carrying a standing revert verdict — the adverse siblings' signal, quoted as context. */
  reverted: number;
  /** Merges whose revert verdict the ledger could not support. */
  revertUnknown: number;
  /**
   * Merges standing without a revert that missed at least one held leg
   * — red/pending/empty/missing CI or zero/unrecorded reviewers. Good
   * outcomes the full-evidence bar cannot claim; the leg tallies below
   * quote which evidence they did carry.
   */
  keptOther: number;
  /** keptOther merges whose journaled ci verdict is 'success'. */
  keptCiSuccess: number;
  /** keptOther merges carrying any journaled `reviews` record. */
  keptReviewsKnown: number;
  /** keptReviewsKnown merges whose journaled reviews.latest is above zero. */
  keptReviewed: number;
  /**
   * Held merges whose journaled createdAt parses at or before
   * mergedAt — the open→merge latency denominator. Rows lacking a usable
   * createdAt never count, so the mean below is never a guessed zero.
   */
  ttm_known: number;
  /** Mean open→merge minutes over ttm_known held merges; null when ttm_known is 0. */
  ttm_minutes_mean: number | null;
  /**
   * Held merges carrying a journaled `diff` triple — gh's recorded
   * additions/deletions/changedFiles merge size. Rows journaled before
   * the field existed or carrying a malformed record never count.
   */
  diff_known: number;
  /** Mean additions+deletions lines over diff_known held merges; null when diff_known is 0. */
  diff_lines_mean: number | null;
  /** Mean changedFiles over diff_known held merges; null when diff_known is 0. */
  diff_files_mean: number | null;
  /** Held merges whose journaled reviewDecision is APPROVED. */
  approved: number;
  /** Held merges whose journaled reviewDecision is CHANGES_REQUESTED. */
  changesRequested: number;
  /** Held merges whose journaled reviewDecision is REVIEW_REQUIRED. */
  reviewRequired: number;
  /** Held merges whose journaled reviews record carried no usable decision. */
  undecided: number;
  /**
   * The repositories this agent's merges landed on inside the window,
   * most held first — the cross-repo spread that distinguishes an
   * agent-level pattern from a single repo's context.
   */
  repos: Array<{ repo: string; merged: number; held: number }>;
  /** Distinct repositories this agent's held merges landed on. */
  repos_held: number;
  /** Held merges by gh author login (null = ghost author), most held first. */
  authors: Array<{ author: string | null; held: number }>;
  /** Up to MAX_EXAMPLES held merges, most recent merge first; repo is quoted since cells span repos. */
  examples: Array<{ repo: string; number: number; title: string; author: string | null; mergedAt: string; decision: OutsidePrReviewDecision | null }>;
  /** ISO bounds of the held merges' mergedAt; null when none carried a parseable one. */
  firstHeld: string | null;
  lastHeld: string | null;
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);

/**
 * The held-clean bar: the merge stands without a revert, its head
 * checks all passed, and gh recorded at least one reviewer. Each leg is
 * a positive journaled verdict — 'unknown' reverts, null ci and null or
 * empty reviews records are missing evidence and never satisfy a leg.
 */
const isHeldClean = (row: OutsidePrOutcomeJournalRow): boolean =>
  row.reverted === 'no' && row.ci === 'success' && row.reviews !== null && row.reviews.latest > 0;

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-agent
 * held cells. Only merges inside the window count — before its start or
 * past the evaluation time plus the sibling feeds' future skew, which is
 * corrupt evidence that never reaches a cell; cells below the recurring
 * bar are dropped here so callers see only emittable evidence. Excluded
 * dependency-automation slugs and unattributed rows form no cell.
 */
export function foldOutsidePrHeldCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrHeldBacklogCell[] {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + OUTSIDE_PR_FUTURE_SKEW_MS;
  const byAgent = new Map<string, OutsidePrOutcomeJournalRow[]>();
  for (const row of rows) {
    if (row.agent === null || OUTSIDE_PR_HELD_EXCLUDED_AGENTS.has(row.agent)) continue;
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const list = byAgent.get(row.agent) ?? [];
    list.push(row);
    byAgent.set(row.agent, list);
  }
  const cells: OutsidePrHeldBacklogCell[] = [];
  for (const [agent, agentRows] of byAgent) {
    let held = 0;
    let reverted = 0;
    let revertUnknown = 0;
    let keptOther = 0;
    let keptCiSuccess = 0;
    let keptReviewsKnown = 0;
    let keptReviewed = 0;
    const authorCounts = new Map<string | null, number>();
    const repoCounts = new Map<string, { merged: number; held: number }>();
    const heldRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of agentRows) {
      const repoCell = repoCounts.get(row.repo) ?? { merged: 0, held: 0 };
      repoCell.merged += 1;
      if (isHeldClean(row)) {
        held += 1;
        repoCell.held += 1;
        heldRows.push(row);
        authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
      } else if (row.reverted === 'yes') reverted += 1;
      else if (row.reverted === 'unknown') revertUnknown += 1;
      else {
        keptOther += 1;
        if (row.ci === 'success') keptCiSuccess += 1;
        if (row.reviews !== null) {
          keptReviewsKnown += 1;
          if (row.reviews.latest > 0) keptReviewed += 1;
        }
      }
      repoCounts.set(row.repo, repoCell);
    }
    if (held < OUTSIDE_PR_HELD_RECURRING) continue;
    const times = heldRows.map(mergedMs).filter(Number.isFinite);
    const reposHeld = new Set(heldRows.map((row) => row.repo));
    let ttmKnown = 0;
    let ttmMinutes = 0;
    let diffKnown = 0;
    let diffLines = 0;
    let diffFiles = 0;
    let approved = 0;
    let changesRequested = 0;
    let reviewRequired = 0;
    let undecided = 0;
    for (const row of heldRows) {
      const openedMs = row.createdAt === null ? NaN : Date.parse(row.createdAt);
      const mergedAtMs = mergedMs(row);
      if (Number.isFinite(openedMs) && Number.isFinite(mergedAtMs) && openedMs <= mergedAtMs) {
        ttmKnown += 1;
        ttmMinutes += (mergedAtMs - openedMs) / 60_000;
      }
      if (row.diff !== null) {
        diffKnown += 1;
        diffLines += row.diff.additions + row.diff.deletions;
        diffFiles += row.diff.changedFiles;
      }
      // Held rows always carry a reviews record (the bar requires it);
      // only the decision vocabulary varies.
      if (row.reviews !== null) {
        if (row.reviews.decision === 'APPROVED') approved += 1;
        else if (row.reviews.decision === 'CHANGES_REQUESTED') changesRequested += 1;
        else if (row.reviews.decision === 'REVIEW_REQUIRED') reviewRequired += 1;
        else undecided += 1;
      }
    }
    cells.push({
      agent,
      merged: agentRows.length,
      held,
      reverted,
      revertUnknown,
      keptOther,
      keptCiSuccess,
      keptReviewsKnown,
      keptReviewed,
      ttm_known: ttmKnown,
      ttm_minutes_mean: ttmKnown === 0 ? null : Math.round((ttmMinutes / ttmKnown) * 10) / 10,
      diff_known: diffKnown,
      diff_lines_mean: diffKnown === 0 ? null : Math.round((diffLines / diffKnown) * 10) / 10,
      diff_files_mean: diffKnown === 0 ? null : Math.round((diffFiles / diffKnown) * 10) / 10,
      approved,
      changesRequested,
      reviewRequired,
      undecided,
      repos: [...repoCounts.entries()]
        .map(([repo, counts]) => ({ repo, merged: counts.merged, held: counts.held }))
        .sort((a, b) => b.held - a.held || a.repo.localeCompare(b.repo))
        .slice(0, MAX_REPOS),
      repos_held: reposHeld.size,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, held: count }))
        .sort((a, b) => b.held - a.held || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      examples: [...heldRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          repo: row.repo,
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
          decision: row.reviews?.decision ?? null,
        })),
      firstHeld: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastHeld: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.held - a.held || a.agent.localeCompare(b.agent));
}

const NO_CHANGE = 'If the window has rolled forward, the agent\'s outside-PR path has already changed (attribution conventions, intake guidance or merge policy), the held merges were ordinary good outcomes needing no fleet-side adoption, the conventions they share are already named in this repository\'s contributor guidance, the pattern concentrates on one repository the sibling per-repo feeds\' context already covers, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set (src/core/improve/revert-ledger.ts). `phm fleet outside-outcomes --json` prints the same live read, including the per-agent rollup.';

function seenText(cell: OutsidePrHeldBacklogCell): string {
  if (cell.firstHeld === null || cell.lastHeld === null) return '';
  return cell.firstHeld === cell.lastHeld
    ? ` Merged ${cell.firstHeld}.`
    : ` Merged ${cell.firstHeld} through ${cell.lastHeld}.`;
}

function tallyText(cell: OutsidePrHeldBacklogCell): string {
  const parts = [`${cell.merged} outside merges attributed to '${cell.agent}'`];
  if (cell.reverted > 0) parts.push(`${cell.reverted} carrying a standing revert verdict (the adverse sibling feeds own that signal)`);
  if (cell.revertUnknown > 0) parts.push(`${cell.revertUnknown} with an 'unknown' revert verdict (the revert ledger could not be read — they never count)`);
  if (cell.keptOther > 0) {
    const legs = [
      `${cell.keptCiSuccess} of those with a green CI verdict`,
      cell.keptReviewsKnown > 0 ? `${cell.keptReviewsKnown} carrying review evidence (${cell.keptReviewed} with at least one recorded reviewer)` : 'none carrying review evidence',
    ];
    parts.push(`${cell.keptOther} standing without a revert but missing a held leg — ${legs.join(', ')}`);
  }
  return parts.join(', ') + '.';
}

function reposText(cell: OutsidePrHeldBacklogCell): string {
  if (cell.repos.length === 0) return '';
  const parts = cell.repos.map((r) => `${r.repo} (${r.held} held of ${r.merged})`);
  const spread = cell.repos_held === 1
    ? 'every held merge landed on that one repository'
    : `the held merges span ${cell.repos_held} repositories`;
  return ` Held merges by repository: ${parts.join(', ')} — ${spread}.`;
}

function authorsText(cell: OutsidePrHeldBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.held})`);
  return ` Held merges by gh author login: ${parts.join(', ')} — one agent's work is pushed under many logins, so the login alone cannot say which session produced a change.`;
}

/**
 * The review/latency evidence the journaled rows carry for the held
 * merges — how fast they landed and what gh's computed reviewDecision
 * stood at journal time. Denominators are stated so "no evidence" never
 * reads as "no review"; an empty string when no held row carried either
 * field. The reviews leg itself is the bar, so only the decision
 * vocabulary varies across held rows.
 */
function reviewText(cell: OutsidePrHeldBacklogCell): string {
  const parts: string[] = [];
  if (cell.ttm_known > 0 && cell.ttm_minutes_mean !== null) {
    parts.push(`${cell.ttm_known} of the held merges carry a usable open→merge time (mean ${cell.ttm_minutes_mean} minutes)`);
  }
  const decisions = [
    cell.approved > 0 ? `${cell.approved} APPROVED` : null,
    cell.changesRequested > 0 ? `${cell.changesRequested} CHANGES_REQUESTED` : null,
    cell.reviewRequired > 0 ? `${cell.reviewRequired} REVIEW_REQUIRED` : null,
    cell.undecided > 0 ? `${cell.undecided} with no usable decision` : null,
  ].filter((part): part is string => part !== null);
  if (decisions.length > 0) parts.push(`gh's computed reviewDecision across the held merges: ${decisions.join(', ')}`);
  if (parts.length === 0) return '';
  return ` Review and merge-speed evidence (journaled gh fields — rows written before these fields existed count in no denominator): ${parts.join('; ')}.`;
}

/**
 * The diff-size evidence the journaled rows carry for the held merges —
 * how large the held changes were, so an agent whose held merges are
 * outsized reads differently than one landing fleet-typical diffs. The
 * denominator is stated so "no evidence" never reads as "empty diffs";
 * an empty string when no held row carried the field.
 */
function diffText(cell: OutsidePrHeldBacklogCell): string {
  if (cell.diff_known === 0 || cell.diff_lines_mean === null || cell.diff_files_mean === null) return '';
  return ` Diff-size evidence (journaled gh fields — rows written before the field existed count in no denominator): ${cell.diff_known} of the held merges carry journaled diff size (mean ${cell.diff_lines_mean} lines changed across ${cell.diff_files_mean} files).`;
}

function examplesText(cell: OutsidePrHeldBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    const decision = example.decision === null ? 'no recorded decision' : example.decision.toLowerCase().replace(/_/g, ' ');
    return `${example.repo}#${example.number}${title}${author} (merged ${example.mergedAt}, ${decision})`;
  });
  return ` Example held merges (most recent first): ${parts.join('; ')}.`;
}

/** Coverage caveats from the newest scan row; empty when the read saw nothing to qualify. */
function coverageText(scan: OutsidePrScanJournalRow | null): string[] {
  if (scan === null) return ['No scan receipt is journaled inside the read window, so repo coverage cannot be confirmed.'];
  const notes: string[] = [];
  if (scan.sourceState !== 'healthy') notes.push(`the newest scan row reports sourceState '${scan.sourceState}'`);
  if (scan.revertLedger !== 'read') notes.push(`the standing revert ledger read as '${scan.revertLedger}', which marks every verdict 'unknown' — 'unknown' never counts toward the bar, so the true held count may be lower`);
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

function outsidePrHeldPrompt(
  cell: OutsidePrHeldBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const agent = fieldText(cell.agent, MAX_FIELD_CHARS);
  const lead = partial
    ? `Outside contributors' pull requests attributed to agent product '${agent}' keep landing clean — at least ${cell.held} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window meet the held-clean bar (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests attributed to agent product '${agent}' keep landing clean — ${cell.held} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window meet the held-clean bar, the self-improvement work this backlog exists for.`;
  const scope = `The held merges themselves are evidence, not the defect — what is in scope is the fleet-side study question a recurring held pattern raises: what conventions '${agent}'-produced PRs share that this repository's outside-contributor guidance (CONTRIBUTING.md, docs/CONTRIBUTE-WITH-AN-AGENT.md) does not yet name — verification evidence in the PR body, scope discipline, review responsiveness, branch and commit hygiene — and whether a learned-skill candidate, a guidance update or an intake-machinery change should capture them so fleet and future outside work meet the same bar. Whether the held merges concentrate on one repository (where the sibling per-repo feeds' context already applies) or disperse across the fleet's repos is quoted above; per-repo gate questions belong to those feeds — this item owns the cross-repo, agent-attributed positive signal. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge; a merge is "held-clean" only when all three recorded legs stand: 'reverted' is 'no' (the standing revert ledger positively cleared it — 'unknown' never counts), 'ci' is 'success' (gh's check-rollup verdict on the merge head — 'failure', 'pending', 'none' and null missing evidence never count), and 'reviews' carries at least one recorded reviewer (gh's latestReviews count above zero — a null record or an empty array never counts). The 'agent' field is convention attribution only — the product whose recorded branch namespace or agent-bot login the sync matched (outsidePrAgentAttribution); rows no convention matched stay unattributed and form no agent cell, dependency-automation products are excluded as non-study subjects, and the model is never recorded because gh records none. ${tallyText(cell)}${seenText(cell)}${reposText(cell)}${authorsText(cell)}${reviewText(cell)}${diffText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrHeldItem(
  cell: OutsidePrHeldBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
  repo: string,
): CloudBacklogItem {
  const agent = fieldText(cell.agent, MAX_FIELD_CHARS);
  const title = `Outside '${agent}'-attributed merges keep landing clean`;
  const id = `outside-pr-agent-held-${createHash('sha256').update(`outside-pr-agent-held:${cell.agent}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrHeldPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface OutsidePrHeldBacklogOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/outside-pr-outcomes.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default OUTSIDE_PR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default OUTSIDE_PR_HELD_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for agent products whose outside merges keep landing
 * clean — the positive community-outcome signal the adverse sibling
 * feeds cannot see. Total: a missing journal, an unreadable journal, or
 * any read or fold failure yields no items rather than throwing into
 * discovery, and items emit only for the fleet's own repository since
 * the study question — contributor guidance and intake conventions —
 * lives in this repository's machinery, not in any single outside repo.
 */
export async function outsidePrHeldBacklogItems(opts: OutsidePrHeldBacklogOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
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
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_HELD_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrHeldCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_HELD_MAX_ITEMS, OUTSIDE_PR_HELD_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrHeldItem(cell, windowHours, partial, parsed.scan, repo));
  } catch {
    return [];
  }
}
