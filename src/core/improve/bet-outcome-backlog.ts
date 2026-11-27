/**
 * Bets-lane scorer-killed outcomes → self-improvement backlog items.
 *
 * The bets lane (RQ-BETS-LANE-1, src/core/metrics/bets.ts) reserves a share
 * of free fleet capacity for ambitious experiments: `phm bets launch`
 * records a hypothesis against a loop metric, `phm bets score` runs the
 * kill-fast cycle and appends each decision — kept when a bet job merged
 * and the metric moved past minDelta, killed when the lane-hour or cycle
 * budget is exhausted without attributable movement, hold otherwise — to
 * the append-only ledger at <runs>/metrics/bets.jsonl (schema
 * bets.ledger.v1). Until now the ledger's only readers were `phm bets
 * list|explain` and the bets-share file dispatchd reads: a metric whose
 * bets keep dying at the kill-fast bar was visible only to someone who
 * ran the report and read it, so the experiment machinery never learned
 * which targets do not pay.
 *
 * betOutcomeBacklogItems carries the recurring scorer-killed cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readTail's bounded no-follow
 *    tail read (8 MiB, the same cap bets-store applies) and folded by
 *    foldBets (src/core/metrics/bets.ts); nothing is written and no
 *    network is touched. A missing
 *    or unreadable ledger folds as empty — no bets were recorded, which
 *    is a clean empty source, not a guess.
 *  - Scorer verdicts only. A bet the scoring cycle killed carries a
 *    decision.reason beginning 'killed:'; `phm bets kill` records
 *    'killed by operator:' — a deliberate stop by an operator or owner,
 *    not evidence the hypothesis failed its bar, so operator kills
 *    never count toward the recurring bar (they still appear in
 *    `phm bets list`).
 *  - Recurring means recorded. A metric cell emits only at
 *    BET_OUTCOME_KILLED_RECURRING scorer-killed bets decided inside the
 *    window — the fleet's RECURRING_FAILURES convention the sibling
 *    feeds apply to their own tallies — so one unlucky experiment never
 *    queues a session. Kept decisions on the same metric are quoted as
 *    context: a metric with both keeps and kills can move, which narrows
 *    where the fix belongs.
 *  - Windowed on the decision. decidedAt is when the scorer (or
 *    operator) reached the verdict; bets still launched or holding are
 *    in-flight evidence, not outcomes, and bets whose decidedAt does
 *    not parse cannot prove they are inside the window and are skipped.
 *  - Truncation and ignored events are lower bounds. A tail-truncated
 *    read or a fold that ignored lines (orphan events from a cut
 *    launch, malformed rows) can only hide kills, never invent them,
 *    so cells emit with counts stated as recorded floors.
 *  - Fleet machinery only. The bets ledger describes this install's own
 *    experiment lane and carries no repo column, so items emit only for
 *    the fleet's own repository ('phantom' last-segment match, the same
 *    rule the sibling machinery feeds apply); self-improvement pointed
 *    at another repository inherits nothing.
 *  - The kill-fast rule working is not the defect. Kills are the
 *    designed outcome for bets that do not pay; what is in scope is the
 *    machinery that keeps aiming there — proposal generation, metric
 *    selection, scoring inputs — so prompts name those surfaces and
 *    carry the usual no-change escape.
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity (the metric key — never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; a metric that stops producing kills simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, bet ids must match the ledger's own id shape
 *    before they are quoted, hypothesis and reason text is scrubbed,
 *    flattened and capped, and the brief names the ledger, the commands
 *    and the machinery with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { foldBets, type Bet } from '../metrics/bets.js';
import { readTail } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; metric cells are bounded by metric diversity. */
export const BET_OUTCOME_MAX_ITEMS = 8;
const BET_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Scorer-killed bets one metric cell needs inside the window before it
 * counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const BET_OUTCOME_KILLED_RECURRING = 3;
/**
 * The evidence window: seven days, the same recurrence window the sibling
 * outcome feeds anchor on. Scoring cycles land on the fleet's own cadence,
 * so the window is what lets the recurring bar mean recurring.
 */
export const BET_OUTCOME_WINDOW_HOURS = 24 * 7;
/**
 * Future-skew ceiling on bet decidedAt stamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: a bet decided further
 * ahead than the evaluation time is corrupt or replayed evidence and
 * never reaches a cell.
 */
export const BET_OUTCOME_FUTURE_SKEW_MS = 60_000;
/** Ledger tail cap — mirrors the LEDGER_MAX bets-store reads through. */
const BET_OUTCOME_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: bet evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Kill-reason snippet quoted per example bet inside one prompt. */
const MAX_REASON_CHARS = 160;
/** Hypothesis snippet quoted per example bet inside one prompt. */
const MAX_HYPOTHESIS_CHARS = 120;
/** Example bets quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** `phm bets kill` prefixes every operator kill reason with this; scorer kills begin 'killed:'. */
const OPERATOR_KILL_PREFIX = 'killed by operator:';
/** The ledger's own bet-id shape (RQ-BET-<slug>); anything else is never quoted. */
const SAFE_BET_ID = /^RQ-BET-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/**
 * metrics/bets.jsonl under the runs dir — the same path betsLedgerPath
 * (src/core/metrics/bets-store.ts) computes. Inlined rather than
 * imported: this module is a Tier-1 closure root, and pulling
 * bets-store's write path into the authority import closure would grow
 * the reviewed snapshot for a one-line join.
 */
const betsLedgerPath = (runsDir: string): string => join(runsDir, 'metrics', 'bets.jsonl');

export interface BetOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/bets.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default BET_OUTCOME_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default BET_OUTCOME_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One scorer-killed bet quoted inside a cell's prompt as recorded evidence. */
export interface BetOutcomeExample {
  id: string;
  hypothesis: string;
  reason: string;
  decidedAt: string | null;
}

/** One loop-metric cell: recorded scorer-killed bets plus the kept context the prompt quotes. */
export interface BetOutcomeCell {
  /** The loop metric key the cell's bets targeted, as recorded (sanitized). */
  metric: string;
  /** Scorer-killed bets decided inside the window. */
  killed: number;
  /** Kept bets on the same metric decided inside the window — evidence the metric can move. */
  kept: number;
  /** Up to MAX_EXAMPLES scorer-killed bets, most recent decision first. */
  examples: BetOutcomeExample[];
  /** ISO bounds of the cell's scorer-killed decisions; null when none carried a timestamp. */
  firstDecided: string | null;
  lastDecided: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const decidedMs = (bet: Bet): number => (bet.decidedAt === null ? NaN : Date.parse(bet.decidedAt));

const scorerKilled = (bet: Bet): boolean =>
  bet.status === 'killed' && !(bet.reason ?? '').startsWith(OPERATOR_KILL_PREFIX);

/**
 * Pure: fold the ledger's bets into per-metric scorer-kill cells. Only
 * bets decided inside the window count — kept bets tally as context on
 * the same metric, operator kills and in-flight bets never do, and a
 * decidedAt stamp beyond the evaluation time plus the sibling feeds'
 * future skew is corrupt evidence that never reaches a cell. Cells
 * below the recurring bar are dropped here so callers see only emittable
 * evidence.
 */
export function foldBetOutcomeCells(
  bets: readonly Bet[],
  opts: { nowMs: number; windowHours: number },
): BetOutcomeCell[] {
  const sinceMs = opts.nowMs - opts.windowHours * 60 * 60 * 1000;
  const untilMs = opts.nowMs + BET_OUTCOME_FUTURE_SKEW_MS;
  const cells = new Map<string, {
    metric: string;
    killed: number;
    kept: number;
    kills: Bet[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const bet of bets) {
    if (bet.status !== 'killed' && bet.status !== 'kept') continue;
    const at = decidedMs(bet);
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    const killed = scorerKilled(bet);
    if (!killed && bet.status !== 'kept') continue;
    const metric = fieldText(bet.metric, MAX_FIELD_CHARS) || 'unknown';
    let cell = cells.get(metric);
    if (cell === undefined) {
      cell = { metric, killed: 0, kept: 0, kills: [], firstMs: null, lastMs: null };
      cells.set(metric, cell);
    }
    if (!killed) {
      cell.kept += 1;
      continue;
    }
    cell.killed += 1;
    cell.kills.push(bet);
    cell.firstMs = cell.firstMs === null ? at : Math.min(cell.firstMs, at);
    cell.lastMs = cell.lastMs === null ? at : Math.max(cell.lastMs, at);
  }
  return [...cells.values()]
    .filter((cell) => cell.killed >= BET_OUTCOME_KILLED_RECURRING)
    .sort((a, b) => b.killed - a.killed || a.metric.localeCompare(b.metric))
    .map((cell) => ({
      metric: cell.metric,
      killed: cell.killed,
      kept: cell.kept,
      examples: [...cell.kills]
        .sort((a, b) => decidedMs(b) - decidedMs(a) || a.id.localeCompare(b.id))
        .slice(0, MAX_EXAMPLES)
        .filter((bet) => SAFE_BET_ID.test(bet.id))
        .map((bet) => ({
          id: bet.id,
          hypothesis: fieldText(bet.hypothesis, MAX_HYPOTHESIS_CHARS),
          reason: fieldText(bet.reason ?? '', MAX_REASON_CHARS),
          decidedAt: bet.decidedAt,
        })),
      firstDecided: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastDecided: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }));
}

const NO_CHANGE = 'If the window has rolled forward, the proposal mix has already changed, the kills were correct verdicts on genuinely weak bets, or the cause is owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the ledger path and commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the append-only bets ledger metrics/bets.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR, schema bets.ledger.v1) folded by foldBets (src/core/metrics/bets.ts) through the bounded tail read in src/core/metrics/loop-collect.ts; `phm bets list --json` prints the same fold and `phm bets score` appends each scoring cycle\'s kept/killed/hold decision with the numbers it was made from.';

function seenText(cell: BetOutcomeCell): string {
  if (cell.firstDecided === null || cell.lastDecided === null) return '';
  return cell.firstDecided === cell.lastDecided
    ? ` Decided ${cell.firstDecided}.`
    : ` Decided ${cell.firstDecided} through ${cell.lastDecided}.`;
}

function keptText(cell: BetOutcomeCell): string {
  return cell.kept === 0
    ? ''
    : ` ${cell.kept} kept ${cell.kept === 1 ? 'bet' : 'bets'} on the same metric inside the window — the metric can move.`;
}

function examplesText(cell: BetOutcomeCell): string {
  if (cell.examples.length === 0) return '';
  const parts = cell.examples.map((example) => {
    const hypothesis = example.hypothesis === '' ? '' : ` hypothesis '${example.hypothesis}'`;
    const reason = example.reason === '' ? '' : ` — '${example.reason}'`;
    return `${example.id}${hypothesis}${reason}`;
  });
  return ` Example killed bets (most recent first): ${parts.join('; ')}.`;
}

function betOutcomePrompt(cell: BetOutcomeCell, windowHours: number, partial: boolean): string {
  const lead = partial
    ? `Phantom's bets lane keeps producing experiments that die at the kill-fast bar — at least ${cell.killed} recorded scorer-killed bets targeted the loop metric '${cell.metric}' inside the ${windowHours}-hour window (a truncated ledger read or ignored events can only hide kills, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Phantom's bets lane keeps producing experiments that die at the kill-fast bar — ${cell.killed} recorded scorer-killed bets targeted the loop metric '${cell.metric}' inside the ${windowHours}-hour window, the self-improvement work this backlog exists for.`;
  return [
    lead,
    '',
    `A bet is a launched hypothesis (\`phm bets launch\`, one launch/score/kill event per line) scored each cycle by scoreBet: kept when a bet job merged and the metric moved past its minDelta, killed when the lane-hour or cycle budget is exhausted without attributable movement, hold otherwise.${keptText(cell)}${seenText(cell)}${examplesText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The kill-fast rule working as designed is not the defect — what is in scope is the experiment machinery that keeps aiming there: whether \`phm bets propose\`/\`suggest\` and src/core/fleet/next-bets.ts keep minting hypotheses targeted at a metric that does not move (fix targeting, add diversity, or stop proposing it), whether the metric itself can move (check LOOP_METRIC_KEYS and what feeds it in src/core/metrics/loop.ts — a dead metric should stop attracting bets), or whether the kills are correct verdicts on genuinely weak bets (then the fix is proposal quality further upstream). Bets killed by an operator (a reason beginning 'killed by operator:') are deliberate stops, not scorer verdicts, and never count toward the bar. Fix the cause in this repository's bets machinery. Run the affected suite. ` + NO_CHANGE,
  ].join('\n');
}

function betOutcomeItem(cell: BetOutcomeCell, repo: string, windowHours: number, partial: boolean): CloudBacklogItem {
  const title = `Bets targeting ${cell.metric} keep dying at the kill-fast bar`;
  const id = `bet-outcome-${createHash('sha256').update(`bet-outcome:${cell.metric}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: betOutcomePrompt(cell, windowHours, partial),
    area: 'bet-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for loop metrics whose bets keep dying at the kill-fast
 * bar. Total: a missing ledger, another repository, or any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function betOutcomeBacklogItems(opts: BetOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence bets-store's readers apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : BET_OUTCOME_WINDOW_HOURS;
    const nowMs = (opts.now ?? new Date()).getTime();
    const tail = await readTail(betsLedgerPath(runsDir), BET_OUTCOME_LEDGER_MAX_BYTES);
    const fold = foldBets(tail?.text ?? null);
    const cells = foldBetOutcomeCells(fold.bets, { nowMs, windowHours });
    // A truncated tail or ignored fold events can only hide kills — the
    // counts are recorded floors, so prompts say "at least".
    const partial = tail?.truncated === true || fold.ignored > 0;
    const limit = Math.max(1, Math.min(opts.limit ?? BET_OUTCOME_MAX_ITEMS, BET_OUTCOME_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => betOutcomeItem(cell, repo, windowHours, partial));
  } catch {
    return [];
  }
}
