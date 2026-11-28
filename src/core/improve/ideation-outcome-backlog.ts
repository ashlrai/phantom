/**
 * Ideation-loop proposal outcomes → self-improvement backlog items.
 *
 * The ideation loop (RQ-IDEA-*, src/core/research/ideation.ts,
 * src/core/research/ideation-loop.ts) runs a daily tick: `phm fleet
 * ideation tick` asks a frontier model for up to 20 ranked proposals,
 * `planIdeation` selects at most three and writes them as `- READY
 * RQ-IDEA-*` lines into the research queue, and the fleet dispatches them
 * like any other job. `ideationQuality` already folds metrics/jobs.jsonl
 * into per-proposal merged/died/unresolved states and feeds that quality
 * block back into the next day's prompt — the loop self-corrects at the
 * prompt level, but until now its adverse outcomes never reached the
 * self-improvement backlog: a proposal mix that keeps dying unmerged was
 * visible only inside the ideation prompt itself, never as work.
 *
 * ideationOutcomeBacklogItems carries the recurring died-dominant outcome
 * cell into discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue it exactly like the sibling
 * fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail (the ROUTER_OUTCOME_LEDGER_LIMIT window every
 *    sibling jobs-ledger feed applies) and folded by foldJobsLedger —
 *    the same fold ideationQuality uses, so the backlog and the prompt
 *    agree on what merged, died and stayed unresolved. Nothing is
 *    written and no network is touched. A missing or unreadable ledger
 *    folds as empty — no recorded outcomes is a clean empty source, not
 *    a guess.
 *  - The loop's own verdicts only. A proposal counts merged when any of
 *    its in-window outcome rows is MERGED, died when every in-window
 *    outcome state is a terminal non-merge (CLOSED, DEAD, DIED,
 *    ABANDONED, CANCELLED — the same dead set ideationQuality applies),
 *    and unresolved otherwise. Unresolved is in-flight evidence, never
 *    failure — the ideation prompt says so and this feed keeps it out
 *    of both bars.
 *  - Recurring and adverse. The cell emits only when died proposals
 *    reach IDEATION_OUTCOME_DIED_RECURRING inside the window AND
 *    outnumber merged ones — the fleet's recurring-failures convention
 *    applied to a rate signal, so three deaths inside a healthy merge
 *    stream never queue a session. Kept context (merged and unresolved
 *    counts, per-repo tallies where the ledger records a repo) is
 *    quoted so the session can see whether the mix can move at all.
 *  - Windowed on the outcome. atMs is the outcome row's own timestamp
 *    (mergedAt preferred, closedAt for CLOSED); rows without one, or
 *    stamped past the evaluation time plus the sibling feeds' one-minute
 *    future skew, are corrupt or replayed evidence and never reach a
 *    cell.
 *  - Truncation and ignored rows are lower bounds. A tail-truncated
 *    read or a fold that ignored lines can only hide outcomes, never
 *    invent them, so counts are stated as recorded floors.
 *  - Fleet machinery only. The ideation loop is this install's own
 *    research machinery — its prompt, ranking and admission live in
 *    this repository regardless of which fleet repo a proposal targets
 *    — so items emit only for the fleet's own repository ('phantom'
 *    last-segment match, the same rule the sibling machinery feeds
 *    apply); self-improvement pointed at another repository inherits
 *    nothing.
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity (the single outcome cell — never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a mix that stops
 *    producing deaths simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, proposal ids must match the ledger schema's own
 *    RQ-IDEA shape before they are quoted, and the brief names the
 *    ledger, the fold, the machinery and the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { foldJobsLedger, type OutcomeRow } from '../fleet/eval-report.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Died proposals one window needs before the cell counts as recurring — the fleet's RECURRING_FAILURES convention. */
export const IDEATION_OUTCOME_DIED_RECURRING = 3;
/**
 * The evidence window: seven days, the same recurrence window the sibling
 * outcome feeds anchor on. The ideation tick selects at most three
 * proposals a day, so the window bounds the cell at roughly twenty-one
 * selections — enough for a rate signal without letting stale history
 * hold the item open forever.
 */
export const IDEATION_OUTCOME_WINDOW_HOURS = 24 * 7;
/**
 * Future-skew ceiling on outcome timestamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: an outcome stamped
 * further ahead than the evaluation time is corrupt or replayed evidence
 * and never reaches a cell.
 */
export const IDEATION_OUTCOME_FUTURE_SKEW_MS = 60_000;
/** Items one call may emit; the cell is a single fleet-wide tally. */
export const IDEATION_OUTCOME_MAX_ITEMS = 4;
const IDEATION_OUTCOME_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: ideation evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** The proposal-id shape the ideation schema enforces (src/core/research/ideation.ts); anything else is never quoted. */
const SAFE_IDEA_ID = /^RQ-IDEA-[A-Z0-9][A-Z0-9-]{0,60}$/;
/** Terminal non-merge outcome states — the same dead set ideationQuality applies. */
const DIED_STATES = new Set(['CLOSED', 'DEAD', 'DIED', 'ABANDONED', 'CANCELLED']);
/** Example proposals quoted per prompt, most recent outcome first. */
const MAX_EXAMPLES = 5;
/** Ledger-recorded repo labels are unbounded; flatten, scrub and cap before use. */
const MAX_REPO_CHARS = 80;

export interface IdeationOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default IDEATION_OUTCOME_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default IDEATION_OUTCOME_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One proposal's recorded outcome inside the window, classified by the loop's own rules. */
export type IdeationProposalState = 'merged' | 'died' | 'unresolved';

/** One ideation proposal quoted inside the prompt as recorded evidence. */
export interface IdeationOutcomeExample {
  id: string;
  state: IdeationProposalState;
  repo: string | null;
  at: string | null;
}

/** Per-repo tally of classified proposals, quoted as context. */
export interface IdeationOutcomeRepoTally {
  repo: string;
  merged: number;
  died: number;
  unresolved: number;
}

/** The single outcome cell: windowed proposal verdicts plus the context the prompt quotes. */
export interface IdeationOutcomeCell {
  /** Proposals with a MERGED outcome inside the window. */
  merged: number;
  /** Proposals whose every in-window outcome is a terminal non-merge. */
  died: number;
  /** Proposals with in-window outcomes that are neither merged nor all-dead — in-flight, never failure. */
  unresolved: number;
  /** ISO bounds of the died proposals' latest outcomes; null when none carried a timestamp. */
  firstDied: string | null;
  lastDied: string | null;
  /** Up to MAX_EXAMPLES proposals, died first then most recent outcome. */
  examples: IdeationOutcomeExample[];
  /** Per-repo tallies where the ledger recorded a repo; 'unknown' collects the rest. */
  byRepo: IdeationOutcomeRepoTally[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded repo labels are unbounded; scrub secrets, flatten to one line and cap. */
function repoLabel(value: string | null): string | null {
  if (value === null) return null;
  const clean = scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return clean === '' ? null : clean.slice(0, MAX_REPO_CHARS);
}

/**
 * Pure: fold outcome rows into the ideation proposal cell. Only rows
 * whose jobId carries the schema's RQ-IDEA shape and whose atMs lands
 * inside the window count; per proposal the loop's own precedence
 * applies — any MERGED outcome merges it, every-terminal-non-merge
 * outcomes kill it, anything else stays unresolved. The cell emits only
 * at the recurring-and-adverse bar so callers see only emittable
 * evidence.
 */
export function foldIdeationOutcomeCell(
  outcomes: Iterable<OutcomeRow>,
  opts: { nowMs: number; windowHours: number },
): IdeationOutcomeCell | null {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + IDEATION_OUTCOME_FUTURE_SKEW_MS;
  const proposals = new Map<string, {
    states: string[];
    latestMs: number;
    repo: string | null;
  }>();
  for (const row of outcomes) {
    if (row.jobId === null || !SAFE_IDEA_ID.test(row.jobId)) continue;
    if (row.atMs === null || row.atMs < sinceMs || row.atMs > untilMs) continue;
    let cell = proposals.get(row.jobId);
    if (cell === undefined) {
      cell = { states: [], latestMs: -Infinity, repo: repoLabel(row.repo) };
      proposals.set(row.jobId, cell);
    }
    cell.states.push(row.state);
    cell.latestMs = Math.max(cell.latestMs, row.atMs);
    if (cell.repo === null) cell.repo = repoLabel(row.repo);
  }
  const classified = [...proposals.entries()].map(([id, cell]) => {
    const state: IdeationProposalState = cell.states.includes('MERGED')
      ? 'merged'
      : cell.states.length > 0 && cell.states.every((s) => DIED_STATES.has(s))
        ? 'died'
        : 'unresolved';
    return { id, state, repo: cell.repo, atMs: cell.latestMs === -Infinity ? null : cell.latestMs };
  });
  const merged = classified.filter((p) => p.state === 'merged').length;
  const died = classified.filter((p) => p.state === 'died').length;
  const unresolved = classified.length - merged - died;
  if (died < IDEATION_OUTCOME_DIED_RECURRING || died <= merged) return null;
  const diedRows = classified.filter((p) => p.state === 'died' && p.atMs !== null);
  const firstDiedMs = diedRows.length === 0 ? null : Math.min(...diedRows.map((p) => p.atMs!));
  const lastDiedMs = diedRows.length === 0 ? null : Math.max(...diedRows.map((p) => p.atMs!));
  const byRepoMap = new Map<string, IdeationOutcomeRepoTally>();
  for (const p of classified) {
    const key = p.repo ?? 'unknown';
    const tally = byRepoMap.get(key) ?? { repo: key, merged: 0, died: 0, unresolved: 0 };
    tally[p.state] += 1;
    byRepoMap.set(key, tally);
  }
  const byRepo = [...byRepoMap.values()].sort((a, b) =>
    b.died - a.died || b.merged - a.merged || a.repo.localeCompare(b.repo));
  const examples = [...classified]
    .sort((a, b) =>
      Number(b.state === 'died') - Number(a.state === 'died')
      || (b.atMs ?? -Infinity) - (a.atMs ?? -Infinity)
      || a.id.localeCompare(b.id))
    .slice(0, MAX_EXAMPLES)
    .map((p) => ({
      id: p.id,
      state: p.state,
      repo: p.repo,
      at: p.atMs === null ? null : new Date(p.atMs).toISOString(),
    }));
  return {
    merged,
    died,
    unresolved,
    firstDied: firstDiedMs === null ? null : new Date(firstDiedMs).toISOString(),
    lastDied: lastDiedMs === null ? null : new Date(lastDiedMs).toISOString(),
    examples,
    byRepo,
  };
}

const NO_CHANGE = 'If the window has rolled forward, the proposal mix has already changed, the deaths were correct verdicts on genuinely unfit proposals, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the ledger path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only jobs ledger metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) folded by foldJobsLedger (src/core/fleet/eval-report.ts) through the bounded tail read in src/core/router/outcomes.ts — the same fold ideationQuality (src/core/research/ideation.ts) feeds back into the next ideation prompt; `phm fleet ideation-status` prints the same per-day selected/archived state and `phm fleet ideation tick|complete` run the loop.';

function seenText(cell: IdeationOutcomeCell): string {
  if (cell.firstDied === null || cell.lastDied === null) return '';
  return cell.firstDied === cell.lastDied
    ? ` Died ${cell.firstDied}.`
    : ` Died ${cell.firstDied} through ${cell.lastDied}.`;
}

function contextText(cell: IdeationOutcomeCell): string {
  const parts: string[] = [];
  if (cell.merged > 0) parts.push(`${cell.merged} merged`);
  if (cell.unresolved > 0) parts.push(`${cell.unresolved} unresolved (in-flight, not failure)`);
  if (cell.byRepo.length > 0) {
    const repos = cell.byRepo.map((t) => `${t.repo}: ${t.died} died/${t.merged} merged/${t.unresolved} unresolved`).join('; ');
    parts.push(`per-repo ${repos}`);
  }
  return parts.length === 0 ? '' : ` Context: ${parts.join('; ')}.`;
}

function examplesText(cell: IdeationOutcomeCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const repo = example.repo === null ? '' : ` repo=${example.repo}`;
    const at = example.at === null ? '' : ` at ${example.at}`;
    return `${example.id} (${example.state}${repo}${at})`;
  });
  return ` Recent proposals (died first, then most recent outcome): ${parts.join('; ')}.`;
}

function ideationOutcomePrompt(cell: IdeationOutcomeCell, windowHours: number, partial: boolean): string {
  const lead = partial
    ? `Phantom's daily ideation loop keeps producing proposals that die unmerged — at least ${cell.died} recorded RQ-IDEA proposals resolved to a terminal non-merge inside the ${windowHours}-hour window while only ${cell.merged} merged (a truncated ledger read or ignored rows can only hide outcomes, so the true counts may be higher), the self-improvement work this backlog exists for.`
    : `Phantom's daily ideation loop keeps producing proposals that die unmerged — ${cell.died} recorded RQ-IDEA proposals resolved to a terminal non-merge inside the ${windowHours}-hour window while only ${cell.merged} merged, the self-improvement work this backlog exists for.`;
  return [
    lead,
    '',
    `Each day \`phm fleet ideation tick\` asks a frontier model for up to 20 ranked proposals (src/core/research/ideation.ts), planIdeation selects at most three by leverage×visionFit after lintRestockLine admission, and they enter the research queue as \`- READY RQ-IDEA-*\` jobs dispatched like any other fleet work.${seenText(cell)}${contextText(cell)}${examplesText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The kill-fast analog working as designed is not the defect — proposals that genuinely do not fit are correctly rejected downstream. What is in scope is the machinery that keeps aiming there: whether the ideation prompt (ideationPrompt's evidence block and 'Learn from merged/died outcomes' feedback) or the leverage×visionFit ranking in planIdeation keeps selecting scopes the fleet cannot land (fix targeting, ranking weights, or the evidence sources it reads), whether restock-lint admission or the queue tier=work placement starves them of the capacity they need, or whether the deaths are correct verdicts on weak proposals (then the fix is proposal quality further upstream — the model call, the source set, or the dedupe that keeps stable ids from being re-proposed). Proposals still unresolved are in-flight, never counted as failures. Fix the cause in this repository's ideation machinery. Run the affected suite. ` + NO_CHANGE,
  ].join('\n');
}

function ideationOutcomeItem(cell: IdeationOutcomeCell, repo: string, windowHours: number, partial: boolean): CloudBacklogItem {
  const title = 'Daily ideation proposals keep dying unmerged';
  const id = `ideation-outcome-${createHash('sha256').update('ideation-outcome').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: ideationOutcomePrompt(cell, windowHours, partial),
    area: 'ideation-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the ideation loop's died-dominant proposal outcomes.
 * Total: a missing ledger, another repository, or any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function ideationOutcomeBacklogItems(opts: IdeationOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling runs-dir readers apply: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : IDEATION_OUTCOME_WINDOW_HOURS;
    const nowMs = (opts.now ?? new Date()).getTime();
    const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
    const fold = tail.state === 'read' ? foldJobsLedger(tail.text, 0, nowMs + IDEATION_OUTCOME_FUTURE_SKEW_MS) : null;
    const cell = fold === null ? null : foldIdeationOutcomeCell(fold.outcomes.values(), { nowMs, windowHours });
    if (cell === null) return [];
    // A truncated tail or ignored fold rows can only hide outcomes — the
    // counts are recorded floors, so prompts say "at least".
    const partial = (tail.state === 'read' && tail.truncated) || (fold !== null && fold.counts.ignored > 0);
    const limit = Math.max(1, Math.min(opts.limit ?? IDEATION_OUTCOME_MAX_ITEMS, IDEATION_OUTCOME_ITEM_HARD_MAX));
    return [ideationOutcomeItem(cell, repo, windowHours, partial)].slice(0, limit);
  } catch {
    return [];
  }
}
