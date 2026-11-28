/**
 * Outside-PR CI outcomes → self-improvement backlog items.
 *
 * Sibling of outside-pr-backlog.ts on the same journal: that feed folds
 * metrics/outside-pr-outcomes.jsonl per repository for merges carrying a
 * standing revert verdict, and outside-pr-agent-backlog.ts folds the same
 * rows per attributed agent. Both key on `reverted` — but every journaled
 * row also carries `ci`, the check-rollup verdict the sync's bounded
 * per-PR `gh pr view --json statusCheckRollup` read recorded
 * (src/core/fleet/outside-pr-outcomes.ts): 'success' every recorded head
 * check passed, 'failure' at least one failed, 'pending' checks still
 * incomplete when the sync last read them, 'none' an empty rollup — no
 * checks recorded on the head at all — and null when gh returned no
 * parseable rollup. Until now the only ci reader was
 * src/core/router/community-seats.ts, an advisory section of the
 * router-weight report: a repo whose outside merges keep landing without
 * a completed green check verdict — red checks overridden, merges that
 * outran CI, or heads where no CI ever ran — never became work.
 *
 * outsidePrCiBacklogItems carries the recurring cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling feeds. Items
 * self-target: each cell's `repo` is the outside PRs' own repository
 * (validated against CLOUD_REPO_PATTERN), because the fix — required
 * checks and branch protection for non-fleet heads, merge-queue or
 * auto-merge policy, CI triggering on outside heads — lives in that
 * repo, not in the fleet's.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail read (8 MiB, the same cap the sibling feeds use)
 *    and parsed by parseOutsidePrOutcomeJournal; nothing is written and
 *    no network is touched. A missing journal folds as empty — no sync
 *    has recorded outcomes yet, a clean empty source, not a guess; an
 *    unreadable or non-file journal yields no items.
 *  - 'unknown' never counts. A null `ci` — a pre-fields row, a failed or
 *    capped rollup read — is missing evidence, never a verdict: those
 *    rows tally as context and never toward the bar. 'success' is the
 *    green verdict and likewise never counts.
 *  - Adverse means recorded. An outside merge counts toward the bar
 *    only when its newest journaled row carries 'failure', 'pending' or
 *    'none' — each a real gh rollup verdict meaning the merge landed
 *    without a completed green check. 'pending' can reflect fork-PR
 *    checks still awaiting maintainer approval, so the prompt quotes the
 *    per-class split and keeps the no-change escape; the sync rewrites
 *    a row when a later rollup read resolves the verdict, so a
 *    'pending' that went green stops counting on its own.
 *  - Recurring means recorded. A repo cell emits only at
 *    OUTSIDE_PR_CI_RECURRING adverse merges inside the window — the
 *    fleet's RECURRING_FAILURES convention the sibling feeds apply to
 *    their own tallies — so one red-check merge never queues a session.
 *    Green and unknown merges are quoted as the denominator: the signal
 *    is the share of outside merges that landed without green CI, not
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
 *  - Agent is convention-attributed. Journal rows carry the agent
 *    product the sync's recorded branch/login convention matched, or
 *    null for the unattributed bucket; prompts quote that tally over
 *    the adverse rows and never claim a model — gh records none.
 *  - Reverts are context, not the signal. An adverse row's standing
 *    revert verdict is quoted per example and tallied, since a merge
 *    that was both red-CI and reverted corroborates the pattern — but
 *    the sibling feeds own the revert signal itself.
 *  - Dedup is downstream. The item id embeds a stable hash of the repo
 *    identity (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a repo that stops producing red-check merges simply stops
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
import type { OutsidePrCiVerdict } from '../fleet/outside-pr-outcomes.js';
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

/** The sibling feeds' one-minute future-skew ceiling, under this feed's name for call-site readability. */
const OUTSIDE_PR_CI_FUTURE_SKEW_MS = OUTSIDE_PR_FUTURE_SKEW_MS;

/** Repo cells one call may emit; bounded by fleet-repo count (MAX_REPOS = 10 upstream). */
export const OUTSIDE_PR_CI_MAX_ITEMS = 6;
const OUTSIDE_PR_CI_ITEM_HARD_MAX = 12;
/**
 * Adverse-CI outside merges one repo cell needs inside the window before
 * it counts as recurring — the same bar the sibling revert feed applies
 * to its own tallies (RECURRING_FAILURES = 3).
 */
export const OUTSIDE_PR_CI_RECURRING = 3;
/** Journal tail cap — the same 8 MiB bound the sibling feeds' dedup reads apply. */
const OUTSIDE_PR_CI_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** PR-title snippet quoted per example inside one prompt. */
const MAX_TITLE_FIELD_CHARS = 120;
/** Adverse merges quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** Author tallies quoted per cell inside one prompt. */
const MAX_AUTHORS = 3;

/**
 * The adverse check-rollup verdicts: each is a real gh verdict meaning the
 * merge landed without a completed green check — 'failure' at least one
 * recorded head check failed, 'pending' checks still incomplete at the
 * sync's last read, 'none' an empty rollup (no checks recorded on the
 * head). 'success' is the green verdict and null is missing evidence;
 * neither is adverse.
 */
const ADVERSE_CI: ReadonlySet<OutsidePrCiVerdict> = new Set(['failure', 'pending', 'none']);

const isAdverseCi = (ci: OutsidePrCiVerdict | null): ci is OutsidePrCiVerdict =>
  ci !== null && ADVERSE_CI.has(ci);

/** One repo's in-window outside-merge CI cell: recorded verdict tallies plus quoted evidence. */
export interface OutsidePrCiBacklogCell {
  /** The outside PRs' own repository (owner/name as gh reported it). */
  repo: string;
  /** Outside merges inside the window (all verdicts). */
  merged: number;
  /** Merges whose newest journaled row carries an adverse CI verdict ('failure', 'pending' or 'none'). */
  adverse: number;
  /** Adverse merges whose head checks recorded at least one failure. */
  ciFailure: number;
  /** Adverse merges whose head checks were still incomplete at the sync's last read. */
  ciPending: number;
  /** Adverse merges gh returned an empty check rollup for — no checks recorded on the head. */
  ciNone: number;
  /** Merges carrying any journaled `ci` verdict — the CI-evidence denominator. */
  ciKnown: number;
  /** ciKnown merges whose recorded checks all passed. */
  ciSuccess: number;
  /** Merges with no journaled `ci` verdict (pre-fields rows, failed or capped reads) — never counted. */
  ciUnknown: number;
  /** Adverse merges now carrying a standing revert verdict — corroboration, never the signal. */
  adverseReverted: number;
  /** Adverse merges by gh author login (null = ghost author), most adverse first. */
  authors: Array<{ author: string | null; adverse: number }>;
  /** Adverse merges by journaled agent attribution (null = unattributed), most adverse first. */
  agents: Array<{ agent: string | null; adverse: number }>;
  /** Up to MAX_EXAMPLES adverse merges, most recent merge first. */
  examples: Array<{ number: number; title: string; author: string | null; mergedAt: string; ci: OutsidePrCiVerdict; reverted: OutsidePrOutcomeJournalRow['reverted'] }>;
  /** ISO bounds of the adverse merges' mergedAt; null when none carried a parseable one. */
  firstAdverse: string | null;
  lastAdverse: string | null;
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const mergedMs = (row: OutsidePrOutcomeJournalRow): number => Date.parse(row.mergedAt);

/**
 * Pure: fold the journal's newest-per-PR outcome rows into per-repo CI
 * cells. Only merges inside the window count — before its start or past
 * the evaluation time plus the sibling feeds' future skew, which is
 * corrupt evidence that never reaches a cell; cells below the recurring
 * bar are dropped here so callers see only emittable evidence. Null `ci`
 * verdicts tally as `ciUnknown` context and never toward the bar.
 */
export function foldOutsidePrCiCells(
  rows: readonly OutsidePrOutcomeJournalRow[],
  opts: { nowMs: number; windowHours: number },
): OutsidePrCiBacklogCell[] {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + OUTSIDE_PR_CI_FUTURE_SKEW_MS;
  const byRepo = new Map<string, OutsidePrOutcomeJournalRow[]>();
  for (const row of rows) {
    const mergedAtMs = mergedMs(row);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < sinceMs || mergedAtMs > untilMs) continue;
    const list = byRepo.get(row.repo) ?? [];
    list.push(row);
    byRepo.set(row.repo, list);
  }
  const cells: OutsidePrCiBacklogCell[] = [];
  for (const [repo, repoRows] of byRepo) {
    let adverse = 0;
    let ciFailure = 0;
    let ciPending = 0;
    let ciNone = 0;
    let ciKnown = 0;
    let ciSuccess = 0;
    let ciUnknown = 0;
    let adverseReverted = 0;
    const authorCounts = new Map<string | null, number>();
    const agentCounts = new Map<string | null, number>();
    const adverseRows: OutsidePrOutcomeJournalRow[] = [];
    for (const row of repoRows) {
      if (row.ci === null) ciUnknown += 1;
      else {
        ciKnown += 1;
        if (row.ci === 'success') ciSuccess += 1;
      }
      if (!isAdverseCi(row.ci)) continue;
      adverse += 1;
      adverseRows.push(row);
      if (row.ci === 'failure') ciFailure += 1;
      else if (row.ci === 'pending') ciPending += 1;
      else ciNone += 1;
      if (row.reverted === 'yes') adverseReverted += 1;
      authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
      agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
    }
    if (adverse < OUTSIDE_PR_CI_RECURRING) continue;
    const times = adverseRows.map(mergedMs).filter(Number.isFinite);
    cells.push({
      repo,
      merged: repoRows.length,
      adverse,
      ciFailure,
      ciPending,
      ciNone,
      ciKnown,
      ciSuccess,
      ciUnknown,
      adverseReverted,
      authors: [...authorCounts.entries()]
        .map(([author, count]) => ({ author, adverse: count }))
        .sort((a, b) => b.adverse - a.adverse || (a.author ?? '').localeCompare(b.author ?? ''))
        .slice(0, MAX_AUTHORS),
      agents: [...agentCounts.entries()]
        .map(([agent, count]) => ({ agent, adverse: count }))
        .sort((a, b) => b.adverse - a.adverse || (a.agent ?? '').localeCompare(b.agent ?? ''))
        .slice(0, MAX_AUTHORS),
      examples: [...adverseRows]
        .sort((a, b) => mergedMs(b) - mergedMs(a) || b.number - a.number)
        .slice(0, MAX_EXAMPLES)
        .map((row) => ({
          number: row.number,
          title: fieldText(row.title, MAX_TITLE_FIELD_CHARS),
          author: row.author === null ? null : fieldText(row.author, MAX_FIELD_CHARS),
          mergedAt: row.mergedAt,
          ci: row.ci as OutsidePrCiVerdict,
          reverted: row.reverted,
        })),
      firstAdverse: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      lastAdverse: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    });
  }
  return cells.sort((a, b) => b.adverse - a.adverse || a.repo.localeCompare(b.repo));
}

const NO_CHANGE = 'If the window has rolled forward, the repo\'s outside-PR path has already changed (required checks, branch protection, merge-queue or auto-merge policy, or CI triggering on outside heads), the merges were correct verdicts on work that legitimately bypassed CI, the pending verdicts were fork-PR checks still awaiting maintainer approval rather than merges that outran CI, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only journal metrics/outside-pr-outcomes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schemas fleet.outside-pr-outcome.v1 and fleet.outside-pr-scan.v1 in src/core/fleet/outside-pr-outcome-ledger.ts), written by syncOutsidePrOutcomes (src/core/fleet/outside-outcome-sync.ts) on the cloud scheduler\'s hourly improve tick from listOutsidePrOutcomes (src/core/fleet/outside-pr-outcomes.ts) — merged non-fleet PRs per fleet repo joined to the standing revert set, each row\'s `ci` field the bounded per-PR `gh pr view --json statusCheckRollup` verdict. `phm fleet outside-outcomes --json` prints the same live read.';

function seenText(cell: OutsidePrCiBacklogCell): string {
  if (cell.firstAdverse === null || cell.lastAdverse === null) return '';
  return cell.firstAdverse === cell.lastAdverse
    ? ` Merged ${cell.firstAdverse}.`
    : ` Merged ${cell.firstAdverse} through ${cell.lastAdverse}.`;
}

function tallyText(cell: OutsidePrCiBacklogCell): string {
  const parts = [`${cell.merged} outside merges`];
  const verdicts = [
    cell.ciSuccess > 0 ? `${cell.ciSuccess} with a green check verdict` : null,
    cell.ciUnknown > 0 ? `${cell.ciUnknown} with no journaled CI verdict (pre-fields rows or failed/capped rollup reads — they never count)` : null,
  ].filter((part): part is string => part !== null);
  if (verdicts.length > 0) parts.push(verdicts.join(', '));
  return parts.join(', ') + '.';
}

function ciClassText(cell: OutsidePrCiBacklogCell): string {
  const parts: string[] = [];
  if (cell.ciFailure > 0) parts.push(`${cell.ciFailure} landed on failed checks`);
  if (cell.ciPending > 0) parts.push(`${cell.ciPending} landed while checks were still incomplete at the sync's last read`);
  if (cell.ciNone > 0) parts.push(`${cell.ciNone} landed with an empty check rollup — no checks recorded on the head`);
  const text = parts.length === 0 ? '' : ` Adverse verdicts: ${parts.join(', ')}.`;
  // Reverts corroborate but never drive this feed — the sibling feeds own that signal.
  return cell.adverseReverted > 0 ? `${text} ${cell.adverseReverted} of the adverse merges now stand reverted.` : text;
}

function authorsText(cell: OutsidePrCiBacklogCell): string {
  if (cell.authors.length === 0) return '';
  const parts = cell.authors.map((a) => `${a.author ?? 'an unrecorded author'} (${a.adverse})`);
  return ` Adverse merges by gh author login: ${parts.join(', ')} — one login pushes work for many agents, so the login alone cannot say which produced a change.`;
}

function agentsText(cell: OutsidePrCiBacklogCell): string {
  if (cell.agents.length === 0) return '';
  const parts = cell.agents.map((a) => `${a.agent ?? 'unattributed'} (${a.adverse})`);
  return ` Adverse merges by attributed agent (the journal's recorded branch/login convention — 'unattributed' means no known convention matched, and the model is never recorded): ${parts.join(', ')}.`;
}

const CI_LABELS: Record<OutsidePrCiVerdict, string> = {
  failure: 'failed checks',
  pending: 'checks still incomplete',
  none: 'no checks recorded',
  success: 'green checks',
};

function examplesText(cell: OutsidePrCiBacklogCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const title = example.title === '' ? '' : ` '${example.title}'`;
    const author = example.author === null ? '' : ` by ${example.author}`;
    const reverted = example.reverted === 'yes' ? ', now standing reverted' : example.reverted === 'unknown' ? ', revert verdict unknown' : '';
    return `#${example.number}${title}${author} (merged ${example.mergedAt}, ${CI_LABELS[example.ci]}${reverted})`;
  });
  return ` Example adverse merges (most recent first): ${parts.join('; ')}.`;
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

function outsidePrCiPrompt(
  cell: OutsidePrCiBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): string {
  const lead = partial
    ? `Outside contributors' pull requests on ${cell.repo} keep being merged without a completed green CI verdict — at least ${cell.adverse} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a journaled 'failure', 'pending' or 'none' check-rollup verdict (a truncated journal read or ignored rows can only hide merges, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Outside contributors' pull requests on ${cell.repo} keep being merged without a completed green CI verdict — ${cell.adverse} of the recorded ${cell.merged} outside merges inside the ${windowHours}-hour window carry a journaled 'failure', 'pending' or 'none' check-rollup verdict, the self-improvement work this backlog exists for.`;
  const scope = `The merges themselves are evidence, not the defect — what is in scope is this repository's outside-PR merge path: whether required checks and branch protection treat non-fleet heads the same as fleet work, whether merge-queue or auto-merge policy lets outside PRs land before checks finish or on failed checks, whether CI workflows trigger at all on outside heads (fork pull requests can sit unapproved or unmatched by path filters, which reads as 'pending' or 'none'), and whether the fleet's own merge machinery should hold outside heads to a different verification bar. 'pending' verdicts can also be fork-PR checks legitimately awaiting maintainer approval — weigh the per-class split before changing policy. Fix the cause in ${cell.repo}. Run the affected suite. ` + NO_CHANGE;
  const lines = [lead, '',
    `An "outside" PR is a merged pull request whose head is not a fleet 'codex-bridge/*' branch and whose author is not the fleet App — community work the fleet's own ledgers never record. Each journaled row is one such merge; its 'ci' field is gh's check-rollup verdict on the merge's head, read by a bounded per-PR 'gh pr view --json statusCheckRollup' pass after merge: 'success' every recorded check passed, 'failure' at least one failed, 'pending' checks still incomplete when the sync last read them (the sync rewrites the row if a later read resolves the verdict), 'none' an empty rollup — no checks recorded on the head — and null when gh returned no parseable rollup, which is missing evidence and never counts. ${tallyText(cell)}${seenText(cell)}${ciClassText(cell)}${authorsText(cell)}${agentsText(cell)}${examplesText(cell)}`,
    '', EVIDENCE, '', scope];
  const coverage = coverageText(scan);
  if (coverage.length > 0) lines.push('', ...coverage);
  if (partial) lines.push('', 'The journal tail was truncated or carried ignored lines, so every count above is a recorded floor, not a total.');
  return lines.join('\n');
}

function outsidePrCiItem(
  cell: OutsidePrCiBacklogCell,
  windowHours: number,
  partial: boolean,
  scan: OutsidePrScanJournalRow | null,
): CloudBacklogItem {
  const title = `Outside merges on ${cell.repo} keep landing without green CI`;
  const id = `outside-pr-ci-${createHash('sha256').update(`outside-pr-ci:${cell.repo}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: outsidePrCiPrompt(cell, windowHours, partial, scan),
    area: 'outside-prs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

export interface OutsidePrCiBacklogOptions {
  /** Runs dir holding metrics/outside-pr-outcomes.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal path override; default <runsDir>/metrics/outside-pr-outcomes.jsonl. */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default OUTSIDE_PR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default OUTSIDE_PR_CI_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for repos whose outside merges keep landing without a
 * completed green CI verdict. Total: a missing journal, an unreadable
 * journal, or any read or fold failure yields no items rather than
 * throwing into discovery. Unlike the sibling machinery feeds there is
 * no fleet-repo gate — each cell self-targets the repository its outside
 * PRs landed on.
 */
export async function outsidePrCiBacklogItems(opts: OutsidePrCiBacklogOptions = {}): Promise<CloudBacklogItem[]> {
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
    const tail = await readLedgerTail(journalPath, OUTSIDE_PR_CI_JOURNAL_MAX_BYTES);
    if (tail.state !== 'read' && tail.state !== 'missing') return [];
    const parsed: OutsidePrJournalParse = tail.state === 'read'
      ? parseOutsidePrOutcomeJournal(tail.text, nowMs)
      : { verdicts: new Map(), outcomes: [], scan: null, ignored: 0 };
    const cells = foldOutsidePrCiCells(parsed.outcomes, { nowMs, windowHours });
    // A truncated tail or ignored journal lines can only hide merges —
    // the counts are recorded floors, so prompts say "at least".
    const partial = tail.state === 'read' && (tail.truncated || parsed.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? OUTSIDE_PR_CI_MAX_ITEMS, OUTSIDE_PR_CI_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outsidePrCiItem(cell, windowHours, partial, parsed.scan));
  } catch {
    return [];
  }
}
