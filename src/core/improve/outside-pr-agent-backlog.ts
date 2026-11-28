/**
 * Outside-PR agent-attribution outcomes → self-improvement backlog items.
 *
 * Sibling of outside-pr-backlog.ts on the same journal: that feed folds
 * metrics/outside-pr-outcomes.jsonl per repository, so a repo needs
 * OUTSIDE_PR_REVERTED_RECURRING reverted outside merges on itself before
 * it becomes work. The journal's rows also carry `agent` — the product
 * the recorded branch/login convention attributes the change to
 * (outsidePrAgentAttribution in src/core/fleet/outside-pr-outcomes.ts) —
 * and an agent product's merges can recurently revert while spread thin
 * enough across repos that no single repo cell ever reaches the bar:
 * two reverts on acme/a and two on acme/b is an agent-level pattern no
 * per-repo fold can see. This feed folds the same rows per attributed
 * agent instead, so `phm improve discover` queues the fleet-side
 * question — intake guidance, attribution conventions, agent-shaped PR
 * handling — that the per-repo items cannot ask.
 *
 * Items emit only for the fleet's own repository: the per-repo sibling
 * already owns "the fix lives where the merges land", while an
 * agent-level pattern names no single outside repo — the work it can
 * name lives in this repository's contributor guidance
 * (CONTRIBUTING.md, docs/CONTRIBUTE-WITH-AN-AGENT.md) and fleet intake
 * machinery, the same gate every other machinery feed applies.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling feeds use)
 *    and parsed by parseOutsidePrOutcomeJournal; nothing is written and
 *    no network is touched. A missing journal folds as empty — no sync
 *    has recorded outcomes yet, a clean empty source, not a guess; an
 *    unreadable or non-file journal yields no items.
 *  - Attributed only. Rows whose agent is null — no known branch/login
 *    convention matched — belong to no agent cell: 'unattributed' names
 *    no product to investigate, and the per-repo sibling already owns
 *    those rows' actionable signal. The unattributed share stays
 *    context inside the sibling's prompts, never evidence here.
 *  - 'unknown' never counts. A revert verdict is 'yes' only when the
 *    standing revert ledger positively matched the PR; an unreadable
 *    revert ledger marks every verdict 'unknown' and those rows are
 *    context, never evidence toward the recurring bar.
 *  - Recurring means recorded. An agent cell emits only at
 *    OUTSIDE_PR_REVERTED_RECURRING reverted merges inside the window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply
 *    to their own tallies — so one reverted PR never queues a session.
 *    Merges whose verdict is 'no' are quoted as the denominator: the
 *    signal is the revert rate among that agent's outside merges, not
 *    the raw count.
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
 *    whether the reverts concentrate on one repository (where the
 *    sibling per-repo item may already own the cause) or disperse
 *    across the fleet's repos (the agent-level pattern this feed
 *    exists for); the prompt states both readings and keeps the
 *    no-change escape.
 *  - Review, latency and size evidence is evidence, not blame. The
 *    same journaled createdAt/reviews/diff tallies the sibling quotes
 *    are folded over this agent's reverted merges only, with stated
 *    denominators; pre-fields rows count in no denominator and unknown
 *    coverage is quoted as unknown, never 0.
 *  - Dedup is downstream. The item id embeds a stable hash of the agent
 *    slug (never the counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; an agent
 *    that stops producing reverted merges simply stops re-adding.
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
  OUTSIDE_PR_REVERTED_RECURRING,
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

/** Agent cells one call may emit; the attribution table bounds the slug space. */
export const OUTSIDE_PR_AGENT_MAX_ITEMS = 8;
const OUTSIDE_PR_AGENT_ITEM_HARD_MAX = 16;
/**
 * Future-skew ceiling on mergedAt stamps, the sibling feeds' one-minute
 * tolerance for clock drift between the recording host and the merge
 * timestamp's source: a merge stamped further ahead than the evaluation
 * time is corrupt or replayed evidence and never reaches a cell.
 */
export const OUTSIDE_PR_AGENT_FUTURE_SKEW_MS = 60_000;
/** Journal tail cap — the same 8 MiB bound the sync's dedup read applies. */
const OUTSIDE_PR_AGENT_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
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
/** Repositories quoted per cell inside one prompt. */
const MAX_REPOS = 5;

const FLEET_REPO_NAME = 'phantom';

function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** One attributed agent's in-window outside-merge cell: recorded verdict tallies plus quoted evidence. */
export interface OutsidePrAgentBacklogCell {
  /** The journaled agent-attribution slug (never null — unattributed rows form no cell). */
  agent: string;
  /** This agent's outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges carrying a standing revert verdict. */
  reverted: number;
  /** Merges whose revert verdict the ledger could not support. */
  unknown: number;
  /** Merges standing without a revert verdict. */
  kept: number;
  /**
   * The repositories this agent's merges landed on inside the window,
   * most reverted first — the cross-repo spread that distinguishes an
   * agent-level pattern from a single repo's gate problem (which the
   * per-repo sibling item already owns).
   */
  repos: Array<{ repo: string; merged: number; reverted: number }>;
  /** Distinct repositories this agent's reverted merges landed on. */
  repos_reverted: number;
  /** Reverted merges by gh author login (null = ghost author), most reverted first. */
  authors: Array<{ author: string | null; reverted: number }>;
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
  /** Up to MAX_EXAMPLES reverted merges, most recent merge first; repo is quoted since cells span repos. */
  examples: Array<{ repo: string; number: number; title: string; author: string | null; mergedAt: string }>;
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
 * Pure: fold the journal's newest-per-PR outcome rows into per-agent
 * cells. Only merges inside the window count — before its start or past
 * the evaluation time plus the sibling feeds' future skew, which is
 * corrupt evidence that never reaches a cell; cells below the
 * recurring bar are dropped here so callers see only emittable
 * evidence. `unknown` verdicts tally as context and never toward the
 * bar, and rows the attribution convention left null form no cell.
 */
export function foldOutsidePrAgentCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrAgentBacklogCell[] {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + OUTSIDE_PR_AGENT_FUTURE_SKEW_MS;
  const byAgent = new Map<string, OutsidePrOutcomeJournalRow[]>();
  for (const row of rows) {
    if (row.agent === null) continue;
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const list = byAgent.get(row.agent) ?? [];
    list.push(row);
    byAgent.set(row.agent, list);
  }
  const cells: OutsidePrAgentBacklogCell[] = [];
  for (const [agent, agentRows] of byAgent) {
    let reverted = 0;
    let unknown = 0;
    let kept = 0;
    const authorCounts = new Map<string | null, number>();
    const repoCounts = new Map<string, { merged: number; reverted: number }>();
    const revertedRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of agentRows) {
      const repoCell = repoCounts.get(row.repo) ?? { merged: 0, reverted: 0 };
      repoCell.merged += 1;
      if (row.reverted === 'yes') {
        reverted += 1;
        repoCell.reverted += 1;
        revertedRows.push(row);
        authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
      } else if (row.reverted === 'unknown') unknown += 1;
      else kept += 1;
      repoCounts.set(row.repo, repoCell);
    }
    if (reverted < OUTSIDE_PR_REVERTED_RECURRING) continue;
    const times = revertedRows.map(mergedMs).filter(Number.isFinite);
    const reposReverted = new Set(revertedRows.map((row) => row.repo));
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
      agent,
      merged: agentRows.length,
      reverted,
      unknown,
      kept,
      repos: [...repoCounts.entries()]
        .map(([repo, counts]) => ({ repo, merged: counts.merged, reverted: counts.reverted }))
        .sort((a, b) => b.reverted - a.reverted || a.repo.localeCompare(b.repo))
        .slice(0, MAX_REPOS),
      repos_reverted: reposReverted.size,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, reverted: count }))
        .sort((a, b) => b.reverted - a.reverted || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      ttm_known: ttmKnown,
      ttm_minutes_mean: ttmKnown === 0 ? null : Math.round((ttmMinutes / ttmKnown) * 10) / 10,
      reviews_known: reviewsKnown,
      unreviewed,
      changes_requested: changesRequested,
      diff_known: diffKnown,
      diff_lines_mean: diffKnown === 0 ? null : Math.round((diffLines / diffKnown) * 10) / 10,
      diff_files_mean: diffKnown === 0 ? null : Math.round((diffFiles / diffKnown) * 10) / 10,
      examples: [...revertedRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          repo: row.repo,
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
        })),
      firstMerged: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastMerged: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.reverted - a.reverted || a.agent.localeCompare(b.agent));
}

const NO_CHANGE = 'If the window has rolled forward, the agent\'s outside-PR path has already changed (attribution conventions, intake guidance or merge policy), the reverts were correct verdicts on genuinely bad contributions, the pattern concentrates on one repository the sibling per-repo item already owns, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set (src/core/improve/revert-ledger.ts). `phm fleet outside-outcomes --json` prints the same live read, including the per-agent rollup.';

function seenText(cell: OutsidePrAgentBacklogCell): string {
  if (cell.firstMerged === null || cell.lastMerged === null) return '';
  return cell.firstMerged === cell.lastMerged
    ? ` Merged ${cell.firstMerged}.`
    : ` Merged ${cell.firstMerged} through ${cell.lastMerged}.`;
}

function tallyText(cell: OutsidePrAgentBacklogCell): string {
  const parts = [`${cell.merged} outside merges attributed to '${cell.agent}'`];
  if (cell.unknown > 0) parts.push(`${cell.unknown} with an 'unknown' revert verdict (the revert ledger could not be read — they never count toward the bar)`);
  if (cell.kept > 0) parts.push(`${cell.kept} standing without a revert`);
  return parts.join(', ') + '.';
}

function reposText(cell: OutsidePrAgentBacklogCell): string {
  if (cell.repos.length === 0) return '';
  const parts = cell.repos.map((r) => `${r.repo} (${r.reverted} reverted of ${r.merged})`);
  const spread = cell.repos_reverted === 1
    ? 'every reverted merge landed on that one repository'
    : `the reverted merges span ${cell.repos_reverted} repositories`;
  return ` Reverted merges by repository: ${parts.join(', ')} — ${spread}.`;
}

function authorsText(cell: OutsidePrAgentBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.reverted})`);
  return ` Reverted merges by gh author login: ${parts.join(', ')} — one agent's work is pushed under many logins, so the login alone cannot say which session produced a change.`;
}

/**
 * The review/latency evidence the journaled rows carry for the reverted
 * merges — how fast they landed and whether gh recorded any review at
 * all. Denominators are stated so "no evidence" never reads as "no
 * review"; an empty string when no reverted row carried either field.
 */
function reviewText(cell: OutsidePrAgentBacklogCell): string {
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
 * merges — how large the reverted changes were, so an agent whose
 * outside merges revert at fleet-typical size reads differently than
 * one reverting outsized diffs. The denominator is stated so "no
 * evidence" never reads as "empty diffs"; an empty string when no
 * reverted row carried the field.
 */
function diffText(cell: OutsidePrAgentBacklogCell): string {
  if (cell.diff_known === 0 || cell.diff_lines_mean === null || cell.diff_files_mean === null) return '';
  return ` Diff-size evidence (journaled gh fields — rows written before the field existed count in no denominator): ${cell.diff_known} of the reverted merges carry journaled diff size (mean ${cell.diff_lines_mean} lines changed across ${cell.diff_files_mean} files).`;
}

function examplesText(cell: OutsidePrAgentBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    return `${example.repo}#${example.number}${title}${author} (merged ${example.mergedAt})`;
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

function outsidePrAgentPrompt(
  cell: OutsidePrAgentBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const agent = fieldText(cell.agent, MAX_FIELD_CHARS);
  const lead = partial
    ? `Outside contributors' pull requests attributed to agent product '${agent}' keep being merged and then reverted — at least ${cell.reverted} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a standing revert verdict (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests attributed to agent product '${agent}' keep being merged and then reverted — ${cell.reverted} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a standing revert verdict, the self-improvement work this backlog exists for.`;
  const scope = `The reverts themselves are evidence, not the defect — what is in scope is the fleet-side question an agent-level pattern raises: whether this repository's outside-contributor guidance (CONTRIBUTING.md, docs/CONTRIBUTE-WITH-AN-AGENT.md) names the conventions '${agent}'-produced PRs keep violating, whether the recorded branch/login attribution convention in outsidePrAgentAttribution mislabels this product's work, whether the fleet's intake or merge machinery treats this agent's PR shape differently than human or fleet work, and whether the per-repository causes the sibling per-repo backlog items already own explain the pattern instead. Per-repo gate fixes belong to those items — this item owns the cross-repo, agent-attributed signal. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge joined to the standing revert set: 'yes' means a revert of that PR is standing, 'no' means none is, 'unknown' means the revert ledger could not be read when the sync ran. The 'agent' field is convention attribution only — the product whose recorded branch namespace or agent-bot login the sync matched (outsidePrAgentAttribution); rows no convention matched stay unattributed and form no agent cell, and the model is never recorded because gh records none. ${tallyText(cell)}${seenText(cell)}${reposText(cell)}${authorsText(cell)}${reviewText(cell)}${diffText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrAgentItem(
  cell: OutsidePrAgentBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
  repo: string,
): CloudBacklogItem {
  const agent = fieldText(cell.agent, MAX_FIELD_CHARS);
  const title = `Outside '${agent}'-attributed merges keep being reverted`;
  const id = `outside-pr-agent-reverts-${createHash('sha256').update(`outside-pr-agent:${cell.agent}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrAgentPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface OutsidePrAgentBacklogOptions {
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
  /** Most items one call emits (default OUTSIDE_PR_AGENT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for agent products whose outside merges keep being
 * reverted — the cross-repo signal the per-repo sibling cannot see.
 * Total: a missing journal, an unreadable journal, or any read or fold
 * failure yields no items rather than throwing into discovery, and
 * items emit only for the fleet's own repository since the agent-level
 * question — intake guidance and conventions — lives in this
 * repository's machinery, not in any single outside repo.
 */
export async function outsidePrAgentBacklogItems(opts: OutsidePrAgentBacklogOptions): Promise<CloudBacklogItem[]> {
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
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_AGENT_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrAgentCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_AGENT_MAX_ITEMS, OUTSIDE_PR_AGENT_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrAgentItem(cell, windowHours, partial, parsed.scan, repo));
  } catch {
    return [];
  }
}
