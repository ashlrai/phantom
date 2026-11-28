/**
 * Outside-PR merge size → self-improvement backlog items.
 *
 * Sibling of outside-pr-backlog.ts, outside-pr-agent-backlog.ts,
 * outside-pr-ci-backlog.ts and outside-pr-review-backlog.ts on the same
 * journal: those feeds fold metrics/outside-pr-outcomes.jsonl per
 * repository for standing revert verdicts, per attributed agent, for the
 * `ci` check-rollup verdict, and for the `reviews` reviewer evidence —
 * but every journaled row also carries `diff`, gh's recorded merge size
 * for the PR (src/core/fleet/outside-pr-outcomes.ts): the
 * `additions`/`deletions`/`changedFiles` triple the same merged-list
 * read returns, frozen at merge, or null when the row carries none
 * (pre-fields rows) or the record is malformed. Until now the field's
 * only readers were the sibling prompts' context tallies and the
 * router-weight report's advisory community-seat section (which folds
 * it into per-agent `diff_lines_mean`/`diff_files_mean` weight-report
 * fields): a repo whose outside merges keep landing oversized — diffs
 * too large to review confidently, where regressions hide in the bulk
 * — never became work.
 *
 * outsidePrDiffBacklogItems carries the recurring cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling feeds. Items
 * self-target: each cell's `repo` is the outside PRs' own repository
 * (validated against CLOUD_REPO_PATTERN), because the fix — PR-size and
 * scope guidance in contributor docs, review norms for large diffs,
 * intake conventions that ask for a split — lives in that repo, not in
 * the fleet's.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling feeds use)
 *    and parsed by parseOutsidePrOutcomeJournal; nothing is written and
 *    no network is touched. A missing journal folds as empty — no sync
 *    has recorded outcomes yet, a clean empty source, not a guess; an
 *    unreadable or non-file journal yields no items.
 *  - 'unknown' never counts. A null `diff` — a pre-fields row or a
 *    malformed record — is missing evidence, never a verdict: those
 *    rows tally as `diffUnknown` context and never toward the bar. A
 *    recorded triple of real zeros is evidence (an empty merge) and
 *    counts in the denominator without being oversized.
 *  - Adverse means recorded. An outside merge counts toward the bar
 *    only when its newest journaled row carries a journaled `diff`
 *    triple whose additions+deletions reach OUTSIDE_PR_DIFF_LINES or
 *    whose changedFiles reach OUTSIDE_PR_DIFF_FILES — each a real gh
 *    count frozen at merge. Size is evidence of review burden, not
 *    proof the merge was wrong: a large generated-file refresh or a
 *    legitimate monorepo-wide change can be oversized and correct, so
 *    the prompt quotes the per-class split and keeps the no-change
 *    escape rather than asserting the merges were defects.
 *  - Recurring means recorded AND dominant. A repo cell emits only at
 *    OUTSIDE_PR_DIFF_RECURRING oversized merges inside the window AND
 *    only when oversized merges are at least half of the repo's
 *    diff-evidenced merges (`oversized * 2 >= diffKnown`) — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply to their own
 *    tallies, plus a share bar the raw-count siblings do not need: a
 *    revert or a red check is adverse wherever it lands, but a large
 *    diff is only a pattern when the repo's outside merges are
 *    routinely oversized, not when a few big changes sit among many
 *    small ones. Diff-unknown merges are quoted as context and never
 *    toward either side of the share.
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
 *    the oversized rows and never claim a model — gh records none.
 *  - Reverts are context, not the signal. An oversized row's standing
 *    revert verdict is quoted per example and tallied, since a merge
 *    that was both oversized and reverted corroborates the pattern —
 *    but the sibling feeds own the revert signal itself.
 *  - Dedup is downstream. The item id embeds a stable hash of the repo
 *    identity (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a repo that stops producing oversized merges simply stops
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
export const OUTSIDE_PR_DIFF_MAX_ITEMS = 6;
const OUTSIDE_PR_DIFF_ITEM_HARD_MAX = 12;
/**
 * Oversized outside merges one repo cell needs inside the window before
 * it counts as recurring — the same bar the sibling feeds apply to
 * their own tallies (RECURRING_FAILURES = 3).
 */
export const OUTSIDE_PR_DIFF_RECURRING = 3;
/**
 * The two size legs an outside merge can be oversized on: additions +
 * deletions at or above this many changed lines, or changedFiles at or
 * above this many files. A merge is oversized when EITHER leg reaches
 * its bound — a 60-file change of small edits is as hard to review as
 * a 3,000-line change of one file. The bounds sit well past the
 * factory's own largest session scope (frontier: 600 lines / 40 files),
 * so only merges too big for one confident review pass count.
 */
export const OUTSIDE_PR_DIFF_LINES = 2000;
export const OUTSIDE_PR_DIFF_FILES = 40;
/** Journal tail cap — the same 8 MiB bound the sibling feeds' dedup reads apply. */
const OUTSIDE_PR_DIFF_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** PR-title snippet quoted per example inside one prompt. */
const MAX_TITLE_FIELD_CHARS = 120;
/** Oversized merges quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** Author tallies quoted per cell inside one prompt. */
const MAX_AUTHORS = 3;

/** gh's recorded additions+deletions for a diff-known row; null-safe since callers gate on diff !== null. */
const diffLines = (row: OutsidePrOutcomeJournalRow): number =>
  row.diff === null ? 0 : row.diff.additions + row.diff.deletions;
const diffFiles = (row: OutsidePrOutcomeJournalRow): number => (row.diff === null ? 0 : row.diff.changedFiles);

/**
 * The adverse size evidence: the row carries a journaled `diff` triple
 * and either leg reaches its bound. `diff` must be non-null — a null
 * record is missing evidence (a pre-fields row or a malformed record),
 * never a verdict.
 */
const isOversized = (row: OutsidePrOutcomeJournalRow): boolean =>
  row.diff !== null && (diffLines(row) >= OUTSIDE_PR_DIFF_LINES || diffFiles(row) >= OUTSIDE_PR_DIFF_FILES);

/** One repo's in-window outside-merge size cell: recorded diff tallies plus quoted evidence. */
export interface OutsidePrDiffBacklogCell {
  /** The outside PRs' own repository (owner/name as gh reported it). */
  repo: string;
  /** Outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges whose newest journaled row carries a journaled `diff` triple that is oversized. */
  oversized: number;
  /** Oversized merges whose additions+deletions reached OUTSIDE_PR_DIFF_LINES (a merge can count on both legs). */
  overLines: number;
  /** Oversized merges whose changedFiles reached OUTSIDE_PR_DIFF_FILES (a merge can count on both legs). */
  overFiles: number;
  /** Merges carrying any journaled `diff` triple — the size-evidence denominator. */
  diffKnown: number;
  /** Merges with no journaled `diff` triple (pre-fields rows, malformed records) — never counted. */
  diffUnknown: number;
  /** Diff-known merges that were not oversized — the non-adverse half of the share. */
  sized: number;
  /** Oversized merges now carrying a standing revert verdict — corroboration, never the signal. */
  oversizedReverted: number;
  /** Oversized merges by gh author login (null = ghost author), most oversized first. */
  authors: Array<{ author: string | null; oversized: number }>;
  /** Oversized merges by journaled agent attribution (null = unattributed), most oversized first. */
  agents: Array<{ agent: string | null; oversized: number }>;
  /** Up to MAX_EXAMPLES oversized merges, most recent merge first. */
  examples: Array<{ number: number; title: string; author: string | null; mergedAt: string; lines: number; files: number; reverted: OutsidePrOutcomeJournalRow['reverted'] }>;
  /** ISO bounds of the oversized merges' mergedAt; null when none carried a parseable one. */
  firstOversized: string | null;
  lastOversized: string | null;
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-repo
 * size cells. Only merges inside the window count — before its start
 * or past the evaluation time plus the sibling feeds' future skew,
 * which is corrupt evidence that never reaches a cell; cells below the
 * recurring bar are dropped here so callers see only emittable
 * evidence. Null `diff` triples tally as `diffUnknown` context and
 * never toward the bar, and a cell emits only when its oversized
 * merges are at least half of its diff-evidenced merges — the share
 * bar that keeps a few large changes among many small ones from
 * reading as a repo pattern.
 */
export function foldOutsidePrDiffCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrDiffBacklogCell[] {
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
  const cells: OutsidePrDiffBacklogCell[] = [];
  for (const [repo, repoRows] of byRepo) {
    let oversized = 0;
    let overLines = 0;
    let overFiles = 0;
    let diffKnown = 0;
    let diffUnknown = 0;
    let sized = 0;
    let oversizedReverted = 0;
    const authorCounts = new Map<string | null, number>();
    const agentCounts = new Map<string | null, number>();
    const oversizedRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of repoRows) {
      if (row.diff === null) {
        diffUnknown += 1;
      } else {
        diffKnown += 1;
        if (isOversized(row)) {
          oversized += 1;
          oversizedRows.push(row);
          if (diffLines(row) >= OUTSIDE_PR_DIFF_LINES) overLines += 1;
          if (diffFiles(row) >= OUTSIDE_PR_DIFF_FILES) overFiles += 1;
          if (row.reverted === 'yes') oversizedReverted += 1;
          authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
          agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
        } else {
          sized += 1;
        }
      }
    }
    // Recurring AND dominant: enough oversized merges to be a pattern,
    // and oversized at least half of the diff-evidenced merges so a few
    // large changes among many small ones never reads as a repo pattern.
    if (oversized < OUTSIDE_PR_DIFF_RECURRING || oversized * 2 < diffKnown) continue;
    const times = oversizedRows.map(mergedMs).filter(Number.isFinite);
    cells.push({
      repo,
      merged: repoRows.length,
      oversized,
      overLines,
      overFiles,
      diffKnown,
      diffUnknown,
      sized,
      oversizedReverted,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, oversized: count }))
        .sort((a, b) => b.oversized - a.oversized || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      agents: [...agentCounts.entries()]
        .map(([agent, count]) => ({ agent, oversized: count }))
        .sort((a, b) => b.oversized - a.oversized || (a.agent ?? '').localeCompare(b.agent ?? ''))
        .slice(0, MAX_AUTHORS),
      examples: [...oversizedRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
          lines: diffLines(row),
          files: diffFiles(row),
          reverted: row.reverted,
        })),
      firstOversized: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastOversized: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.oversized - a.oversized || a.repo.localeCompare(b.repo));
}

const NO_CHANGE = 'If the window has rolled forward, the repo\'s outside-PR path has already changed (contributor PR-size or scope guidance, review norms for large diffs, intake conventions that ask for a split, or CODEOWNERS/ruleset coverage that routes big changes to a closer read), the oversized merges were correct verdicts on work that legitimately needed one large change (a generated-file refresh, a coordinated cross-cutting refactor, a vendored update), the merges were small in review terms despite the recorded line/file counts, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set, each row\'s `diff` field gh\'s recorded merge size (additions, deletions and changedFiles frozen at merge). `phm fleet outside-outcomes --json` prints the same live read.';

function seenText(cell: OutsidePrDiffBacklogCell): string {
  if (cell.firstOversized === null || cell.lastOversized === null) return '';
  return cell.firstOversized === cell.lastOversized
    ? ` Merged ${cell.firstOversized}.`
    : ` Merged ${cell.firstOversized} through ${cell.lastOversized}.`;
}

function tallyText(cell: OutsidePrDiffBacklogCell): string {
  const parts = [`${cell.merged} outside merges`];
  const verdicts = [
    cell.diffUnknown > 0 ? `${cell.diffUnknown} with no journaled diff evidence (pre-fields rows or malformed records — they never count)` : null,
  ].filter((part): part is string => part !== null);
  if (verdicts.length > 0) parts.push(verdicts.join(', '));
  return parts.join(', ') + '.';
}

function sizeText(cell: OutsidePrDiffBacklogCell): string {
  if (cell.diffKnown === 0) return '';
  const legs = [
    cell.overLines > 0 ? `${cell.overLines} over ${OUTSIDE_PR_DIFF_LINES.toLocaleString('en-US')} changed lines` : null,
    cell.overFiles > 0 ? `${cell.overFiles} over ${OUTSIDE_PR_DIFF_FILES} changed files` : null,
  ].filter((part): part is string => part !== null);
  const legText = legs.length === 0 ? '' : ` Oversized legs: ${legs.join(', ')} (a merge can reach both).`;
  // Reverts corroborate but never drive this feed — the sibling feeds own that signal.
  const tail = cell.oversizedReverted > 0 ? ` ${cell.oversizedReverted} of the oversized merges now stand reverted.` : '';
  return ` Size evidence: ${cell.diffKnown} of the recorded merges carry journaled diff size — ${cell.oversized} of those oversized (at least half the diff-evidenced merges), ${cell.sized} sized within bounds.${legText}${tail}`;
}

function authorsText(cell: OutsidePrDiffBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.oversized})`);
  return ` Oversized merges by gh author login: ${parts.join(', ')} — one login pushes work for many agents, so the login alone cannot say which produced a change.`;
}

function agentsText(cell: OutsidePrDiffBacklogCell): string {
  if (cell.agents.length === 0) return '';
  const parts = cell.agents.map((a) => `${a.agent ?? 'unattributed'} (${a.oversized})`);
  return ` Oversized merges by attributed agent (the journal's recorded branch/login convention — 'unattributed' means no known convention matched, and the model is never recorded): ${parts.join(', ')}.`;
}

function examplesText(cell: OutsidePrDiffBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    const reverted = example.reverted === 'yes' ? ', now standing reverted' : example.reverted === 'unknown' ? ', revert verdict unknown' : '';
    return `#${example.number}${title}${author} (merged ${example.mergedAt}, ${example.lines.toLocaleString('en-US')} lines across ${example.files} files${reverted})`;
  });
  return ` Example oversized merges (most recent first): ${parts.join('; ')}.`;
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

function outsidePrDiffPrompt(
  cell: OutsidePrDiffBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const lead = partial
    ? `Outside contributors' pull requests on ${cell.repo} keep landing oversized diffs — at least ${cell.oversized} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry journaled diff size showing a merge too large for one confident review pass, and oversized merges are at least half of the repo's diff-evidenced merges (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests on ${cell.repo} keep landing oversized diffs — ${cell.oversized} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry journaled diff size showing a merge too large for one confident review pass, and oversized merges are at least half of the repo's diff-evidenced merges, the self-improvement work this backlog exists for.`;
  const scope = `The merges themselves are evidence, not the defect — what is in scope is this repository's outside-PR size and review path: whether contributor guidance (CONTRIBUTING.md, the PR template, docs/CONTRIBUTE-WITH-AN-AGENT.md) names a PR-size or scope expectation outside agents can read before they open a change, whether review norms route large diffs to a closer read or ask for a split, whether intake conventions should ask contributors to break oversized work into stacked or sequential PRs, and whether the fleet's own merge machinery should weigh diff size when deciding how much verification an outside head earns. A large diff is not proof the merge was wrong — generated-file refreshes, coordinated cross-cutting refactors and vendored updates are legitimately oversized — so weigh the revert, CI and review signals the sibling feeds own before changing policy. Fix the cause in ${cell.repo}. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge; its 'diff' field is gh's recorded merge size — 'additions' and 'deletions' the changed line counts and 'changedFiles' the files the diff touched, all frozen at merge by the same merged-list read. A merge is "oversized" when its additions+deletions reach ${OUTSIDE_PR_DIFF_LINES.toLocaleString('en-US')} lines or its changedFiles reach ${OUTSIDE_PR_DIFF_FILES} — either leg alone is enough, since a many-file change of small edits is as hard to review as a single huge file. The whole field is null when the row carries no parseable diff record (pre-fields rows, malformed records), which is missing evidence and never counts; the cell emits only when oversized merges are at least half of the diff-evidenced merges, so a few large changes among many small ones never reads as a repo pattern. ${tallyText(cell)}${seenText(cell)}${sizeText(cell)}${authorsText(cell)}${agentsText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrDiffItem(
  cell: OutsidePrDiffBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): CloudBacklogItem {
  const title = `Outside merges on ${cell.repo} keep landing oversized diffs`;
  const id = `outside-pr-diff-${createHash('sha256').update(`outside-pr-diff:${cell.repo}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrDiffPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

export interface OutsidePrDiffBacklogOptions {
  /** Runs dir holding metrics/outside-pr-outcomes.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default OUTSIDE_PR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default OUTSIDE_PR_DIFF_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for repos whose outside merges keep landing oversized
 * diffs. Total: a missing journal, an unreadable journal, or any read
 * or fold failure yields no items rather than throwing into discovery.
 * Unlike the sibling machinery feeds there is no fleet-repo gate —
 * each cell self-targets the repository its outside PRs landed on.
 */
export async function outsidePrDiffBacklogItems(opts: OutsidePrDiffBacklogOptions = {}): Promise<CloudBacklogItem[]> {
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
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_DIFF_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrDiffCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_DIFF_MAX_ITEMS, OUTSIDE_PR_DIFF_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrDiffItem(cell, windowHours, partial, parsed.scan));
  } catch {
    return [];
  }
}
